const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { runReplay } = require('../lib/replay');

const KNOT = 1852 / 3600;
const METRES_PER_DEGREE_LAT = 111320;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse('2026-09-13T08:00:00.000Z');

const iso = (ms) => new Date(ms).toISOString();

// A minimal stand-in for an InfluxDB-backed history: records values with
// their historical timestamp and answers "what was current at this instant",
// exactly what `app.getSelfPath` would have answered live at the time.
function createHistory() {
  const series = new Map();
  return {
    publish(skPath, value, atMs) {
      const list = series.get(skPath) ?? [];
      list.push({ value, timestamp: atMs });
      series.set(skPath, list);
    },
    read(skPath, atMs) {
      const list = series.get(skPath);
      if (!list) {
        return undefined;
      }
      let found;
      for (const entry of list) {
        if (entry.timestamp > atMs) {
          break;
        }
        found = entry;
      }
      return found && { value: found.value, timestamp: iso(found.timestamp) };
    }
  };
}

// A vessel steaming due north at `knots`, publishing position and speed every
// second across [fromMs, toMs) -- dense enough for the track recorder too.
function sailStraight(history, fromMs, toMs, knots) {
  let lat = 46.1466;
  const lon = -1.1686;
  for (let t = fromMs; t < toMs; t += SECOND) {
    const metres = knots * KNOT;
    lat += metres / METRES_PER_DEGREE_LAT;
    history.publish('navigation.speedOverGround', knots * KNOT, t);
    history.publish('navigation.position', { latitude: lat, longitude: lon }, t);
  }
}

function openDb() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-replay-'));
  const { db } = openDatabase(dataDir);
  return { db, dataDir };
}

describe('retrospective replay', () => {
  let db;
  let dataDir;

  afterEach(() => {
    db?.close();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reconstructs a passage from historical position and speed alone', async () => {
    ({ db, dataDir } = openDb());
    const history = createHistory();
    const from = T0;
    const to = T0 + 20 * MINUTE;
    sailStraight(history, from, to, 6);

    const result = await runReplay({
      db,
      settings: {},
      history: (skPath, atMs) => history.read(skPath, atMs),
      from: iso(from),
      to: iso(to)
    });

    assert.deepEqual(result, { from: iso(from), to: iso(to) });

    const entries = db.prepare('SELECT * FROM log_entries').all();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, 'active');
    assert.ok(Date.parse(entries[0].start_time) >= from);
    assert.ok(Date.parse(entries[0].start_time) < to);

    const points = db.prepare('SELECT * FROM track_points').all();
    assert.ok(points.length > 1, `expected track points, got ${points.length}`);
  });

  it('logs an autopilot engagement seen in history', async () => {
    ({ db, dataDir } = openDb());
    const history = createHistory();
    const from = T0;
    const to = T0 + 20 * MINUTE;
    sailStraight(history, from, to, 6);
    history.publish('steering.autopilot.state', 'auto', from + 5 * MINUTE);

    await runReplay({
      db,
      settings: {},
      history: (skPath, atMs) => history.read(skPath, atMs),
      from: iso(from),
      to: iso(to)
    });

    const events = db.prepare("SELECT * FROM events WHERE type = 'autopilot'").all();
    assert.deepEqual(
      events.map((e) => e.subtype),
      ['engaged']
    );
  });

  it('reports progress and reaches the end of the range', async () => {
    ({ db, dataDir } = openDb());
    const history = createHistory();
    const from = T0;
    const to = T0 + 5 * MINUTE;
    sailStraight(history, from, to, 6);

    const seen = [];
    await runReplay({
      db,
      settings: {},
      history: (skPath, atMs) => history.read(skPath, atMs),
      from: iso(from),
      to: iso(to),
      onProgress: (nowMs, toMs) => seen.push([nowMs, toMs])
    });

    assert.ok(seen.length >= 2);
    assert.deepEqual(seen[0], [from, to]);
    assert.deepEqual(seen.at(-1), [to, to]);
  });

  it('can be cancelled mid-flight', async () => {
    ({ db, dataDir } = openDb());
    const history = createHistory();
    const from = T0;
    const to = T0 + 60 * MINUTE;
    sailStraight(history, from, to, 6);
    const controller = new AbortController();

    const replay = runReplay({
      db,
      settings: {},
      history: (skPath, atMs) => history.read(skPath, atMs),
      from: iso(from),
      to: iso(to),
      signal: controller.signal,
      onProgress: (nowMs) => {
        if (nowMs >= from + 2 * MINUTE) {
          controller.abort();
        }
      }
    });

    await assert.rejects(replay, { name: 'AbortError' });
  });

  it('refuses an empty or reversed range', async () => {
    ({ db, dataDir } = openDb());
    await assert.rejects(
      runReplay({
        db,
        settings: {},
        history: () => undefined,
        from: iso(T0),
        to: iso(T0)
      }),
      RangeError
    );
    await assert.rejects(
      runReplay({
        db,
        settings: {},
        history: () => undefined,
        from: iso(T0 + MINUTE),
        to: iso(T0)
      }),
      RangeError
    );
  });
});
