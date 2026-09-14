const OBSERVATION_DEFAULTS = { observationIntervalMinutes: 60 };

// Navigation, wind and depth arrive several times a second; barometer and
// temperatures can be minutes apart.
const FAST_MAX_AGE_MS = 2 * 60 * 1000;
const SLOW_MAX_AGE_MS = 15 * 60 * 1000;

const COLUMNS = [
  'lat',
  'lon',
  'sog',
  'cog',
  'heading',
  'stw',
  'twd',
  'tws',
  'awa',
  'aws',
  'depth',
  'pressure',
  'air_temp',
  'water_temp',
  'trip_log',
  'engine_runtime',
  'engine_runtimes'
];

function iso(ms) {
  return new Date(ms).toISOString();
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeAngle(radians) {
  return ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function engineColumns(runtimes) {
  const values = Object.values(runtimes);
  return {
    engine_runtime: values.length > 0 ? values[0] : null,
    engine_runtimes: values.length > 0 ? JSON.stringify(runtimes) : null
  };
}

function createObservationRecorder({ db, readSelfPath, readFresh, settings }) {
  const intervalMs = settings.observationIntervalMinutes * 60 * 1000;
  let latest = {};

  const fast = (path, now) => finiteOrNull(readFresh(path, now, FAST_MAX_AGE_MS));
  const slow = (path, now) => finiteOrNull(readFresh(path, now, SLOW_MAX_AGE_MS));
  // A counter's last value stays a true reading while it does not move: engine
  // hours with the engine off, the trip log at anchor.
  const counter = (path) => finiteOrNull(readSelfPath(path)?.value);

  // Every engine's hour counter, the main engine first, then by id — so that
  // the recorded JSON, and the columns exports make of it, keep one order.
  function engineRuntimes() {
    const ids = Object.keys(readSelfPath('propulsion') ?? {}).sort((a, b) =>
      a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b, 'en', { numeric: true })
    );
    const runtimes = {};
    for (const id of ids) {
      const runtime = counter(`propulsion.${id}.runTime`);
      if (runtime !== null) {
        runtimes[id] = runtime;
      }
    }
    return runtimes;
  }

  // Called every detection cycle, not only when a snapshot is due: freshness is
  // judged by timestamps changing between reads, so a sensor read once an hour
  // would look current as long as it had changed at any point in that hour.
  function sense(now) {
    const position = readFresh('navigation.position', now, FAST_MAX_AGE_MS);
    const headingTrue = fast('navigation.headingTrue', now);
    const headingMagnetic = fast('navigation.headingMagnetic', now);
    const variation = slow('navigation.magneticVariation', now);
    const belowSurface = fast('environment.depth.belowSurface', now);
    const belowTransducer = fast('environment.depth.belowTransducer', now);

    const hasPosition =
      position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude);

    latest = {
      lat: hasPosition ? position.latitude : null,
      lon: hasPosition ? position.longitude : null,
      sog: fast('navigation.speedOverGround', now),
      cog: fast('navigation.courseOverGroundTrue', now),
      heading:
        headingTrue ??
        (headingMagnetic !== null && variation !== null
          ? normalizeAngle(headingMagnetic + variation)
          : null),
      stw: fast('navigation.speedThroughWater', now),
      twd: fast('environment.wind.directionTrue', now),
      tws: fast('environment.wind.speedTrue', now),
      awa: fast('environment.wind.angleApparent', now),
      aws: fast('environment.wind.speedApparent', now),
      depth: belowSurface ?? belowTransducer,
      pressure: slow('environment.outside.pressure', now),
      air_temp: slow('environment.outside.temperature', now),
      water_temp: slow('environment.water.temperature', now),
      trip_log: counter('navigation.trip.log'),
      ...engineColumns(engineRuntimes())
    };
  }

  function record(entryId, reason, time) {
    if (COLUMNS.every((column) => latest[column] === null)) {
      return null;
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO observations (entry_id, time, reason, ${COLUMNS.join(', ')})
         VALUES (?, ?, ?, ${COLUMNS.map(() => '?').join(', ')})`
      )
      .run(entryId, time, reason, ...COLUMNS.map((column) => latest[column]));
    return Number(lastInsertRowid);
  }

  // Periodic snapshots fall on clock boundaries — on the hour by default — as
  // on a paper log. Any snapshot already in the slot, such as one taken for an
  // event, stands in for the periodic one.
  function recordPeriodic(entry, now) {
    const { lastTime } = db
      .prepare('SELECT MAX(time) AS lastTime FROM observations WHERE entry_id = ?')
      .get(entry.id);
    const lastSlot = Math.floor(Date.parse(lastTime ?? entry.start_time) / intervalMs);
    if (Math.floor(now / intervalMs) > lastSlot) {
      record(entry.id, 'periodic', iso(now));
    }
  }

  return {
    sense,

    // Runs inside detection's transaction, with what this cycle did to passages.
    afterDetection(now, { opened, closed }) {
      if (closed && !closed.late) {
        record(closed.id, 'entry_end', iso(now));
      }
      if (opened) {
        record(opened, 'entry_start', iso(now));
        return;
      }
      const entry = db
        .prepare("SELECT id, start_time FROM log_entries WHERE state = 'active'")
        .get();
      if (entry) {
        recordPeriodic(entry, now);
      }
    },

    recordEvent(entryId, time, now) {
      sense(now);
      return record(entryId, 'event', time);
    }
  };
}

module.exports = { createObservationRecorder, OBSERVATION_DEFAULTS };
