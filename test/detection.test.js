const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { closeEntry } = require('../lib/entries');
const { createBoat, addPlace, iso, MINUTE, BERTH } = require('./boat');

describe('passage detection', () => {
  let boat;

  afterEach(() => boat.close());

  describe('with the speed fallback', () => {
    it('opens a passage dated and placed where the vessel left its berth', () => {
      boat = createBoat().start().sail(5, { sog: 0.1 });
      assert.equal(boat.entries().length, 0);

      const leftAt = boat.nextTick();
      const berthLat = boat.position.lat;
      boat.sail(5, { sog: 5 });

      const [entry] = boat.entries();
      assert.equal(entry.state, 'active');
      assert.equal(entry.start_time, iso(leftAt));
      assert.ok(Math.abs(entry.start_lat - berthLat) < 0.00001, 'starts at the berth');
      assert.equal(boat.detector.mode(), 'fallback');
      assert.equal(boat.detector.motion(), 'underway');
    });

    it('ignores a speed spike while swinging at anchor', () => {
      boat = createBoat()
        .start()
        .sail(30, { sog: (i) => (i % 20 === 10 ? 4 : 0.3) });
      assert.equal(boat.entries().length, 0);
    });

    it('keeps a stop shorter than the tolerance within the passage', () => {
      boat = createBoat().start().sail(20, { sog: 5 }).sail(10, { sog: 0 });
      assert.ok(boat.entries()[0].stopped_since, 'the stop is noticed');

      boat.sail(10, { sog: 5 });

      const entries = boat.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'active');
      assert.equal(entries[0].stopped_since, null);
    });

    it('ends the passage at the moment the vessel stopped once the tolerance has passed', () => {
      boat = createBoat().start().sail(20, { sog: 5 });
      const stoppedAt = boat.nextTick();
      const stopLat = boat.position.lat;

      boat.sail(40, { sog: 0 });

      const entries = boat.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'closed');
      assert.equal(entries[0].end_time, iso(stoppedAt));
      assert.ok(Math.abs(entries[0].end_lat - stopLat) < 0.0001, 'ends where it stopped');
    });

    it('honours a configured tolerance and under-way speed', () => {
      boat = createBoat({ settings: { stopClosureMinutes: 5, fallbackUnderwaySpeed: 3 } }).start();

      boat.sail(10, { sog: 2 });
      assert.equal(boat.entries().length, 0, '2 kn is below the configured 3 kn');

      boat.sail(10, { sog: 4 }).sail(8, { sog: 0 });
      assert.equal(boat.entries()[0].state, 'closed');
    });
  });

  describe('with navigation.state', () => {
    it('follows the published state and dates transitions from speed, despite its lag', () => {
      boat = createBoat().start().sail(5, { sog: 0, state: 'moored' });

      const leftAt = boat.nextTick();
      boat.sail(10, { sog: 5, state: 'moored' });
      assert.equal(boat.entries().length, 0, 'navigation.state has the final say');

      boat.sail(1, { sog: 5, state: 'sailing' });
      let [entry] = boat.entries();
      assert.equal(entry.start_time, iso(leftAt));
      assert.ok(Math.abs(entry.start_lat - BERTH.lat) < 0.0001);
      assert.equal(boat.detector.mode(), 'autostate');

      const stoppedAt = boat.nextTick();
      boat.sail(10, { sog: 0, state: 'sailing' }).sail(1, { sog: 0, state: 'moored' });
      [entry] = boat.entries();
      assert.equal(entry.stopped_since, iso(stoppedAt));
    });

    it('treats an unrecognised state as absent', () => {
      boat = createBoat().start().sail(10, { sog: 5, state: 'not defined (example)' });
      assert.equal(boat.detector.mode(), 'fallback');
      assert.equal(boat.entries().length, 1);
    });

    it('falls back to speed once navigation.state stops being refreshed', () => {
      boat = createBoat().start().sail(1, { sog: 0, state: 'moored' }).sail(25, { sog: 0 });
      assert.equal(boat.detector.mode(), 'fallback');

      boat.sail(5, { sog: 5 });
      assert.equal(boat.entries().length, 1);
    });
  });

  it('names departure and arrival after known places', () => {
    boat = createBoat();
    addPlace(boat.db, 'Les Minimes', BERTH);
    boat.start().sail(5, { sog: 0 }).sail(30, { sog: 6 });
    addPlace(boat.db, 'Île de Ré', boat.position);

    boat.sail(40, { sog: 0 });

    const [entry] = boat.entries();
    assert.equal(entry.start_place_name, 'Les Minimes');
    assert.equal(entry.end_place_name, 'Île de Ré');
    assert.ok(entry.start_place_id && entry.end_place_id);
  });

  it('keeps an arrival name set by hand before the passage closed', () => {
    boat = createBoat().start().sail(20, { sog: 5 });
    addPlace(boat.db, 'Detected', boat.position);
    boat.db.prepare("UPDATE log_entries SET end_place_name = 'Typed by crew'").run();

    boat.sail(40, { sog: 0 });

    assert.equal(boat.entries()[0].end_place_name, 'Typed by crew');
  });

  describe('across restarts', () => {
    it('ends a passage left open by a power cut at its last recorded movement', () => {
      boat = createBoat().start().sail(30, { sog: 5 });
      const { last_moving_at: lastMoving } = boat.entries()[0];

      boat.now += 2 * 24 * 60 * MINUTE;
      boat.start().sail(1, { sog: 0 });

      const entries = boat.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'closed');
      assert.equal(entries[0].end_time, lastMoving);
    });

    it('carries on with the same passage after a short restart', () => {
      boat = createBoat().start().sail(30, { sog: 5 });
      boat.now += MINUTE;
      boat.start().sail(5, { sog: 5 });

      const entries = boat.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'active');
    });

    it('splits the log when the plugin was down for longer than the tolerance mid-passage', () => {
      boat = createBoat().start().sail(30, { sog: 5 });
      const { last_moving_at: lastMoving } = boat.entries()[0];

      boat.now += 3 * 60 * MINUTE;
      boat.start().sail(5, { sog: 5 });

      const [first, second] = boat.entries();
      assert.equal(first.state, 'closed');
      assert.equal(first.end_time, lastMoving);
      assert.equal(second.state, 'active');
      assert.ok(second.start_time >= first.end_time);
    });
  });

  it('does not reopen a passage closed by hand while still moving', () => {
    boat = createBoat().start().sail(10, { sog: 5 });
    const [entry] = boat.entries();
    closeEntry(boat.db, entry.id, { now: iso(boat.now), position: null, placeMatchRadius: 200 });

    boat.sail(10, { sog: 5 });
    assert.equal(boat.entries().length, 1);

    boat.sail(5, { sog: 0 }).sail(5, { sog: 5 });
    assert.equal(boat.entries().length, 2, 'a real departure opens the next passage');
  });

  it('neither opens nor ends a passage while data is missing', () => {
    boat = createBoat().start().sail(60);
    assert.equal(boat.detector.motion(), 'unknown');
    assert.equal(boat.entries().length, 0);

    boat.sail(10, { sog: 5 }).sail(90);
    assert.equal(boat.detector.motion(), 'unknown');
    assert.equal(boat.entries()[0].state, 'active');
  });

  it('works when the system clock disagrees with Signal K timestamps', () => {
    boat = createBoat({ clockOffsetMs: -3 * 365 * 24 * 60 * MINUTE })
      .start()
      .sail(5, { sog: 0 })
      .sail(5, { sog: 5 });
    assert.equal(boat.entries().length, 1);
  });
});
