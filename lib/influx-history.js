const { MAX_AGE_MS, UNDERWAY_STATES } = require('./detection');

// Reads historical Signal K data back out of InfluxDB v1, written there by
// signalk-to-influxdb (github.com/tkurki/signalk-to-influxdb): each path is
// its own measurement, a numeric value in the "value" field, a string in
// "stringValue", a boolean in "boolValue", tagged with "context" (self) and
// "source" (which sensor/plugin published it, for a path with more than one).
// `navigation.position` is the one exception, written as `{lon, lat}` fields
// when the plugin's "separate lat/lon" option is on, else JSON in "jsonValue".

// A remote database that is unreachable (wrong host, a firewall dropping
// packets, a VPN not connected) can otherwise hang far longer than this --
// Node's fetch has no default timeout of its own -- for an error that is no
// clearer once it finally arrives, so `query` bounds every request itself.
// Configurable (`influxQueryTimeoutSeconds`): a Raspberry Pi under load can
// need longer than the default to answer a six-hour chunk.
const DEFAULT_QUERY_TIMEOUT_SECONDS = 30;

// A resource-constrained host (a Raspberry Pi running both Signal K and
// InfluxDB) can be brought down by one query spanning weeks across every
// path at once; two hours at a time keeps each request's result small
// regardless of how long the requested range is, with a short pause between
// them so the database is never asked for the next one while still
// recovering from the last.
const CHUNK_MS = 2 * 60 * 60 * 1000;
const CHUNK_PAUSE_MS = 200;

// A query that times out is retried rather than failing the whole replay
// outright -- a Raspberry Pi sharing its InfluxDB with Signal K itself is
// often just busy for a moment, not actually unreachable.
const QUERY_MAX_RETRIES = 3;
const QUERY_RETRY_DELAY_MS = 5 * 1000;

// The motion scan asks for one mean per minute, light enough to cover a week
// per request.
const SCAN_BUCKET_MS = 60 * 1000;
const SCAN_CHUNK_MS = 7 * 24 * 60 * 60 * 1000;

const INFLUX_DEFAULTS = {
  influxProtocol: 'http',
  influxHost: '',
  influxPort: 8086,
  influxDatabase: '',
  influxUsername: '',
  influxPassword: '',
  influxQueryTimeoutSeconds: DEFAULT_QUERY_TIMEOUT_SECONDS
};

// Everything detection, track recording and observations read live (SPEC
// §4.1, §4.2, §4.5.1), grouped by which InfluxDB field carries the value.
const NUMERIC_PATHS = [
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'navigation.magneticVariation',
  'navigation.speedThroughWater',
  'navigation.log',
  'environment.wind.speedTrue',
  'environment.wind.directionTrue',
  'environment.wind.speedApparent',
  'environment.wind.angleApparent',
  'environment.depth.belowSurface',
  'environment.depth.belowTransducer',
  'environment.outside.pressure',
  'environment.outside.temperature',
  'environment.water.temperature',
  'steering.autopilot.target',
  'steering.autopilot.target.headingTrue',
  'steering.autopilot.target.headingMagnetic',
  'steering.autopilot.target.windAngleApparent',
  'steering.autopilot.target.windAngleTrue'
];
const STRING_PATHS = ['steering.autopilot.state', 'steering.autopilot.mode'];
const BOOL_PATHS = ['steering.autopilot.engaged'];
// Multi-source aware, like the server itself: signalk-autostate and a
// transponder can both publish it, and the server resolves them to whichever
// was received last -- which is what detection reads (§4.2).
const MULTI_SOURCE_STRING_PATHS = ['navigation.state'];

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '\\"')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "\\'")}'`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// The last entry at or before `atMs` in a series sorted by time, or
// `undefined` if the series has nothing yet at that point -- what
// `app.getSelfPath` would have answered live at that historical instant.
function lastAtOrBefore(series, atMs) {
  let lo = 0;
  let hi = series.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].time <= atMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result === -1 ? undefined : series[result];
}

function createInfluxHistory({
  protocol = INFLUX_DEFAULTS.influxProtocol,
  host,
  port = INFLUX_DEFAULTS.influxPort,
  database,
  username,
  password,
  selfContext,
  queryTimeoutSeconds = INFLUX_DEFAULTS.influxQueryTimeoutSeconds,
  fetch = globalThis.fetch,
  signal,
  onRetry = () => {},
  retryDelayMs = QUERY_RETRY_DELAY_MS
}) {
  const queryTimeoutMs = queryTimeoutSeconds * 1000;
  // path -> [{ time, node }], ascending by time; `node` is what readSelfPath
  // answers, built once here rather than on every read.
  const series = new Map();
  // path -> source -> [{ time, node }], for the paths below.
  const multiSource = new Map();
  let discovered = null;

  async function query(statements) {
    if (statements.length === 0) {
      return [];
    }
    const url = `${protocol}://${host}:${port}/query`;
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (username) {
      headers.authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;
    }
    const body = new URLSearchParams({
      db: database,
      epoch: 'ms',
      q: statements.join(';')
    });

    // One full round trip: the timeout signal covers reading the response
    // body too, not just getting the headers back, so a database that is slow
    // to stream a large chunk's JSON times out here just as it would waiting
    // for the connection -- both must retry the same way.
    async function attempt() {
      const timeout = AbortSignal.timeout(queryTimeoutMs);
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout
        });
      } catch (err) {
        if (signal?.aborted || err.name === 'TimeoutError') {
          throw err;
        }
        // Node's fetch wraps a connection failure (wrong host, refused,
        // certificate…) as a bare "fetch failed"; the actual reason is here.
        throw new Error(
          `Could not reach InfluxDB at ${protocol}://${host}:${port}: ${err.cause?.message ?? err.message}`,
          { cause: err }
        );
      }
      if (!response.ok) {
        throw new Error(`InfluxDB query failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    }

    let payload;
    // Each attempt gets its own full timeout budget, not a shared one left
    // over from the last -- a query that timed out once is retried outright,
    // not with less time to answer than before.
    for (let retries = 0; ; retries += 1) {
      try {
        payload = await attempt();
        onRetry(null);
        break;
      } catch (err) {
        if (signal?.aborted || err.name !== 'TimeoutError') {
          throw err;
        }
        const message = `InfluxDB at ${protocol}://${host}:${port} did not answer within ${queryTimeoutSeconds}s`;
        if (retries >= QUERY_MAX_RETRIES) {
          throw new Error(message, { cause: err });
        }
        onRetry(retries + 1, QUERY_MAX_RETRIES, message);
        await sleep(retryDelayMs);
      }
    }
    return payload.results.map((result) => {
      if (result.error) {
        throw new Error(`InfluxDB query error: ${result.error}`);
      }
      return result.series ?? [];
    });
  }

  function contextFilter() {
    return selfContext ? `"context" = ${quoteLiteral(selfContext)} AND ` : '';
  }

  function timeFilter(fromMs, toMs) {
    return `time >= ${quoteLiteral(iso(fromMs))} AND time <= ${quoteLiteral(iso(toMs))}`;
  }

  // Raw values, or with `bucketMs` the last value of each bucket -- all a
  // replay stepping at that interval could have seen of them anyway, for a
  // fraction of the rows when a sensor publishes several times a second.
  // Column names stay those of the raw fields either way.
  function selectStatement(measurement, fields, fromMs, toMs, { bucketMs, bySource } = {}) {
    const where = `WHERE ${contextFilter()}${timeFilter(fromMs, toMs)}`;
    const from = `FROM ${quoteIdentifier(measurement)}`;
    if (!bucketMs) {
      const columns = [...fields, ...(bySource ? ['source'] : [])].map(quoteIdentifier).join(', ');
      return `SELECT ${columns} ${from} ${where} ORDER BY time`;
    }
    const columns = fields
      .map((field) => `last(${quoteIdentifier(field)}) AS ${quoteIdentifier(field)}`)
      .join(', ');
    const groups = [`time(${bucketMs}ms)`, ...(bySource ? [quoteIdentifier('source')] : [])];
    return `SELECT ${columns} ${from} ${where} GROUP BY ${groups.join(', ')} fill(none)`;
  }

  // Every row of every series in a result, with the series' tags (`source`,
  // for a GROUP BY) merged in as if they were columns.
  function allRowsOf(seriesList) {
    return (seriesList ?? []).flatMap((one) =>
      (one.values ?? []).map((row) => ({
        ...one.tags,
        ...Object.fromEntries(one.columns.map((col, i) => [col, row[i]]))
      }))
    );
  }

  // The context values actually written to this database, so a context that
  // matches none of them -- this server pointed at another boat's history,
  // typically -- is a clear error instead of a query that quietly finds
  // nothing, with no way to tell why.
  async function verifyContext() {
    if (!selfContext) {
      return;
    }
    const [found] = await query([`SHOW TAG VALUES WITH KEY = ${quoteIdentifier('context')}`]);
    const contexts = new Set(allRowsOf(found).map((row) => row.value));
    if (contexts.size > 0 && !contexts.has(selfContext)) {
      throw new Error(
        `No data for context "${selfContext}" in this database. ` +
          `Found: ${[...contexts].join(', ')}. ` +
          'Set "InfluxDB vessel context" in the plugin configuration to one of these.'
      );
    }
  }

  async function discoverEngineIds() {
    const [found] = await query([`SHOW MEASUREMENTS WITH MEASUREMENT =~ /^propulsion\\./`]);
    const ids = new Set();
    for (const row of allRowsOf(found)) {
      const match = /^propulsion\.(.+)\.(revolutions|state|runTime)$/.exec(row.name ?? '');
      if (match) {
        ids.add(match[1]);
      }
    }
    return [...ids];
  }

  // Context check and engine discovery, once however many windows are loaded.
  function discover() {
    discovered ??= (async () => {
      await verifyContext();
      const engineIds = await discoverEngineIds();
      return {
        numericPaths: [
          ...NUMERIC_PATHS,
          ...engineIds.flatMap((id) => [`propulsion.${id}.revolutions`, `propulsion.${id}.runTime`])
        ],
        stringPaths: [...STRING_PATHS, ...engineIds.map((id) => `propulsion.${id}.state`)]
      };
    })();
    return discovered;
  }

  function append(list, rows) {
    for (const row of rows) {
      list.push(row);
    }
  }

  function seriesOf(path) {
    if (!series.has(path)) {
      series.set(path, []);
    }
    return series.get(path);
  }

  function positionValue(row) {
    if (typeof row.lon === 'number' && typeof row.lat === 'number') {
      return { longitude: row.lon, latitude: row.lat };
    }
    if (row.jsonValue) {
      const value = JSON.parse(row.jsonValue);
      return { longitude: value.longitude, latitude: value.latitude };
    }
    return null;
  }

  // One chunk's worth of every path, in a single round trip. A bucketed row
  // is dated at the end of its bucket, so the replay never sees a value
  // before it was actually published.
  async function fetchChunk(fromMs, toMs, { numericPaths, stringPaths }, bucketMs) {
    const shift = bucketMs ?? 0;
    const statements = [
      ...numericPaths.map((path) => selectStatement(path, ['value'], fromMs, toMs, { bucketMs })),
      ...stringPaths.map((path) =>
        selectStatement(path, ['stringValue'], fromMs, toMs, { bucketMs })
      ),
      ...BOOL_PATHS.map((path) => selectStatement(path, ['boolValue'], fromMs, toMs, { bucketMs })),
      ...MULTI_SOURCE_STRING_PATHS.map((path) =>
        selectStatement(path, ['stringValue'], fromMs, toMs, { bucketMs, bySource: true })
      ),
      selectStatement('navigation.position', ['lon', 'lat', 'jsonValue'], fromMs, toMs, {
        bucketMs
      })
    ];
    const results = await query(statements);
    let i = 0;

    const load = (path, field, convert = (row) => row[field]) => {
      const rows = [];
      for (const row of allRowsOf(results[i])) {
        const value = convert(row);
        if (value !== null && value !== undefined) {
          const time = row.time + shift;
          rows.push({ time, node: node(time, value) });
        }
      }
      i += 1;
      append(seriesOf(path), rows);
    };

    for (const path of numericPaths) {
      load(path, 'value');
    }
    for (const path of stringPaths) {
      load(path, 'stringValue');
    }
    for (const path of BOOL_PATHS) {
      load(path, 'boolValue');
    }
    for (const path of MULTI_SOURCE_STRING_PATHS) {
      if (!multiSource.has(path)) {
        multiSource.set(path, new Map());
      }
      const bySource = multiSource.get(path);
      const rows = allRowsOf(results[i++]).sort((a, b) => a.time - b.time);
      for (const row of rows) {
        if (!bySource.has(row.source)) {
          bySource.set(row.source, []);
        }
        const time = row.time + shift;
        bySource.get(row.source).push({ time, node: node(time, row.stringValue) });
      }
    }
    load('navigation.position', null, positionValue);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function checkAborted() {
    if (signal?.aborted) {
      throw new DOMException('Replay cancelled', 'AbortError');
    }
  }

  // Fetches everything detection/track/observations/propulsion need for
  // [fromMs, toMs], six hours at a time so a long range never asks the
  // database for more than that of every path in one go, so `readSelfPath`
  // below can then answer synchronously and as fast as the replay loop calls
  // it. `bucketMs`, when given, keeps only the last value of each bucket.
  // `onChunk(doneToMs, toMs)` reports progress. Adds to what is already
  // loaded; `clear()` drops it.
  async function preload(fromMs, toMs, onChunk, { bucketMs } = {}) {
    const paths = await discover();
    for (let chunkStart = fromMs; chunkStart < toMs; chunkStart += CHUNK_MS) {
      checkAborted();
      const chunkEnd = Math.min(chunkStart + CHUNK_MS, toMs);
      await fetchChunk(chunkStart, chunkEnd, paths, bucketMs);
      onChunk?.(chunkEnd, toMs);
      if (chunkEnd < toMs) {
        await sleep(CHUNK_PAUSE_MS);
      }
    }
  }

  function clear() {
    series.clear();
    multiSource.clear();
  }

  // When the vessel may have been moving within [fromMs, toMs], from a light
  // pass over the whole range: one mean speed per minute, and
  // signalk-autostate's state. Returns `[{ from, to }]` in ascending order,
  // possibly overlapping. A minute counts from `stoppedSpeed` (m/s) up, below
  // the speed detection needs to call the vessel under way, so the scan errs
  // towards replaying too much rather than missing a departure; an under-way
  // state counts until the next state, or until it would have gone stale.
  async function scanMotion(fromMs, toMs, { stoppedSpeed }, onChunk) {
    await discover();
    const intervals = [];
    const stateRows = [];

    const [seed] = await query([
      `SELECT last(${quoteIdentifier('stringValue')}) AS ${quoteIdentifier('stringValue')} ` +
        `FROM ${quoteIdentifier('navigation.state')} ` +
        `WHERE ${contextFilter()}time < ${quoteLiteral(iso(fromMs))} ` +
        `GROUP BY ${quoteIdentifier('source')}`
    ]);
    const latestSeed = new Map();
    for (const row of allRowsOf(seed)) {
      const previous = latestSeed.get(row.source);
      if (!previous || row.time >= previous.time) {
        latestSeed.set(row.source, row);
      }
    }
    stateRows.push(...latestSeed.values());

    for (let chunkStart = fromMs; chunkStart < toMs; chunkStart += SCAN_CHUNK_MS) {
      checkAborted();
      const chunkEnd = Math.min(chunkStart + SCAN_CHUNK_MS, toMs);
      const where = `WHERE ${contextFilter()}${timeFilter(chunkStart, chunkEnd)}`;
      const [speeds, states] = await query([
        `SELECT mean(${quoteIdentifier('value')}) AS ${quoteIdentifier('value')} ` +
          `FROM ${quoteIdentifier('navigation.speedOverGround')} ${where} ` +
          `GROUP BY time(${SCAN_BUCKET_MS}ms) fill(none)`,
        selectStatement('navigation.state', ['stringValue'], chunkStart, chunkEnd, {
          bucketMs: SCAN_BUCKET_MS,
          bySource: true
        })
      ]);
      for (const row of allRowsOf(speeds)) {
        if (typeof row.value === 'number' && row.value >= stoppedSpeed) {
          intervals.push({ from: row.time, to: row.time + SCAN_BUCKET_MS });
        }
      }
      stateRows.push(...allRowsOf(states));
      onChunk?.(chunkEnd, toMs);
      if (chunkEnd < toMs) {
        await sleep(CHUNK_PAUSE_MS);
      }
    }

    // Whatever the source: the server resolves navigation.state to the value
    // received last and detection follows that (§4.2), so a state holds until
    // the next one, whichever source published either.
    const states = stateRows.sort((a, b) => a.time - b.time);
    const maxAge = MAX_AGE_MS['navigation.state'];
    states.forEach((row, index) => {
      if (!UNDERWAY_STATES.has(row.stringValue)) {
        return;
      }
      const next = states[index + 1];
      const until = Math.min(next ? next.time : Infinity, row.time + SCAN_BUCKET_MS + maxAge);
      const from = Math.max(row.time, fromMs);
      if (until > from) {
        intervals.push({ from, to: until });
      }
    });

    return intervals.sort((a, b) => a.from - b.from);
  }

  function node(time, value) {
    return { value, timestamp: iso(time) };
  }

  // Matches `app.getSelfPath(path)` at that historical instant: `undefined`
  // with nothing yet, otherwise `{ value, timestamp }` -- or, for a path with
  // more than one source, also `values`/`$source` like the server itself.
  function readSelfPath(path, atMs) {
    const multi = multiSource.get(path);
    if (multi) {
      let latest = null;
      const values = {};
      for (const [source, list] of multi) {
        const found = lastAtOrBefore(list, atMs);
        if (found) {
          values[source] = found.node;
          if (!latest || found.time > latest.time) {
            latest = { ...found, source };
          }
        }
      }
      if (!latest) {
        return undefined;
      }
      return { ...latest.node, $source: latest.source, values };
    }
    return lastAtOrBefore(series.get(path) ?? [], atMs)?.node;
  }

  return { preload, clear, scanMotion, readSelfPath };
}

module.exports = { createInfluxHistory, INFLUX_DEFAULTS, CHUNK_MS, QUERY_MAX_RETRIES };
