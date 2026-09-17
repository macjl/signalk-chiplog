const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { correctSegment } = require('../lib/propulsion');
const { createBoat, iso } = require('./boat');

const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;

describe('engine/sail detection', () => {
  let boat;

  afterEach(() => boat.close());

  it('logs a passage without engine data as sailing, from departure to arrival', () => {
    boat = createBoat().start().sail(5, { sog: 0 }).sail(30, { sog: 5 }).sail(40, { sog: 0 });

    const [entry] = boat.entries();
    const segments = boat.segments();
    assert.equal(entry.state, 'closed');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].type, 'sail');
    assert.equal(segments[0].start_time, entry.start_time);
    assert.equal(segments[0].end_time, entry.end_time);
    assert.equal(entry.sail_duration, seconds(entry.start_time, entry.end_time));
    assert.equal(entry.engine_duration, 0);
  });

  describe('from engine data', () => {
    it('switches between sail and engine as the revolutions say', () => {
      boat = createBoat().start().sail(5, { sog: 0, rpm: 0 }).sail(20, { sog: 5, rpm: 0 });
      const engineOn = boat.nextTick();
      boat.sail(20, { sog: 6, rpm: 2000 });
      const engineOff = boat.nextTick();
      boat.sail(20, { sog: 5, rpm: 0 }).sail(40, { sog: 0, rpm: 0 });

      const [entry] = boat.entries();
      const segments = boat.segments();
      assert.deepEqual(
        segments.map((segment) => segment.type),
        ['sail', 'engine', 'sail']
      );
      assert.equal(segments[1].start_time, iso(engineOn));
      assert.equal(segments[1].end_time, iso(engineOff));
      assert.equal(segments[0].end_time, segments[1].start_time, 'segments are contiguous');
      assert.equal(segments[1].end_time, segments[2].start_time);
      assert.ok(Math.abs(segments[1].average_rpm - 2000) < 1e-6);
      assert.equal(entry.engine_duration, 20 * 60);
      assert.equal(
        entry.engine_duration + entry.sail_duration,
        seconds(entry.start_time, entry.end_time)
      );

      const changes = boat.events().filter((event) => event.type === 'propulsion_change');
      assert.deepEqual(
        changes.map((event) => [event.time, JSON.parse(event.payload)]),
        [
          [
            segments[1].start_time,
            { segmentId: segments[1].id, before: { type: 'sail' }, after: { type: 'engine' } }
          ],
          [
            segments[2].start_time,
            { segmentId: segments[2].id, before: { type: 'engine' }, after: { type: 'sail' } }
          ]
        ]
      );
      assert.ok(
        changes.every((event) => event.source === 'auto'),
        'not a manual correction'
      );
      const snapshots = boat.observations().filter((o) => o.reason === 'event');
      assert.deepEqual(
        snapshots.map((o) => o.time),
        changes.map((event) => event.time),
        'each switch takes an instrument snapshot, like a manoeuvre does'
      );
    });

    it('reads propulsion.*.state when no revolutions are published', () => {
      boat = createBoat()
        .start()
        .sail(5, { sog: 0, engineState: 'stopped' })
        .sail(20, { sog: 6, engineState: 'started' });

      const [segment] = boat.segments();
      assert.equal(segment.type, 'engine');
      assert.equal(segment.average_rpm, null);
    });

    it('counts a twin-engine boat as motoring while either engine runs', () => {
      boat = createBoat()
        .start()
        .sail(5, { sog: 0, rpm: { port: 0, starboard: 0 } })
        .sail(20, { sog: 6, rpm: { port: 1800, starboard: 0 } })
        .sail(20, { sog: 5, rpm: { port: 0, starboard: 0 } });

      const segments = boat.segments();
      assert.deepEqual(
        segments.map((segment) => segment.type),
        ['engine', 'sail']
      );
      assert.ok(Math.abs(segments[0].average_rpm - 1800) < 1e-6, 'averages running engines only');
    });

    it('stops trusting engine data that is no longer refreshed', () => {
      boat = createBoat()
        .start()
        .sail(5, { sog: 0, rpm: 2000 })
        .sail(20, { sog: 6, rpm: 2000 })
        .sail(10, { sog: 6 });

      assert.deepEqual(
        boat.segments().map((segment) => segment.type),
        ['engine', 'sail']
      );
    });
  });

  it('follows navigation.state when there is no engine data', () => {
    boat = createBoat()
      .start()
      .sail(5, { sog: 0, state: 'moored' })
      .sail(12, { sog: 6, state: 'motoring' });

    assert.equal(boat.segments()[0].type, 'engine');
    assert.equal(boat.detector.propulsion(), 'engine');
  });

  it('assumes the configured propulsion without any data', () => {
    boat = createBoat({ settings: { defaultPropulsion: 'engine' } })
      .start()
      .sail(5, { sog: 0 })
      .sail(20, { sog: 6 });

    assert.equal(boat.segments()[0].type, 'engine');
  });

  it('ends the segment at a stop and starts the next when the vessel moves again', () => {
    boat = createBoat().start().sail(5, { sog: 0 }).sail(20, { sog: 5 });
    const stoppedAt = boat.nextTick();
    boat.sail(10, { sog: 0 });
    assert.equal(boat.segments()[0].end_time, iso(stoppedAt), 'ended as the passage closes');
    const resumedAt = boat.nextTick();
    boat.sail(10, { sog: 5 });

    const [entry] = boat.entries();
    const [first, second] = boat.segments();
    assert.equal(entry.state, 'active', 'reopened');
    assert.equal(second.entry_id, entry.id);
    assert.equal(first.end_time, iso(stoppedAt));
    assert.equal(second.start_time, iso(resumedAt), 'dated from speed, not the averaged decision');
    assert.equal(second.end_time, null);
    assert.equal(
      entry.sail_duration,
      seconds(entry.start_time, iso(stoppedAt)) + seconds(iso(resumedAt), iso(boat.now)),
      'the stop is not counted, and the open segment counts up to now'
    );
  });

  it('keeps a manual correction of the ongoing segment until the engine state changes', () => {
    boat = createBoat().start().sail(5, { sog: 0 }).sail(10, { sog: 5 });
    const [segment] = boat.segments();
    correctSegment(boat.db, segment.id, { type: 'engine' }, { now: iso(boat.now) });

    boat.sail(10, { sog: 5 });
    assert.deepEqual(
      boat.segments().map((s) => [s.type, s.source]),
      [['engine', 'manual']],
      'the sensors still say sail, but that is not news'
    );

    boat.sail(5, { sog: 5, rpm: 2000 }).sail(5, { sog: 5, rpm: 0 });
    assert.deepEqual(
      boat.segments().map((s) => [s.type, s.source]),
      [
        ['engine', 'manual'],
        ['sail', 'auto']
      ]
    );
  });

  describe('across restarts', () => {
    it('carries on with the open segment when nothing changed', () => {
      boat = createBoat().start().sail(5, { sog: 0, rpm: 2000 }).sail(20, { sog: 6, rpm: 2000 });

      boat.start().sail(5, { sog: 6, rpm: 2000 });

      assert.equal(boat.segments().length, 1);
    });

    it('realigns an automatic segment with what the engine reports after a restart', () => {
      boat = createBoat().start().sail(5, { sog: 0, rpm: 0 }).sail(20, { sog: 6, rpm: 0 });

      boat.start().sail(1, { sog: 6, rpm: 2000 });

      assert.deepEqual(
        boat.segments().map((segment) => segment.type),
        ['sail', 'engine']
      );
      assert.deepEqual(
        boat.events().filter((event) => event.type === 'propulsion_change'),
        [],
        'realigning after a restart is a correction, not something that just happened'
      );
    });
  });
});
