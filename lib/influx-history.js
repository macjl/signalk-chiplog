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
const QUERY_TIMEOUT_MS = 20 * 1000;

// A resource-constrained host (a Raspberry Pi running both Signal K and
// InfluxDB) can be brought down by one query spanning weeks across every
// path at once; one day at a time keeps each request's result small
// regardless of how long the requested range is, with a short pause between
// them so the database is never asked for the next one while still
// recovering from the last.
const CHUNK_MS = 24 * 60 * 60 * 1000;
const CHUNK_PAUSE_MS = 200;

const INFLUX_DEFAULTS = {
  influxProtocol: 'http',
  influxHost: '',
  influxPort: 8086,
  influxDatabase: '',
  influxUsername: '',
  influxPassword: ''
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
// transponder can both publish it, and detection picks between them.
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
  fetch = globalThis.fetch,
  signal
}) {
  // path -> [{ time, value }], ascending by time.
  const series = new Map();
  // path -> [{ time, value, source }], ascending by time, for the ones above.
  const multiSource = new Map();

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
    const timeout = AbortSignal.timeout(QUERY_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout
      });
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (err.name === 'TimeoutError') {
        throw new Error(
          `InfluxDB at ${protocol}://${host}:${port} did not answer within ${QUERY_TIMEOUT_MS / 1000}s`,
          { cause: err }
        );
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
    const payload = await response.json();
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

  function selectStatement(measurement, fields, fromMs, toMs, extraTags = []) {
    const columns = [...fields, ...extraTags].map(quoteIdentifier).join(', ');
    return (
      `SELECT ${columns} FROM ${quoteIdentifier(measurement)} ` +
      `WHERE ${contextFilter()}${timeFilter(fromMs, toMs)} ORDER BY time`
    );
  }

  function rowsOf(seriesList) {
    const [one] = seriesList;
    if (!one) {
      return [];
    }
    return one.values.map((row) => Object.fromEntries(one.columns.map((col, i) => [col, row[i]])));
  }

  // `SHOW TAG VALUES` answers one series per measurement that has the tag,
  // not one overall -- unlike a plain SELECT, every one of them is wanted.
  function allRowsOf(seriesList) {
    return seriesList.flatMap((one) =>
      one.values.map((row) => Object.fromEntries(one.columns.map((col, i) => [col, row[i]])))
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
    const contexts = new Set(allRowsOf(found ?? []).map((row) => row.value));
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
    for (const row of rowsOf(found)) {
      const match = /^propulsion\.(.+)\.(revolutions|state|runTime)$/.exec(row.name ?? '');
      if (match) {
        ids.add(match[1]);
      }
    }
    return [...ids];
  }

  function append(map, key, rows) {
    map.set(key, [...(map.get(key) ?? []), ...rows]);
  }

  function positionRows(seriesList) {
    return rowsOf(seriesList)
      .map((row) => {
        const parsed =
          typeof row.lon === 'number' && typeof row.lat === 'number'
            ? { longitude: row.lon, latitude: row.lat }
            : row.jsonValue
              ? (() => {
                  const value = JSON.parse(row.jsonValue);
                  return { longitude: value.longitude, latitude: value.latitude };
                })()
              : null;
        return parsed && { time: row.time, value: parsed };
      })
      .filter(Boolean);
  }

  // One chunk's worth of every path, in a single round trip.
  async function fetchChunk(fromMs, toMs, numericPaths, stringPaths) {
    const statements = [
      ...numericPaths.map((path) => selectStatement(path, ['value'], fromMs, toMs)),
      ...stringPaths.map((path) => selectStatement(path, ['stringValue'], fromMs, toMs)),
      ...BOOL_PATHS.map((path) => selectStatement(path, ['boolValue'], fromMs, toMs)),
      ...MULTI_SOURCE_STRING_PATHS.map((path) =>
        selectStatement(path, ['stringValue'], fromMs, toMs, ['source'])
      ),
      selectStatement('navigation.position', ['lon', 'lat', 'jsonValue'], fromMs, toMs)
    ];
    const results = await query(statements);
    let i = 0;

    for (const path of numericPaths) {
      append(
        series,
        path,
        rowsOf(results[i++]).map((row) => ({ time: row.time, value: row.value }))
      );
    }
    for (const path of stringPaths) {
      append(
        series,
        path,
        rowsOf(results[i++]).map((row) => ({ time: row.time, value: row.stringValue }))
      );
    }
    for (const path of BOOL_PATHS) {
      append(
        series,
        path,
        rowsOf(results[i++]).map((row) => ({ time: row.time, value: row.boolValue }))
      );
    }
    for (const path of MULTI_SOURCE_STRING_PATHS) {
      append(
        multiSource,
        path,
        rowsOf(results[i++]).map((row) => ({
          time: row.time,
          value: row.stringValue,
          source: row.source
        }))
      );
    }
    append(series, 'navigation.position', positionRows(results[i]));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Fetches everything detection/track/observations/propulsion need for
  // [fromMs, toMs], one day at a time so a long range never asks the
  // database for more than a day's worth of every path in one go, so
  // `readSelfPath` below can then answer synchronously and as fast as the
  // replay loop calls it. `onChunk(doneToMs, toMs)` reports progress.
  async function preload(fromMs, toMs, onChunk) {
    await verifyContext();
    const engineIds = await discoverEngineIds();
    const numericPaths = [
      ...NUMERIC_PATHS,
      ...engineIds.flatMap((id) => [`propulsion.${id}.revolutions`, `propulsion.${id}.runTime`])
    ];
    const stringPaths = [...STRING_PATHS, ...engineIds.map((id) => `propulsion.${id}.state`)];

    for (let chunkStart = fromMs; chunkStart < toMs; chunkStart += CHUNK_MS) {
      if (signal?.aborted) {
        throw new DOMException('Replay cancelled', 'AbortError');
      }
      const chunkEnd = Math.min(chunkStart + CHUNK_MS, toMs);
      await fetchChunk(chunkStart, chunkEnd, numericPaths, stringPaths);
      onChunk?.(chunkEnd, toMs);
      if (chunkEnd < toMs) {
        await sleep(CHUNK_PAUSE_MS);
      }
    }
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
      const bySource = new Map();
      for (const entry of multi) {
        if (entry.time <= atMs) {
          bySource.set(entry.source, entry);
        }
      }
      if (bySource.size === 0) {
        return undefined;
      }
      const latest = [...bySource.values()].reduce((a, b) => (b.time > a.time ? b : a));
      const values = Object.fromEntries(
        [...bySource].map(([source, entry]) => [source, node(entry.time, entry.value)])
      );
      return { ...node(latest.time, latest.value), $source: latest.source, values };
    }
    const found = lastAtOrBefore(series.get(path) ?? [], atMs);
    return found && node(found.time, found.value);
  }

  return { preload, readSelfPath };
}

module.exports = { createInfluxHistory, INFLUX_DEFAULTS };
