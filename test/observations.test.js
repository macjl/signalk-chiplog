const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { createBoat, iso, BERTH, KNOT, MINUTE, T0 } = require('./boat');

const INSTRUMENTS = {
  'navigation.headingMagnetic': 1.0,
  'navigation.magneticVariation': -0.05,
  'navigation.courseOverGroundTrue': 0.9,
  'navigation.speedThroughWater': 2.4,
  'environment.wind.directionTrue': 4.0,
  'environment.wind.speedTrue': 7.7,
  'environment.wind.angleApparent': -0.6,
  'environment.wind.speedApparent': 9.1,
  'environment.depth.belowTransducer': 12.3,
  'environment.outside.pressure': 101820,
  'environment.outside.temperature': 291.4,
  'environment.water.temperature': 289.9,
  'navigation.log': 18520,
  'propulsion.port.runTime': 1000,
  'propulsion.main.runTime': 3600000
};

const at = (hh, mm) => iso(Date.parse(`2026-09-13T${hh}:${mm}:00.000Z`));

function openEntry(db) {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO log_entries (state, start_time, created_at, updated_at) VALUES ('active', ?, ?, ?)"
    )
    .run(iso(T0), iso(T0), iso(T0));
  return Number(lastInsertRowid);
}

describe('instrument snapshots', () => {
  let boat;

  afterEach(() => boat.close());

  it('are taken at departure, on the hour during the passage, and at arrival', () => {
    boat = createBoat()
      .start()
      .sail(5, { sog: 0, instruments: INSTRUMENTS })
      .sail(150, { sog: 5, instruments: INSTRUMENTS })
      .sail(40, { sog: 0, instruments: INSTRUMENTS });

    const [entry] = boat.entries();
    const observations = boat.observations();
    assert.equal(entry.state, 'closed');
    assert.deepEqual(
      observations.map((o) => o.reason),
      ['entry_start', 'periodic', 'periodic', 'periodic', 'entry_end']
    );
    assert.deepEqual(
      observations.filter((o) => o.reason === 'periodic').map((o) => o.time),
      [at('09', '00'), at('10', '00'), at('11', '00')],
      'on the hour, including during the stop before the passage closed'
    );
    assert.ok(observations.every((o) => o.entry_id === entry.id));
  });

  it('record every instrument in Signal K units', () => {
    boat = createBoat()
      .start()
      .sail(5, { sog: 0, instruments: INSTRUMENTS })
      .sail(5, { sog: 5, instruments: INSTRUMENTS });

    const [snapshot] = boat.observations();
    assert.equal(snapshot.reason, 'entry_start');
    assert.ok(Math.abs(snapshot.sog - 5 * KNOT) < 1e-9);
    assert.ok(snapshot.lat > BERTH.lat && snapshot.lat < boat.position.lat, 'taken on the way out');
    assert.equal(snapshot.cog, 0.9);
    assert.ok(Math.abs(snapshot.heading - 0.95) < 1e-9, 'true heading from magnetic and variation');
    assert.equal(snapshot.stw, 2.4);
    assert.equal(snapshot.twd, 4.0);
    assert.equal(snapshot.tws, 7.7);
    assert.equal(snapshot.awa, -0.6);
    assert.equal(snapshot.aws, 9.1);
    assert.equal(snapshot.depth, 12.3, 'below transducer when below surface is missing');
    assert.equal(snapshot.pressure, 101820);
    assert.equal(snapshot.air_temp, 291.4);
    assert.equal(snapshot.water_temp, 289.9);
    assert.equal(snapshot.trip_log, 18520);
    assert.equal(snapshot.engine_runtime, 3600000, 'the main engine first');
    assert.deepEqual(JSON.parse(snapshot.engine_runtimes), { main: 3600000, port: 1000 });
  });

  it('record the hour counter of every engine', () => {
    boat = createBoat()
      .start()
      .sail(5, {
        sog: 0,
        instruments: {
          'propulsion.starboard.runTime': 2900000,
          'propulsion.port.runTime': 3000000,
          'propulsion.generator.state': 'stopped'
        }
      })
      .sail(5, {
        sog: 5,
        instruments: {
          'propulsion.starboard.runTime': 2900000,
          'propulsion.port.runTime': 3000300
        }
      });

    const [snapshot] = boat.observations();
    assert.deepEqual(
      Object.entries(JSON.parse(snapshot.engine_runtimes)),
      [
        ['port', 3000300],
        ['starboard', 2900000]
      ],
      'every engine with a counter, in a stable order'
    );
    assert.equal(snapshot.engine_runtime, 3000300, 'the first engine, as before');
  });

  it('record no engine hours on a boat without counters', () => {
    boat = createBoat().start().sail(5, { sog: 0 }).sail(5, { sog: 5 });
    const [snapshot] = boat.observations();
    assert.equal(snapshot.engine_runtime, null);
    assert.equal(snapshot.engine_runtimes, null);
  });

  it('leave out readings that are no longer current', () => {
    boat = createBoat()
      .start()
      .sail(10, {
        sog: 5,
        instruments: {
          'environment.wind.speedTrue': 7.7,
          'environment.outside.pressure': 101820
        }
      })
      .sail(5, { sog: 5 });
    const [entry] = boat.entries();

    boat.detector.observeEvent(entry.id, iso(boat.now));
    let snapshot = boat.observations().at(-1);
    assert.equal(snapshot.tws, null, 'wind unrefreshed for five minutes');
    assert.equal(snapshot.pressure, 101820, 'the barometer is allowed to be slower');
    assert.ok(snapshot.sog > 0);

    boat.sail(15, { sog: 5 });
    boat.detector.observeEvent(entry.id, iso(boat.now));
    snapshot = boat.observations().at(-1);
    assert.equal(snapshot.pressure, null);
  });

  it('notice a sensor that died between two hourly snapshots', () => {
    const wind = { 'environment.wind.speedTrue': 7.7 };
    boat = createBoat()
      .start()
      .sail(5, { sog: 0, instruments: wind })
      .sail(65, { sog: 5, instruments: wind }) // through the 09:00 snapshot
      .sail(10, { sog: 5, instruments: wind }) // the wind sensor goes on until 09:20...
      .sail(45, { sog: 5 }); // ...then dies, long before 10:00

    const periodic = boat.observations().filter((o) => o.reason === 'periodic');
    assert.deepEqual(
      periodic.map((o) => [o.time, o.tws]),
      [
        [at('09', '00'), 7.7],
        [at('10', '00'), null]
      ]
    );
  });

  it('keep counters whatever their age', () => {
    boat = createBoat()
      .start()
      .sail(1, { sog: 0, instruments: { 'navigation.log': 5000 } })
      .sail(70, { sog: 5 });

    const periodic = boat.observations().find((o) => o.reason === 'periodic');
    assert.equal(periodic.trip_log, 5000);
  });

  it('are skipped when no instrument reading is known', () => {
    boat = createBoat().start();
    const entryId = openEntry(boat.db);

    assert.equal(boat.detector.observeEvent(entryId, iso(boat.now)), null);
    assert.equal(boat.observations().length, 0);
  });

  it('follow the configured interval', () => {
    boat = createBoat({ settings: { observationIntervalMinutes: 30 } })
      .start()
      .sail(5, { sog: 0 })
      .sail(70, { sog: 5 });

    assert.deepEqual(
      boat
        .observations()
        .filter((o) => o.reason === 'periodic')
        .map((o) => o.time),
      [at('08', '30'), at('09', '00')]
    );
  });

  it('let an event snapshot stand in for the periodic one in the same slot', () => {
    boat = createBoat().start().sail(5, { sog: 0 });
    boat.sail(54.75, { sog: 5 });
    const [entry] = boat.entries();

    boat.now += 20 * 1000;
    boat.detector.observeEvent(entry.id, iso(boat.now));
    boat.sail(5, { sog: 5 });

    const nineOClock = boat
      .observations()
      .filter((o) => o.time >= at('09', '00') && o.time < at('10', '00'));
    assert.deepEqual(
      nineOClock.map((o) => o.reason),
      ['event']
    );
  });

  it('skip the arrival snapshot of a passage closed long after it ended', () => {
    boat = createBoat().start().sail(5, { sog: 0 }).sail(30, { sog: 5 });

    boat.now += 2 * 24 * 60 * MINUTE;
    boat.start().sail(1, { sog: 0 });

    assert.equal(boat.entries()[0].state, 'closed');
    assert.ok(boat.observations().every((o) => o.reason !== 'entry_end'));
  });
});
