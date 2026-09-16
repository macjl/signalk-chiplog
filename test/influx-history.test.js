const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createInfluxHistory } = require('../lib/influx-history');

const T0 = Date.parse('2026-09-13T08:00:00.000Z');
const MINUTE = 60 * 1000;

// A minimal InfluxDB v1 stand-in: answers each statement in the batch from
// `rowsByMeasurement`, keyed by measurement name, regardless of position --
// decoupled from exactly which paths the module queries and in what order.
function fakeInflux(rowsByMeasurement, { onRequest, contexts } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const q = options.body.get('q');
    requests.push({ url, options, q });
    onRequest?.(url, options);
    const statements = q.split(';');
    const results = statements.map((statement) => {
      if (/SHOW TAG VALUES/.test(statement)) {
        return !contexts || contexts.length === 0
          ? {}
          : {
              series: [
                {
                  name: 'navigation.speedOverGround',
                  columns: ['key', 'value'],
                  values: contexts.map((c) => ['context', c])
                }
              ]
            };
      }
      if (/SHOW MEASUREMENTS/.test(statement)) {
        const names = Object.keys(rowsByMeasurement).filter((name) =>
          name.startsWith('propulsion.')
        );
        return names.length === 0
          ? {}
          : {
              series: [{ name: 'measurements', columns: ['name'], values: names.map((n) => [n]) }]
            };
      }
      const match = /FROM "([^"]+)"/.exec(statement);
      const allRows = (match && rowsByMeasurement[match[1]]) ?? [];
      const range = /time >= '([^']+)' AND time <= '([^']+)'/.exec(statement);
      const [fromMs, toMs] = range
        ? [Date.parse(range[1]), Date.parse(range[2])]
        : [-Infinity, Infinity];
      const rows = allRows.filter((row) => row.time >= fromMs && row.time <= toMs);
      if (rows.length === 0) {
        return {};
      }
      const columns = Object.keys(rows[0]);
      return {
        series: [{ name: match[1], columns, values: rows.map((row) => columns.map((c) => row[c])) }]
      };
    });
    return { ok: true, status: 200, json: async () => ({ results }) };
  };
  return { fetch, requests };
}

function history(rowsByMeasurement, options = {}) {
  const { fetch, requests } = fakeInflux(rowsByMeasurement, options);
  const influx = createInfluxHistory({
    host: 'influx.example.com',
    port: 8086,
    database: 'signalk',
    selfContext: options.selfContext ?? 'vessels.self',
    fetch
  });
  return { influx, requests };
}

describe('InfluxDB history', () => {
  it('answers a numeric path as the last value at or before the instant asked', async () => {
    const { influx } = history({
      'navigation.speedOverGround': [
        { time: T0, value: 1 },
        { time: T0 + 10 * MINUTE, value: 2 },
        { time: T0 + 20 * MINUTE, value: 3 }
      ]
    });
    await influx.preload(T0, T0 + 30 * MINUTE);

    assert.equal(influx.readSelfPath('navigation.speedOverGround', T0 - 1), undefined);
    assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0), {
      value: 1,
      timestamp: new Date(T0).toISOString()
    });
    assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0 + 15 * MINUTE), {
      value: 2,
      timestamp: new Date(T0 + 10 * MINUTE).toISOString()
    });
    assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0 + 1000 * MINUTE), {
      value: 3,
      timestamp: new Date(T0 + 20 * MINUTE).toISOString()
    });
  });

  it('reads position from separate lon/lat fields when present', async () => {
    const { influx } = history({
      'navigation.position': [{ time: T0, lon: -1.1522, lat: 46.1591, jsonValue: null }]
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.deepEqual(influx.readSelfPath('navigation.position', T0), {
      value: { longitude: -1.1522, latitude: 46.1591 },
      timestamp: new Date(T0).toISOString()
    });
  });

  it('falls back to parsing jsonValue when lon/lat were not stored', async () => {
    const { influx } = history({
      'navigation.position': [
        { time: T0, jsonValue: JSON.stringify({ longitude: -1.1522, latitude: 46.1591 }) }
      ]
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.deepEqual(influx.readSelfPath('navigation.position', T0), {
      value: { longitude: -1.1522, latitude: 46.1591 },
      timestamp: new Date(T0).toISOString()
    });
  });

  it('resolves navigation.state to whichever source last changed, keeping every source', async () => {
    const { influx } = history({
      'navigation.state': [
        { time: T0, stringValue: 'motoring', source: 'ais.1' },
        { time: T0 + 5 * MINUTE, stringValue: 'sailing', source: 'signalk-autostate.1' }
      ]
    });
    await influx.preload(T0, T0 + 10 * MINUTE);

    const early = influx.readSelfPath('navigation.state', T0 + MINUTE);
    assert.equal(early.value, 'motoring');
    assert.equal(early.$source, 'ais.1');
    assert.deepEqual(Object.keys(early.values).sort(), ['ais.1']);

    const later = influx.readSelfPath('navigation.state', T0 + 6 * MINUTE);
    assert.equal(later.value, 'sailing');
    assert.equal(later.$source, 'signalk-autostate.1');
    assert.deepEqual(Object.keys(later.values).sort(), ['ais.1', 'signalk-autostate.1']);
  });

  it('discovers engine ids from measurement names and queries their paths', async () => {
    const { influx, requests } = history({
      'propulsion.port.revolutions': [{ time: T0, value: 30 }],
      'propulsion.port.state': [{ time: T0, stringValue: 'started' }]
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.deepEqual(influx.readSelfPath('propulsion.port.revolutions', T0), {
      value: 30,
      timestamp: new Date(T0).toISOString()
    });
    assert.deepEqual(influx.readSelfPath('propulsion.port.state', T0), {
      value: 'started',
      timestamp: new Date(T0).toISOString()
    });
    assert.ok(requests.some((r) => r.q.includes('propulsion.port.revolutions')));
  });

  it('filters by the self context and sends basic auth when a username is given', async () => {
    const { fetch, requests } = fakeInflux({});
    const influx = createInfluxHistory({
      host: 'h',
      port: 8086,
      database: 'signalk',
      username: 'chiplog',
      password: 'secret',
      selfContext: 'vessels.urn:mrn:imo:mmsi:123456789',
      fetch
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.ok(requests.length > 0);
    const isDiscovery = (q) => q.includes('SHOW MEASUREMENTS') || q.includes('SHOW TAG VALUES');
    const dataRequests = requests.filter((r) => !isDiscovery(r.q));
    assert.ok(dataRequests.length > 0);
    for (const { q, options } of requests) {
      if (!isDiscovery(q)) {
        assert.match(q, /"context" = 'vessels\.urn:mrn:imo:mmsi:123456789'/);
      }
      assert.equal(
        options.headers.authorization,
        `Basic ${Buffer.from('chiplog:secret').toString('base64')}`
      );
    }
  });

  it('surfaces an InfluxDB query error', async () => {
    const influx = createInfluxHistory({
      host: 'h',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ error: 'database not found: signalk' }] })
      })
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /database not found/);
  });

  it('surfaces an HTTP-level failure', async () => {
    const influx = createInfluxHistory({
      host: 'h',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      fetch: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /401/);
  });

  it('gives a clear message when the connection times out', async () => {
    const influx = createInfluxHistory({
      host: 'unreachable.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      fetch: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        throw err;
      }
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /did not answer within 20s/);
  });

  it('surfaces the real cause of a connection failure, not just "fetch failed"', async () => {
    const influx = createInfluxHistory({
      host: 'unreachable.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      }
    });

    await assert.rejects(
      influx.preload(T0, T0 + MINUTE),
      /Could not reach InfluxDB at http:\/\/unreachable\.example\.com:8086: ECONNREFUSED/
    );
  });

  it('refuses when the configured context matches none the database actually has', async () => {
    const { influx } = history(
      { 'navigation.speedOverGround': [{ time: T0, value: 1 }] },
      { selfContext: 'vessels.self', contexts: ['vessels.urn:mrn:imo:mmsi:123456789'] }
    );

    await assert.rejects(
      influx.preload(T0, T0 + MINUTE),
      /No data for context "vessels\.self".*vessels\.urn:mrn:imo:mmsi:123456789/
    );
  });

  it('proceeds when the configured context is one the database has', async () => {
    const { influx } = history(
      { 'navigation.speedOverGround': [{ time: T0, value: 1 }] },
      {
        selfContext: 'vessels.self',
        contexts: ['vessels.self', 'vessels.urn:mrn:imo:mmsi:123456789']
      }
    );

    await influx.preload(T0, T0 + MINUTE);
    assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0), {
      value: 1,
      timestamp: new Date(T0).toISOString()
    });
  });

  it('does not block on an empty database with no context tag values at all', async () => {
    const { influx } = history({}, { selfContext: 'vessels.self', contexts: [] });

    await influx.preload(T0, T0 + MINUTE);
    assert.equal(influx.readSelfPath('navigation.speedOverGround', T0), undefined);
  });

  describe('chunking a long range', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('fetches one day at a time rather than the whole range in one query', async () => {
      const { influx, requests } = history({
        'navigation.speedOverGround': [
          { time: T0, value: 1 },
          { time: T0 + DAY, value: 2 },
          { time: T0 + 2 * DAY, value: 3 }
        ]
      });

      await influx.preload(T0, T0 + 3 * DAY);

      const sog = requests.filter((r) => r.q.includes('"navigation.speedOverGround"'));
      assert.equal(sog.length, 3, 'one query per day, not one for the whole range');
    });

    it('accumulates every chunk into one continuous series', async () => {
      const { influx } = history({
        'navigation.speedOverGround': [
          { time: T0, value: 1 },
          { time: T0 + DAY, value: 2 },
          { time: T0 + 2 * DAY, value: 3 }
        ]
      });

      await influx.preload(T0, T0 + 3 * DAY);

      assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0 + 2 * DAY), {
        value: 3,
        timestamp: new Date(T0 + 2 * DAY).toISOString()
      });
      assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0), {
        value: 1,
        timestamp: new Date(T0).toISOString()
      });
    });

    it('reports progress after each chunk', async () => {
      const { influx } = history({});
      const seen = [];

      await influx.preload(T0, T0 + 3 * DAY, (doneToMs, toMs) => seen.push([doneToMs, toMs]));

      assert.deepEqual(seen, [
        [T0 + DAY, T0 + 3 * DAY],
        [T0 + 2 * DAY, T0 + 3 * DAY],
        [T0 + 3 * DAY, T0 + 3 * DAY]
      ]);
    });

    it('makes a single query for a range no longer than one day', async () => {
      const { influx, requests } = history({
        'navigation.speedOverGround': [{ time: T0, value: 1 }]
      });

      await influx.preload(T0, T0 + MINUTE);

      const sog = requests.filter((r) => r.q.includes('"navigation.speedOverGround"'));
      assert.equal(sog.length, 1);
    });
  });
});
