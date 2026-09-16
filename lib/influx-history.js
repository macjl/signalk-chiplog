// Reads historical Signal K data back out of InfluxDB v1, written there by
// signalk-to-influxdb (github.com/tkurki/signalk-to-influxdb): each path is
// its own measurement, a numeric value in the "value" field, a string in
// "stringValue", a boolean in "boolValue", tagged with "context" (self) and
// "source" (which sensor/plugin published it, for a path with more than one).
// `navigation.position` is the one exception, written as `{lon, lat}` fields
// when the plugin's "separate lat/lon" option is on, else JSON in "jsonValue".

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
  fetch = globalThis.fetch
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
    const response = await fetch(url, { method: 'POST', headers, body });
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

  async function discoverEngineIds(fromMs, toMs) {
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

  // Fetches everything detection/track/observations/propulsion need for
  // [fromMs, toMs] in one round trip, so `readSelfPath` below can answer
  // synchronously and as fast as the replay loop can call it.
  async function preload(fromMs, toMs) {
    await verifyContext();
    const engineIds = await discoverEngineIds(fromMs, toMs);
    const numericPaths = [
      ...NUMERIC_PATHS,
      ...engineIds.flatMap((id) => [`propulsion.${id}.revolutions`, `propulsion.${id}.runTime`])
    ];
    const stringPaths = [...STRING_PATHS, ...engineIds.map((id) => `propulsion.${id}.state`)];

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
      series.set(
        path,
        rowsOf(results[i++]).map((row) => ({ time: row.time, value: row.value }))
      );
    }
    for (const path of stringPaths) {
      series.set(
        path,
        rowsOf(results[i++]).map((row) => ({ time: row.time, value: row.stringValue }))
      );
    }
    for (const path of BOOL_PATHS) {
      series.set(
        path,
        rowsOf(results[i++]).map((row) => ({ time: row.time, value: row.boolValue }))
      );
    }
    for (const path of MULTI_SOURCE_STRING_PATHS) {
      multiSource.set(
        path,
        rowsOf(results[i++]).map((row) => ({
          time: row.time,
          value: row.stringValue,
          source: row.source
        }))
      );
    }
    series.set(
      'navigation.position',
      rowsOf(results[i])
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
        .filter(Boolean)
    );
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
