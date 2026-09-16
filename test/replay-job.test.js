const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createReplayJob } = require('../lib/replay-job');
const { insertEntry } = require('./helpers');

const T0 = Date.parse('2026-09-13T08:00:00.000Z');
const MINUTE = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function emptyInfluxFetch() {
  return async (url, options) => {
    const q = options.body.get('q');
    const statements = q.split(';');
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: statements.map(() => ({})) })
    };
  };
}

function openDb() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-replay-job-'));
  const { db } = openDatabase(dataDir);
  return { db, dataDir };
}

async function waitUntilIdle(job, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  while (job.status().running) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('replay job never finished');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('replay job', () => {
  let db;
  let dataDir;

  afterEach(() => {
    db?.close();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  const configuredSettings = () => ({
    influxProtocol: 'http',
    influxHost: 'influx.example.com',
    influxPort: 8086,
    influxDatabase: 'signalk',
    influxUsername: '',
    influxPassword: ''
  });

  it('refuses to start without an InfluxDB connection configured', () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({ db, settings: {}, app: { selfContext: 'vessels.self' } });

    assert.throws(() => job.start(iso(T0), iso(T0 + MINUTE)), /InfluxDB/);
  });

  it('refuses a range overlapping a passage already on record', () => {
    ({ db, dataDir } = openDb());
    insertEntry(db, {
      state: 'closed',
      start_time: iso(T0),
      end_time: iso(T0 + 10 * MINUTE)
    });
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    assert.throws(() => job.start(iso(T0 + 5 * MINUTE), iso(T0 + 20 * MINUTE)), /overlap/);
  });

  it('runs in the background and reports completion', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    const result = job.start(iso(T0), iso(T0 + 3 * MINUTE));
    assert.deepEqual(result, { from: iso(T0), to: iso(T0 + 3 * MINUTE) });
    assert.equal(job.status().running, true);
    assert.equal(job.status().progress.phase, 'fetching', 'starts by fetching the history');

    await waitUntilIdle(job);

    const status = job.status();
    assert.equal(status.running, false);
    assert.equal(status.progress, null);
    assert.deepEqual(status.lastResult, {
      at: status.lastResult.at,
      from: iso(T0),
      to: iso(T0 + 3 * MINUTE)
    });
    assert.equal(status.lastError, null);
  });

  it('refuses a second replay while one is already running', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    job.start(iso(T0), iso(T0 + 3 * MINUTE));
    assert.throws(() => job.start(iso(T0), iso(T0 + MINUTE)), /running/);

    await waitUntilIdle(job);
  });

  it('can be cancelled mid-flight', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    job.start(iso(T0), iso(T0 + 60 * MINUTE));
    assert.equal(job.cancel(), true);

    await waitUntilIdle(job);
    assert.equal(job.status().lastResult.cancelled, true);
    assert.equal(job.cancel(), false, 'nothing left to cancel once it has stopped');
  });

  it('surfaces an InfluxDB failure as lastError', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: async () => ({ ok: false, status: 500, text: async () => 'boom' })
    });

    job.start(iso(T0), iso(T0 + MINUTE));
    await waitUntilIdle(job);

    const status = job.status();
    assert.equal(status.running, false);
    assert.match(status.lastError.message, /500/);
  });
});
