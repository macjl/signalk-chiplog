const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createPassageDetector, DETECTION_DEFAULTS, TICK_INTERVAL_MS } = require('../lib/detection');
const { distanceBetween } = require('../lib/places');
const { createTrackRecorder, TRACK_DEFAULTS } = require('../lib/track-recorder');

const KNOT = 1852 / 3600;
const METRES_PER_DEGREE_LAT = 111320;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse('2026-09-13T08:00:00.000Z');

const iso = (ms) => new Date(ms).toISOString();

function createVessel({ settings = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-track-'));
  const { db } = openDatabase(dataDir);
  const self = {};
  const allSettings = {
    ...DETECTION_DEFAULTS,
    ...TRACK_DEFAULTS,
    placeMatchRadius: 200,
    ...settings
  };
  let recorder = null;
  let detector = null;

  const publish = (skPath, value, now) => {
    self[skPath] = { value, timestamp: iso(now) };
  };

  const vessel = {
    db,
    now: T0,
    lat: 46.1466,
    lon: -1.1686,

    start({ detection = false } = {}) {
      const options = {
        db,
        readSelfPath: (skPath) => self[skPath],
        settings: allSettings,
        clock: () => vessel.now
      };
      recorder = createTrackRecorder(options);
      detector = detection ? createPassageDetector(options) : null;
      return vessel;
    },

    // Advance second by second at `knots`, on a heading in degrees that may be
    // a function of the elapsed second.
    run(seconds, { knots = 0, heading = 0 } = {}) {
      for (let i = 0; i < seconds; i += 1) {
        vessel.now += SECOND;
        const degrees = typeof heading === 'function' ? heading(i) : heading;
        const radians = (degrees * Math.PI) / 180;
        const metres = knots * KNOT;
        vessel.lat += (metres * Math.cos(radians)) / METRES_PER_DEGREE_LAT;
        vessel.lon +=
          (metres * Math.sin(radians)) /
          (METRES_PER_DEGREE_LAT * Math.cos((vessel.lat * Math.PI) / 180));

        publish('navigation.position', { latitude: vessel.lat, longitude: vessel.lon }, vessel.now);
        publish('navigation.speedOverGround', knots * KNOT, vessel.now);
        publish('navigation.courseOverGroundTrue', radians, vessel.now);
        recorder.sample();
        if (detector && (vessel.now - T0) % TICK_INTERVAL_MS === 0) {
          detector.tick();
        }
      }
      return vessel;
    },

    // Samples without a new position fix arriving.
    idle(seconds) {
      for (let i = 0; i < seconds; i += 1) {
        vessel.now += SECOND;
        recorder.sample();
      }
      return vessel;
    },

    openEntry(fields = {}) {
      const row = {
        state: 'active',
        start_time: iso(T0),
        created_at: iso(T0),
        updated_at: iso(T0),
        ...fields
      };
      const columns = Object.keys(row);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO log_entries (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        )
        .run(...Object.values(row));
      return Number(lastInsertRowid);
    },

    points() {
      return db.prepare('SELECT * FROM track_points ORDER BY time, id').all();
    },

    entry(id) {
      return db.prepare('SELECT * FROM log_entries WHERE id = ?').get(id);
    },

    close() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };

  return vessel;
}

function secondsAfterT0(point) {
  return (Date.parse(point.time) - T0) / SECOND;
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distanceBetween(points[i - 1], points[i]);
  }
  return total;
}

describe('track recording', () => {
  let vessel;

  afterEach(() => vessel.close());

  it('records a point per interval while under way and accumulates the distance', () => {
    vessel = createVessel().start();
    const id = vessel.openEntry();

    vessel.run(300, { knots: 6 });

    const points = vessel.points();
    assert.equal(points.length, 20, 'the first fix, then one every 15 s');
    assert.deepEqual(points.slice(0, 3).map(secondsAfterT0), [1, 16, 31]);
    assert.ok(Math.abs(points[1].sog - 6 * KNOT) < 1e-9);

    const expected = 6 * KNOT * (secondsAfterT0(points.at(-1)) - secondsAfterT0(points[0]));
    const { distance } = vessel.entry(id);
    assert.ok(Math.abs(distance - expected) / expected < 0.01, `distance ${distance} m`);
    assert.ok(Math.abs(distance - pathLength(points)) < 0.001);
  });

  it('adds no interval points while the vessel is not moving', () => {
    vessel = createVessel().start();
    vessel.openEntry();

    vessel.run(600, { knots: 0 });

    assert.equal(vessel.points().length, 1);
  });

  it('adds points through a tack, between interval points', () => {
    vessel = createVessel().start();
    vessel.openEntry();

    vessel.run(16, { knots: 6, heading: 45 });
    vessel.run(10, { knots: 6, heading: (i) => 45 + 9 * (i + 1) });

    const duringTack = vessel
      .points()
      .map(secondsAfterT0)
      .filter((second) => second > 16 && second < 31);
    assert.ok(duringTack.length >= 3, `points at ${duringTack.join(', ')} s`);
  });

  it('ignores heading swings at low speed', () => {
    vessel = createVessel().start();
    vessel.openEntry();

    vessel.run(120, { knots: 1, heading: (i) => (i * 30) % 360 });

    assert.ok(vessel.points().length <= 4, `${vessel.points().length} points`);
  });

  it('adds a point when the speed changes', () => {
    vessel = createVessel().start();
    vessel.openEntry();

    vessel.run(16, { knots: 2 }).run(5, { knots: 5 });

    const accelerating = vessel.points().find((point) => secondsAfterT0(point) === 18);
    assert.ok(accelerating, 'a point two seconds after the last one');
    assert.ok(Math.abs(accelerating.sog - 5 * KNOT) < 1e-9);
  });

  it('records nothing new while the position fix does not change', () => {
    vessel = createVessel().start();
    vessel.openEntry();

    vessel.run(1, { knots: 6 }).idle(120);

    assert.equal(vessel.points().length, 1);
  });

  it('honours the configured interval', () => {
    vessel = createVessel({ settings: { trackIntervalSeconds: 60 } }).start();
    vessel.openEntry();

    vessel.run(300, { knots: 6 });

    assert.equal(vessel.points().length, 5);
  });

  describe('attaching points to the passage they belong to', () => {
    it('holds points until a passage opens, then keeps those from its start', () => {
      vessel = createVessel().start();
      vessel.run(120, { knots: 6 });
      assert.equal(vessel.points().length, 0);

      vessel.openEntry({ start_time: iso(T0 + 60 * SECOND) });
      vessel.run(1, { knots: 6 });

      const seconds = vessel.points().map(secondsAfterT0);
      assert.deepEqual(seconds, [61, 76, 91, 106, 121]);
    });

    it('keeps at most 20 minutes of points waiting', () => {
      vessel = createVessel().start();
      vessel.run(30 * 60, { knots: 6 });

      vessel.openEntry();
      vessel.run(1, { knots: 6 });

      const earliest = Date.parse(vessel.points()[0].time);
      assert.ok(vessel.now - earliest <= 20 * MINUTE);
    });

    it('holds points while the passage is stopped and adds them once it resumes', () => {
      vessel = createVessel().start();
      const id = vessel.openEntry();
      vessel.run(60, { knots: 6 });
      const beforeStop = vessel.points().length;

      vessel.db
        .prepare('UPDATE log_entries SET stopped_since = ? WHERE id = ?')
        .run(iso(vessel.now), id);
      vessel.run(60, { knots: 6 });
      assert.equal(vessel.points().length, beforeStop);

      vessel.db.prepare('UPDATE log_entries SET stopped_since = NULL WHERE id = ?').run(id);
      vessel.run(1, { knots: 6 });

      const points = vessel.points();
      assert.equal(points.length, beforeStop + 5, 'four held during the stop, one on resuming');
      assert.ok(Math.abs(vessel.entry(id).distance - pathLength(points)) < 0.001);
    });

    it('continues the distance across a restart', () => {
      vessel = createVessel().start();
      const id = vessel.openEntry();
      vessel.run(120, { knots: 6 });

      vessel.start().run(120, { knots: 6 });

      const points = vessel.points();
      assert.equal(points.length, 16);
      assert.ok(Math.abs(vessel.entry(id).distance - pathLength(points)) < 0.001);
    });
  });

  it('starts the track where passage detection dates the departure', () => {
    vessel = createVessel().start({ detection: true });

    vessel.run(5 * 60, { knots: 0 }).run(10 * 60, { knots: 6 });

    const [entry] = vessel.db.prepare('SELECT * FROM log_entries').all();
    const points = vessel.points();
    const first = Date.parse(points[0].time);
    assert.ok(first >= Date.parse(entry.start_time), 'no point before the departure');
    assert.ok(first - Date.parse(entry.start_time) <= 15 * SECOND, 'the track starts at it');
    assert.ok(
      points.some((point) => point.time < entry.created_at),
      'points from before detection opened the entry were kept'
    );
    assert.ok(entry.distance > 0);
  });
});
