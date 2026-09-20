const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createHistoryApiHistory } = require('../lib/history-api');
const { runReplay } = require('../lib/replay');

const T0 = Date.parse('2026-09-13T08:00:00.000Z');
const MINUTE = 60 * 1000;

function fakeProvider(records) {
  const requests = [];
  return {
    requests,
    async getPaths() {
      return Object.keys(records);
    },
    async getValues(query) {
      requests.push(query);
      if (
        query.pathSpecs.some((spec) => spec.path === 'navigation.position') &&
        query.pathSpecs.length > 1
      ) {
        throw new Error('Query result lengths do not match');
      }
      const descriptors = [];
      for (const spec of query.pathSpecs) {
        const sources = new Set(
          (records[spec.path] ?? []).map((item) => item.source ?? 'history-api')
        );
        for (const source of sources) {
          descriptors.push({ path: spec.path, method: spec.aggregate, sourceRef: source });
        }
      }
      const timestamps = new Set();
      recordsFor(query.pathSpecs, records).forEach((item) => timestamps.add(item.time));
      return {
        values: descriptors,
        data: [...timestamps]
          .sort((a, b) => a - b)
          .map((time) => [
            new Date(time).toISOString(),
            ...descriptors.map(
              (descriptor) =>
                records[descriptor.path]?.find(
                  (item) =>
                    item.time === time && (item.source ?? 'history-api') === descriptor.sourceRef
                )?.value ?? null
            )
          ])
      };
    }
  };
}

function recordsFor(specs, records) {
  return specs.flatMap((spec) => records[spec.path] ?? []);
}

describe('Signal K History API history', () => {
  it('rebuilds the propulsion branch and preserves values from the active provider', async () => {
    const provider = fakeProvider({
      'navigation.position': [{ time: T0, value: [-1.15, 46.16] }],
      'navigation.speedOverGround': [{ time: T0, value: 3 }],
      'navigation.state': [
        { time: T0, value: 'motoring', source: 'signalk-autostate.1' },
        { time: T0 + MINUTE, value: 'sailing', source: 'signalk-autostate.1' }
      ],
      'propulsion.port.revolutions': [{ time: T0, value: 21 }],
      'propulsion.port.state': [{ time: T0, value: 'started' }],
      'propulsion.port.runTime': [{ time: T0, value: 12_345 }]
    });
    const history = createHistoryApiHistory({
      getHistoryApi: async (...args) => {
        assert.deepEqual(args, []);
        return provider;
      },
      selfContext: 'vessels.self'
    });

    await history.preload(T0, T0 + 2 * MINUTE, null, { bucketMs: 15_000 });

    assert.deepEqual(history.readSelfPath('propulsion', T0), { port: {} });
    assert.deepEqual(history.readSelfPath('propulsion.port.revolutions', T0), {
      value: 21,
      timestamp: new Date(T0).toISOString()
    });
    assert.deepEqual(history.readSelfPath('navigation.position', T0), {
      value: { longitude: -1.15, latitude: 46.16 },
      timestamp: new Date(T0).toISOString()
    });
    assert.equal(history.readSelfPath('navigation.state', T0).value, 'motoring');
    assert.equal(history.readSelfPath('navigation.state', T0).$source, 'signalk-autostate.1');
    assert.equal(provider.requests[0].context, 'vessels.self');
    assert.equal(provider.requests[0].resolution, 15);
    assert.equal(provider.requests[0].sourcePolicy, undefined);
    assert.ok(
      provider.requests.every(
        (query) =>
          !query.pathSpecs.some((spec) => spec.path === 'navigation.position') ||
          query.pathSpecs.length === 1
      )
    );
  });

  it('finds moving intervals from speed and navigation.state', async () => {
    const provider = fakeProvider({
      'navigation.speedOverGround': [{ time: T0, value: 2 }],
      'navigation.state': [{ time: T0 + MINUTE, value: 'motoring' }]
    });
    const history = createHistoryApiHistory({
      getHistoryApi: async () => provider,
      selfContext: 'vessels.self'
    });

    const intervals = await history.scanMotion(T0, T0 + 2 * MINUTE, { stoppedSpeed: 1 });

    assert.ok(intervals.some((interval) => interval.from === T0 && interval.to === T0 + MINUTE));
    assert.ok(intervals.some((interval) => interval.from === T0 + MINUTE));
  });

  it('reconstructs an engine segment from historical RPMs', async () => {
    const records = {
      'navigation.position': [],
      'navigation.speedOverGround': [],
      'propulsion.port.revolutions': []
    };
    for (let time = T0; time < T0 + 20 * MINUTE; time += 15_000) {
      records['navigation.position'].push({
        time,
        value: [-1.15, 46.16 + (time - T0) / 10_000_000]
      });
      records['navigation.speedOverGround'].push({ time, value: 3 });
      records['propulsion.port.revolutions'].push({ time, value: 21 });
    }
    const provider = fakeProvider(records);
    const history = createHistoryApiHistory({
      getHistoryApi: async () => provider,
      selfContext: 'vessels.self'
    });
    await history.preload(T0, T0 + 20 * MINUTE, null, { bucketMs: 15_000 });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-history-api-'));
    const { db } = openDatabase(dataDir);
    try {
      await runReplay({
        db,
        settings: {},
        history: history.readSelfPath,
        from: new Date(T0).toISOString(),
        to: new Date(T0 + 20 * MINUTE).toISOString()
      });
      assert.equal(db.prepare('SELECT type FROM propulsion_segments').get().type, 'engine');
    } finally {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
