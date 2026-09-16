const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { planWindows, runReplay, runWindowedReplay } = require('../lib/replay');

const KNOT = 1852 / 3600;
const METRES_PER_DEGREE_LAT = 111320;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
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

// A vessel at rest, publishing position and speed every second.
function stayPut(history, fromMs, toMs) {
  for (let t = fromMs; t < toMs; t += SECOND) {
    history.publish('navigation.speedOverGround', 0, t);
    history.publish('navigation.position', { latitude: 46.1466, longitude: -1.1686 }, t);
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

  it('reconstructs the same passage when stepping at the track interval', async () => {
    ({ db, dataDir } = openDb());
    const history = createHistory();
    const from = T0;
    const to = T0 + 90 * MINUTE;
    sailStraight(history, from + 10 * MINUTE, from + 50 * MINUTE, 6);
    stayPut(history, from, from + 10 * MINUTE);
    stayPut(history, from + 50 * MINUTE, to);

    await runReplay({
      db,
      settings: { stopClosureMinutes: 15 },
      history: (skPath, atMs) => history.read(skPath, atMs),
      from: iso(from),
      to: iso(to),
      stepMs: 15 * SECOND
    });

    const entries = db.prepare('SELECT state, start_time, end_time FROM log_entries').all();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, 'closed');
    assert.ok(Math.abs(Date.parse(entries[0].start_time) - (from + 10 * MINUTE)) <= MINUTE);
    assert.ok(Math.abs(Date.parse(entries[0].end_time) - (from + 50 * MINUTE)) <= MINUTE);
  });
});

describe('replay windows', () => {
  const settings = { stopClosureMinutes: 30 };

  it('widens each stretch of motion and merges the ones that meet', () => {
    const windows = planWindows(
      [
        { from: T0 + 2 * HOUR, to: T0 + 3 * HOUR },
        { from: T0 + 4 * HOUR, to: T0 + 4 * HOUR + MINUTE },
        { from: T0 + 20 * HOUR, to: T0 + 21 * HOUR }
      ],
      settings,
      T0,
      T0 + 48 * HOUR
    );

    assert.deepEqual(windows, [
      { from: T0 + 2 * HOUR - 30 * MINUTE, to: T0 + 4 * HOUR + 56 * MINUTE },
      { from: T0 + 20 * HOUR - 30 * MINUTE, to: T0 + 21 * HOUR + 55 * MINUTE }
    ]);
  });

  it('keeps windows inside the requested range', () => {
    const windows = planWindows(
      [{ from: T0 + 10 * MINUTE, to: T0 + 11 * MINUTE }],
      settings,
      T0,
      T0 + HOUR
    );

    assert.deepEqual(windows, [{ from: T0, to: T0 + HOUR }]);
  });

  it('plans nothing when the vessel never moved', () => {
    assert.deepEqual(planWindows([], settings, T0, T0 + HOUR), []);
  });
});

describe('windowed replay', () => {
  let db;
  let dataDir;

  afterEach(() => {
    db?.close();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // What lib/influx-history.js offers, over createHistory: the motion scan
  // answers from speed alone, and every load is recorded.
  function windowedHistory(history) {
    const loads = [];
    return {
      loads,
      async scanMotion(fromMs, toMs, { stoppedSpeed }) {
        const intervals = [];
        for (let t = fromMs; t < toMs; t += MINUTE) {
          const sog = history.read('navigation.speedOverGround', t)?.value ?? 0;
          if (sog >= stoppedSpeed) {
            intervals.push({ from: t, to: t + MINUTE });
          }
        }
        return intervals;
      },
      async preload(fromMs, toMs, onChunk, { bucketMs }) {
        loads.push({ fromMs, toMs, bucketMs });
      },
      clear() {},
      readSelfPath: (skPath, atMs) => history.read(skPath, atMs)
    };
  }

  it('replays only the stretches where the vessel moved', async () => {
    ({ db, dataDir } = openDb());
    const history = createHistory();
    const from = T0;
    const to = T0 + 3 * 24 * HOUR;
    stayPut(history, from, from + 2 * HOUR);
    sailStraight(history, from + 2 * HOUR, from + 4 * HOUR, 6);
    stayPut(history, from + 4 * HOUR, from + 50 * HOUR);
    sailStraight(history, from + 50 * HOUR, from + 51 * HOUR, 6);
    stayPut(history, from + 51 * HOUR, to);
    const windowed = windowedHistory(history);
    const phases = [];
    const progress = [];

    const result = await runWindowedReplay({
      db,
      settings: {},
      history: windowed,
      from: iso(from),
      to: iso(to),
      onPhase: (phase) => phases.push(phase),
      onProgress: (nowMs) => progress.push(nowMs)
    });

    assert.equal(result.windows, 2);
    assert.deepEqual(phases, ['scanning', 'replaying']);
    assert.equal(progress.at(-1), to);
    const entries = db
      .prepare('SELECT state, start_time, end_time FROM log_entries ORDER BY start_time')
      .all();
    assert.equal(entries.length, 2);
    for (const [entry, [start, end]] of entries.map((e, i) => [
      e,
      [
        [from + 2 * HOUR, from + 4 * HOUR],
        [from + 50 * HOUR, from + 51 * HOUR]
      ][i]
    ])) {
      assert.equal(entry.state, 'closed');
      assert.ok(Math.abs(Date.parse(entry.start_time) - start) <= MINUTE, entry.start_time);
      assert.ok(Math.abs(Date.parse(entry.end_time) - end) <= MINUTE, entry.end_time);
    }
    const loaded = windowed.loads.reduce((sum, load) => sum + (load.toMs - load.fromMs), 0);
    assert.ok(loaded < 6 * HOUR, `loaded ${loaded / HOUR} h of a 72 h range`);
    assert.ok(windowed.loads.every((load) => load.bucketMs === 15 * SECOND));
  });

  it('follows a passage still open when its window ends', async () => {
    ({ db, dataDir } = openDb());
    const history = createHistory();
    const from = T0;
    const to = T0 + 24 * HOUR;
    stayPut(history, from, from + HOUR);
    sailStraight(history, from + HOUR, from + 2 * HOUR, 6);
    stayPut(history, from + 2 * HOUR, to);
    const windowed = windowedHistory(history);
    let extended = 0;
    const scan = windowed.scanMotion;
    windowed.scanMotion = async (...args) => {
      const intervals = await scan(...args);
      // Pretend the scan saw only the first ten minutes of motion.
      return intervals.filter((i) => i.from < from + HOUR + 10 * MINUTE);
    };
    const preload = windowed.preload;
    windowed.preload = async (...args) => {
      if (windowed.loads.length > 0) {
        extended += 1;
      }
      return preload(...args);
    };

    await runWindowedReplay({
      db,
      settings: {},
      history: windowed,
      from: iso(from),
      to: iso(to)
    });

    assert.ok(extended >= 1, 'loaded past the planned window');
    const entries = db.prepare('SELECT state, end_time FROM log_entries').all();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, 'closed');
    assert.ok(Math.abs(Date.parse(entries[0].end_time) - (from + 2 * HOUR)) <= MINUTE);
  });
});
