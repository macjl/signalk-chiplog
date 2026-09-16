// Seeds a demo logbook — four passages around La Rochelle and the Vendée coast over
// the last few days — to try the webapp or the API without going sailing.
//
//   node scripts/seed-demo.js <data directory>
//
// The directory is where the plugin keeps chiplog.sqlite: a scratch directory, or
// ~/.signalk/plugin-config-data/signalk-chiplog on a server whose plugin is stopped.
// A logbook that already holds passages is left untouched.
//
// Times are relative to now, so the log always reads as recent. The data covers
// what the webapp shows: tracks, engine and sail segments, instrument snapshots,
// manoeuvres, automatic events, a handwritten note, a passage across midnight,
// a place name pending geocoding, and a passage still in progress.

const fs = require('node:fs');
const path = require('node:path');
const { DATABASE_FILENAME, openDatabase, withTransaction } = require('../lib/database');
const { recomputeDurations } = require('../lib/entries');
const { distanceBetween } = require('../lib/places');

const MINUTE = 60 * 1000;
const TRACK_SAMPLE_MS = 30 * 1000;

const PLACES = {
  minimes: { name: 'La Rochelle (Les Minimes)', lat: 46.1466, lon: -1.1686, source: 'geocoding' },
  saintMartin: { name: 'Saint-Martin-de-Ré', lat: 46.2044, lon: -1.3647, source: 'geocoding' },
  sables: { name: "Les Sables-d'Olonne", lat: 46.4969, lon: -1.7937, source: 'geocoding' },
  bourgenay: { name: 'Port Bourgenay', lat: 46.4383, lon: -1.6769, source: 'manual' }
};

const iso = (ms) => new Date(ms).toISOString();
const radians = (degrees) => (degrees * Math.PI) / 180;

function bearing(from, to) {
  const y = Math.sin(radians(to.lon - from.lon)) * Math.cos(radians(to.lat));
  const x =
    Math.cos(radians(from.lat)) * Math.sin(radians(to.lat)) -
    Math.sin(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.cos(radians(to.lon - from.lon));
  return (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
}

function createSeeder(db, now) {
  const today = new Date(now);
  const at = (daysAgo, hours, minutes = 0) =>
    new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - daysAgo,
      hours,
      minutes
    ).getTime();

  function insert(table, row) {
    const columns = Object.keys(row);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      )
      .run(...Object.values(row));
    return Number(lastInsertRowid);
  }

  // Straight legs between timed waypoints, sampled every 30 s.
  function recordTrack(entryId, waypoints) {
    const points = [];
    for (let leg = 1; leg < waypoints.length; leg += 1) {
      const from = waypoints[leg - 1];
      const to = waypoints[leg];
      const duration = to.time - from.time;
      const sog = distanceBetween(from, to) / (duration / 1000);
      const cog = bearing(from, to);
      const steps = Math.max(1, Math.round(duration / TRACK_SAMPLE_MS));
      for (let step = 0; step < steps; step += 1) {
        const fraction = step / steps;
        points.push({
          lat: from.lat + (to.lat - from.lat) * fraction,
          lon: from.lon + (to.lon - from.lon) * fraction,
          time: from.time + duration * fraction,
          sog,
          cog,
          heading: (cog + 0.05) % (2 * Math.PI),
          stw: sog * 0.95
        });
      }
    }
    points.push({
      ...waypoints.at(-1),
      sog: 0,
      cog: points.at(-1)?.cog ?? 0,
      heading: points.at(-1)?.heading ?? 0,
      stw: 0
    });

    let distance = 0;
    points.forEach((point, index) => {
      insert('track_points', {
        entry_id: entryId,
        time: iso(point.time),
        lat: point.lat,
        lon: point.lon,
        sog: point.sog,
        cog: point.cog,
        stw: point.stw,
        tws: 7.5,
        twd: 4.9,
        awa: -0.8,
        heading: point.heading
      });
      if (index > 0) {
        distance += distanceBetween(points[index - 1], point);
      }
    });
    db.prepare('UPDATE log_entries SET distance = ? WHERE id = ?').run(distance, entryId);
    return points;
  }

  function nearest(points, time) {
    return points.reduce((best, point) =>
      Math.abs(point.time - time) < Math.abs(best.time - time) ? point : best
    );
  }

  // Readings in Signal K units: m/s, radians, metres, Pa, K, seconds.
  function observe(entryId, reason, time, points, overrides = {}) {
    const point = nearest(points, time);
    return insert('observations', {
      entry_id: entryId,
      time: iso(time),
      reason,
      lat: point.lat,
      lon: point.lon,
      sog: point.sog,
      cog: point.cog,
      heading: (point.cog + 0.05) % (2 * Math.PI),
      stw: point.sog * 0.95,
      twd: 4.9,
      tws: 7.5,
      awa: -0.8,
      aws: 9.8,
      depth: 14.2,
      pressure: 101650,
      air_temp: 293.2,
      water_temp: 291.4,
      trip_log: 1200,
      ...overrides
    });
  }

  function log(
    entryId,
    time,
    type,
    { subtype = null, comment = null, payload = null, source = 'manual', points } = {}
  ) {
    const point = points ? nearest(points, time) : null;
    return insert('events', {
      entry_id: entryId,
      time: iso(time),
      type,
      subtype,
      lat: point ? point.lat : null,
      lon: point ? point.lon : null,
      comment,
      payload: payload === null ? null : JSON.stringify(payload),
      source,
      created_at: iso(time)
    });
  }

  function segment(entryId, type, start, end, averageRpm = null) {
    return insert('propulsion_segments', {
      entry_id: entryId,
      type,
      start_time: iso(start),
      end_time: end === null ? null : iso(end),
      source: 'auto',
      average_rpm: averageRpm
    });
  }

  return { at, insert, recordTrack, observe, log, segment };
}

function seedDemoLogbook(db, { now = Date.now() } = {}) {
  const { at, insert, recordTrack, observe, log, segment } = createSeeder(db, now);
  const KNOT = 1852 / 3600;

  return withTransaction(db, () => {
    const placeIds = {};
    for (const [key, place] of Object.entries(PLACES)) {
      placeIds[key] = insert('places', {
        name: place.name,
        lat: place.lat,
        lon: place.lon,
        source: place.source,
        created_at: iso(at(10, 9)),
        updated_at: iso(at(10, 9))
      });
    }

    // Three days ago: La Rochelle to Saint-Martin-de-Ré, beating under the bridge.
    const beat = (() => {
      const start = at(3, 10);
      const end = at(3, 13, 20);
      const { minimes, saintMartin } = PLACES;
      const id = insert('log_entries', {
        state: 'closed',
        start_time: iso(start),
        end_time: iso(end),
        start_lat: minimes.lat,
        start_lon: minimes.lon,
        end_lat: saintMartin.lat,
        end_lon: saintMartin.lon,
        start_place_id: placeIds.minimes,
        end_place_id: placeIds.saintMartin,
        start_place_name: minimes.name,
        end_place_name: saintMartin.name,
        created_at: iso(start),
        updated_at: iso(end)
      });
      const points = recordTrack(id, [
        { ...minimes, time: start },
        { lat: 46.143, lon: -1.183, time: at(3, 10, 15) },
        { lat: 46.148, lon: -1.215, time: at(3, 10, 25) },
        { lat: 46.164, lon: -1.252, time: at(3, 10, 45) },
        { lat: 46.178, lon: -1.27, time: at(3, 11) },
        { lat: 46.192, lon: -1.302, time: at(3, 11, 35) },
        { lat: 46.199, lon: -1.335, time: at(3, 12, 15) },
        { lat: 46.208, lon: -1.356, time: at(3, 12, 55) },
        { ...saintMartin, time: end }
      ]);
      segment(id, 'engine', start, at(3, 10, 25), 1850);
      const underSail = segment(id, 'sail', at(3, 10, 25), at(3, 13, 5));
      const underEngineAgain = segment(id, 'engine', at(3, 13, 5), end, 1600);

      log(id, start, 'manoeuvre', { subtype: 'cast_off', points });
      observe(id, 'entry_start', start + MINUTE, points, { tws: 5.5, aws: 6 });
      log(id, at(3, 10, 25), 'manoeuvre', {
        subtype: 'sail_change',
        payload: { sail: 'genoa' },
        points
      });
      log(id, at(3, 10, 25), 'propulsion_change', {
        payload: { segmentId: underSail, before: { type: 'engine' }, after: { type: 'sail' } },
        source: 'auto',
        points
      });
      observe(id, 'event', at(3, 10, 25), points);
      log(id, at(3, 10, 30), 'autopilot', {
        subtype: 'engaged',
        source: 'auto',
        payload: { mode: null, state: 'auto', target: { headingMagnetic: 5.1 } },
        points
      });
      observe(id, 'periodic', at(3, 11), points, { tws: 9.8, aws: 12.4, pressure: 101600 });
      log(id, at(3, 11), 'manoeuvre', { subtype: 'tack', points });
      log(id, at(3, 11, 35), 'weather_threshold', {
        subtype: 'wind_above',
        source: 'auto',
        payload: { threshold: 20 * KNOT, windSpeed: 10.9 },
        points
      });
      observe(id, 'event', at(3, 11, 35), points, { tws: 10.9, aws: 13.8 });
      log(id, at(3, 11, 40), 'manoeuvre', {
        subtype: 'reef_in',
        comment: 'Gusts to 25 kn off La Flotte',
        points
      });
      observe(id, 'event', at(3, 11, 40), points, { tws: 11.2, aws: 14.1 });
      // Markup in crew text must be displayed, never interpreted.
      log(id, at(3, 11, 50), 'text_annotation', {
        comment: 'Dolphins off the port bow <b>not bold</b>',
        points
      });
      observe(id, 'periodic', at(3, 12), points, { tws: 10.1, pressure: 101520 });
      log(id, at(3, 12, 15), 'manoeuvre', { subtype: 'tack', points });
      log(id, at(3, 12, 30), 'handwritten_annotation', {
        points,
        payload: {
          strokes: [
            {
              points: [
                { x: 10, y: 60, t: 0 },
                { x: 20, y: 10, t: 120 },
                { x: 30, y: 60, t: 240 }
              ],
              color: '#1d4ed8',
              tool: 'pen',
              width: 2.5
            },
            {
              points: [
                { x: 14, y: 40, t: 400 },
                { x: 26, y: 40, t: 480 }
              ],
              color: '#d97706',
              tool: 'highlighter',
              width: 16
            },
            {
              points: [
                { x: 45, y: 10, t: 700 },
                { x: 45, y: 60, t: 820 },
                { x: 70, y: 60, t: 900 }
              ],
              color: '#dc2626',
              tool: 'pen',
              width: 5.5
            }
          ]
        }
      });
      log(id, at(3, 13), 'autopilot', {
        subtype: 'disengaged',
        source: 'auto',
        payload: { mode: null, state: 'standby', target: null },
        points
      });
      observe(id, 'periodic', at(3, 13), points, { tws: 8.1 });
      log(id, at(3, 13, 5), 'propulsion_change', {
        payload: {
          segmentId: underEngineAgain,
          before: { type: 'sail' },
          after: { type: 'engine' }
        },
        source: 'auto',
        points
      });
      observe(id, 'event', at(3, 13, 5), points, { tws: 7.9 });
      log(id, end, 'manoeuvre', { subtype: 'moor', points });
      observe(id, 'entry_end', end, points, { tws: 6.3, sog: 0 });
      return id;
    })();

    // Two days ago, overnight: Saint-Martin to Les Sables, arrival name still pending.
    const night = (() => {
      const start = at(2, 20);
      const end = at(1, 5, 30);
      const arrival = { lat: 46.4988, lon: -1.7921 };
      const id = insert('log_entries', {
        state: 'closed',
        start_time: iso(start),
        end_time: iso(end),
        start_lat: PLACES.saintMartin.lat,
        start_lon: PLACES.saintMartin.lon,
        end_lat: arrival.lat,
        end_lon: arrival.lon,
        start_place_id: placeIds.saintMartin,
        start_place_name: PLACES.saintMartin.name,
        end_place_name: '46.4988N 1.7921W',
        end_place_pending: 1,
        created_at: iso(start),
        updated_at: iso(end)
      });
      const points = recordTrack(id, [
        { ...PLACES.saintMartin, time: start },
        { lat: 46.215, lon: -1.37, time: at(2, 20, 20) },
        { lat: 46.25, lon: -1.52, time: at(2, 22) },
        { lat: 46.35, lon: -1.7, time: at(1, 1) },
        { lat: 46.47, lon: -1.83, time: at(1, 4, 30) },
        { ...arrival, time: end }
      ]);
      segment(id, 'sail', start, at(1, 4, 45));
      segment(id, 'engine', at(1, 4, 45), end, 2100);

      observe(id, 'entry_start', start + MINUTE, points);
      for (let hour = 21; hour <= 29; hour += 1) {
        const time = hour < 24 ? at(2, hour) : at(1, hour - 24);
        observe(id, 'periodic', time, points, {
          pressure: 101400 - (hour - 21) * 60,
          tws: 8 + (hour % 3)
        });
      }
      log(id, at(2, 23), 'manoeuvre', {
        subtype: 'watch_change',
        comment: 'Anne on watch',
        points
      });
      log(id, at(1, 2, 10), 'weather_threshold', {
        subtype: 'pressure_drop',
        source: 'auto',
        payload: { drop: 420, over: 10800, pressure: 101000 },
        points
      });
      observe(id, 'event', at(1, 2, 10), points, { pressure: 101000 });
      log(id, at(1, 4, 50), 'sk_alarm', {
        subtype: 'notifications.propulsion.main.temperature',
        comment: 'Engine temperature high',
        source: 'auto',
        payload: { state: 'alarm', message: 'Engine temperature high' },
        points
      });
      observe(id, 'event', at(1, 4, 50), points);
      log(id, at(1, 5, 5), 'sk_alarm', {
        subtype: 'notifications.propulsion.main.temperature',
        comment: 'Engine temperature normal',
        source: 'auto',
        payload: { state: 'normal', message: 'Engine temperature normal' },
        points
      });
      observe(id, 'entry_end', end, points, { sog: 0 });
      return id;
    })();

    // Yesterday: a short hop south to Bourgenay, with a corrected engine/sail segment.
    const hop = (() => {
      const start = at(1, 14);
      const end = at(1, 16, 10);
      const id = insert('log_entries', {
        state: 'closed',
        start_time: iso(start),
        end_time: iso(end),
        start_lat: PLACES.sables.lat,
        start_lon: PLACES.sables.lon,
        end_lat: PLACES.bourgenay.lat,
        end_lon: PLACES.bourgenay.lon,
        start_place_id: placeIds.sables,
        end_place_id: placeIds.bourgenay,
        start_place_name: PLACES.sables.name,
        end_place_name: PLACES.bourgenay.name,
        created_at: iso(start),
        updated_at: iso(end)
      });
      const points = recordTrack(id, [
        { ...PLACES.sables, time: start },
        { lat: 46.485, lon: -1.805, time: at(1, 14, 20) },
        { lat: 46.46, lon: -1.76, time: at(1, 15) },
        { lat: 46.433, lon: -1.7, time: at(1, 15, 40) },
        { ...PLACES.bourgenay, time: end }
      ]);
      const corrected = segment(id, 'sail', start, at(1, 15, 40));
      db.prepare("UPDATE propulsion_segments SET source = 'manual' WHERE id = ?").run(corrected);
      segment(id, 'engine', at(1, 15, 40), end, 1700);
      log(id, start, 'manual_correction', {
        subtype: 'propulsion',
        payload: { segmentId: corrected, before: { type: 'engine' }, after: { type: 'sail' } },
        source: 'auto'
      });
      observe(id, 'entry_start', start + MINUTE, points);
      observe(id, 'periodic', at(1, 15), points);
      observe(id, 'entry_end', end, points, { sog: 0 });
      return id;
    })();

    // Today: under way from Bourgenay for the last hour and a half.
    const current = (() => {
      const start = now - 95 * MINUTE;
      const id = insert('log_entries', {
        state: 'active',
        start_time: iso(start),
        start_lat: PLACES.bourgenay.lat,
        start_lon: PLACES.bourgenay.lon,
        start_place_id: placeIds.bourgenay,
        start_place_name: PLACES.bourgenay.name,
        last_moving_at: iso(now),
        created_at: iso(start),
        updated_at: iso(now)
      });
      const points = recordTrack(id, [
        { ...PLACES.bourgenay, time: start },
        { lat: 46.429, lon: -1.68, time: start + 20 * MINUTE },
        { lat: 46.405, lon: -1.63, time: start + 40 * MINUTE },
        { lat: 46.38, lon: -1.56, time: now - MINUTE }
      ]);
      const last = points.at(-1);
      db.prepare('UPDATE log_entries SET end_lat = ?, end_lon = ? WHERE id = ?').run(
        last.lat,
        last.lon,
        id
      );
      segment(id, 'engine', start, start + 20 * MINUTE, 1900);
      segment(id, 'sail', start + 20 * MINUTE, null);
      observe(id, 'entry_start', start + MINUTE, points);
      log(id, start + 22 * MINUTE, 'manoeuvre', {
        subtype: 'sail_change',
        payload: { sail: 'gennaker' },
        points
      });
      observe(id, 'event', start + 22 * MINUTE, points);
      return id;
    })();

    for (const id of [beat, night, hop, current]) {
      recomputeDurations(db, id, iso(now));
    }
    // A twin-engine boat: both hour counters advance while under engine, from
    // what they read before the first passage.
    const engineSegments = db
      .prepare("SELECT start_time, end_time FROM propulsion_segments WHERE type = 'engine'")
      .all();
    const engineHoursBefore = (time) =>
      engineSegments.reduce((sum, { start_time: start, end_time: end }) => {
        const from = Date.parse(start);
        const to = Math.min(end === null ? now : Date.parse(end), Date.parse(time));
        return sum + Math.max(0, to - from) / 1000;
      }, 0);
    const setRuntimes = db.prepare(
      'UPDATE observations SET engine_runtime = ?, engine_runtimes = ? WHERE id = ?'
    );
    for (const { id, time } of db.prepare('SELECT id, time FROM observations').all()) {
      const run = engineHoursBefore(time);
      const port = Math.round(812.4 * 3600 + run);
      const starboard = Math.round(798.1 * 3600 + run);
      setRuntimes.run(port, JSON.stringify({ port, starboard }), id);
    }

    return [beat, night, hop, current];
  });
}

function main() {
  const [directory] = process.argv.slice(2);
  if (!directory) {
    console.error('Usage: node scripts/seed-demo.js <data directory>');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, DATABASE_FILENAME);
  const { db } = openDatabase(directory);
  try {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM log_entries').get();
    if (count > 0) {
      console.error(`${file} already holds ${count} passage(s); nothing was added.`);
      process.exitCode = 1;
      return;
    }
    const ids = seedDemoLogbook(db);
    console.log(`Seeded ${ids.length} passages into ${file}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { seedDemoLogbook };
