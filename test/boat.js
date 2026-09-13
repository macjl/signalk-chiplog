const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/database');
const { createPassageDetector, DETECTION_DEFAULTS, TICK_INTERVAL_MS } = require('../lib/detection');
const { PROPULSION_DEFAULTS } = require('../lib/propulsion-detector');

const KNOT = 1852 / 3600;
const METRES_PER_DEGREE_LAT = 111320;
const MINUTE = 60 * 1000;
const T0 = Date.parse('2026-09-13T08:00:00.000Z');
const BERTH = { lat: 46.1466, lon: -1.1686 };

const iso = (ms) => new Date(ms).toISOString();

// Per-engine values: a bare value is the `main` engine.
function perEngine(value) {
  return value !== null && typeof value === 'object' ? value : { main: value };
}

// A vessel steaming due north at the published speed, with Signal K values
// refreshed on every detection tick.
function createBoat({ settings = {}, clockOffsetMs = 0 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-boat-'));
  const { db } = openDatabase(dataDir);
  const self = {};
  let detector = null;

  // getSelfPath('propulsion') returns the engines keyed by id, like the server.
  function readSelfPath(skPath) {
    if (skPath !== 'propulsion') {
      return self[skPath];
    }
    const engines = {};
    for (const key of Object.keys(self)) {
      const [root, id] = key.split('.');
      if (root === 'propulsion') {
        engines[id] = engines[id] ?? {};
      }
    }
    return Object.keys(engines).length > 0 ? engines : undefined;
  }

  const boat = {
    db,
    now: T0,
    position: { ...BERTH },

    publish(skPath, value) {
      self[skPath] = { value, timestamp: iso(boat.now + clockOffsetMs) };
    },

    start() {
      detector = createPassageDetector({
        db,
        readSelfPath,
        settings: {
          ...DETECTION_DEFAULTS,
          ...PROPULSION_DEFAULTS,
          placeMatchRadius: 200,
          ...settings
        },
        clock: () => boat.now
      });
      return boat;
    },

    get detector() {
      return detector;
    },

    // Advance by `minutes`, publishing on every tick. `sog` is in knots,
    // constant or a function of the tick index; `state` is navigation.state;
    // `rpm` and `engineState` are per engine (see perEngine). Values left out
    // are not refreshed.
    sail(minutes, { sog, state, rpm, engineState } = {}) {
      const ticks = Math.round((minutes * MINUTE) / TICK_INTERVAL_MS);
      for (let i = 0; i < ticks; i += 1) {
        boat.now += TICK_INTERVAL_MS;
        if (sog !== undefined) {
          const knots = typeof sog === 'function' ? sog(i) : sog;
          const metres = knots * KNOT * (TICK_INTERVAL_MS / 1000);
          boat.position = {
            lat: boat.position.lat + metres / METRES_PER_DEGREE_LAT,
            lon: boat.position.lon
          };
          boat.publish('navigation.speedOverGround', knots * KNOT);
          boat.publish('navigation.position', {
            latitude: boat.position.lat,
            longitude: boat.position.lon
          });
        }
        if (state !== undefined) {
          boat.publish('navigation.state', state);
        }
        if (rpm !== undefined) {
          for (const [id, value] of Object.entries(perEngine(rpm))) {
            boat.publish(`propulsion.${id}.revolutions`, value / 60);
          }
        }
        if (engineState !== undefined) {
          for (const [id, value] of Object.entries(perEngine(engineState))) {
            boat.publish(`propulsion.${id}.state`, value);
          }
        }
        detector.tick();
      }
      return boat;
    },

    nextTick() {
      return boat.now + TICK_INTERVAL_MS;
    },

    entries() {
      return db.prepare('SELECT * FROM log_entries ORDER BY id').all();
    },

    segments() {
      return db.prepare('SELECT * FROM propulsion_segments ORDER BY start_time, id').all();
    },

    close() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };

  return boat;
}

function addPlace(db, name, { lat, lon }) {
  db.prepare(
    `INSERT INTO places (name, lat, lon, source, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?)`
  ).run(name, lat, lon, iso(T0), iso(T0));
}

module.exports = { createBoat, addPlace, iso, KNOT, MINUTE, T0, BERTH };
