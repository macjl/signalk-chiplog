const { withTransaction } = require('./database');
const { MAX_REFINEMENT_AGE_MS, createFreshnessTracker } = require('./detection');
const { distanceBetween } = require('./places');

const METRES_PER_SECOND_PER_KNOT = 1852 / 3600;

const SAMPLE_INTERVAL_MS = 1000;
const TRACK_DEFAULTS = { trackIntervalSeconds: 15 };

// Wind and heading, like the same readings in observations: current within
// this age, magnetic variation allowed to lag further behind.
const WIND_MAX_AGE_MS = 2 * 60 * 1000;
const VARIATION_MAX_AGE_MS = 15 * 60 * 1000;

// Interval points are skipped until the vessel has moved this far, so a boat
// waiting at a lock does not pile up identical points.
const MIN_MOVE_METRES = 10;
const HEADING_CHANGE_RAD = (15 * Math.PI) / 180;
// Course over ground is noise at low speed; below this, a swinging boat would
// log a turn every second.
const MIN_HEADING_SPEED = 2 * METRES_PER_SECOND_PER_KNOT;
const SPEED_CHANGE = 1 * METRES_PER_SECOND_PER_KNOT;
const MIN_CHANGE_SPACING_MS = 2000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function headingDifference(a, b) {
  const diff = Math.abs(a - b) % (2 * Math.PI);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

function normalizeAngle(radians) {
  return ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function createTrackRecorder({ db, readSelfPath, settings, clock = Date.now }) {
  const intervalMs = settings.trackIntervalSeconds * 1000;
  const readFresh = createFreshnessTracker(readSelfPath);

  let lastFixTimestamp = null;
  let lastSampled = null;
  // Detection dates a departure back to when the vessel left its berth, up to
  // MAX_REFINEMENT_AGE_MS before it opens the entry, and resumes a stopped one
  // only after averaging. Points wait here until they have a moving passage to
  // belong to, so the track starts where the passage does.
  let pending = [];
  let lastWritten = null;

  function readFix(now) {
    const node = readSelfPath('navigation.position');
    if (!node?.timestamp || node.timestamp === lastFixTimestamp) {
      return null;
    }
    lastFixTimestamp = node.timestamp;

    const { value } = node;
    if (!value || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) {
      return null;
    }

    const headingTrue = finiteOrNull(readFresh('navigation.headingTrue', now, WIND_MAX_AGE_MS));
    const headingMagnetic = finiteOrNull(
      readFresh('navigation.headingMagnetic', now, WIND_MAX_AGE_MS)
    );
    const variation = finiteOrNull(
      readFresh('navigation.magneticVariation', now, VARIATION_MAX_AGE_MS)
    );

    return {
      time: now,
      lat: value.latitude,
      lon: value.longitude,
      sog: finiteOrNull(readSelfPath('navigation.speedOverGround')?.value),
      cog: finiteOrNull(readSelfPath('navigation.courseOverGroundTrue')?.value),
      stw: finiteOrNull(readFresh('navigation.speedThroughWater', now, WIND_MAX_AGE_MS)),
      heading:
        headingTrue ??
        (headingMagnetic !== null && variation !== null
          ? normalizeAngle(headingMagnetic + variation)
          : null),
      tws: finiteOrNull(readFresh('environment.wind.speedTrue', now, WIND_MAX_AGE_MS)),
      twd: finiteOrNull(readFresh('environment.wind.directionTrue', now, WIND_MAX_AGE_MS)),
      aws: finiteOrNull(readFresh('environment.wind.speedApparent', now, WIND_MAX_AGE_MS)),
      awa: finiteOrNull(readFresh('environment.wind.angleApparent', now, WIND_MAX_AGE_MS))
    };
  }

  function isWorthKeeping(fix) {
    if (!lastSampled) {
      return true;
    }
    const elapsed = fix.time - lastSampled.time;
    if (elapsed >= intervalMs && distanceBetween(lastSampled, fix) >= MIN_MOVE_METRES) {
      return true;
    }
    if (elapsed < MIN_CHANGE_SPACING_MS) {
      return false;
    }
    const turned =
      fix.sog !== null &&
      fix.sog >= MIN_HEADING_SPEED &&
      fix.cog !== null &&
      lastSampled.cog !== null &&
      headingDifference(fix.cog, lastSampled.cog) >= HEADING_CHANGE_RAD;
    const changedSpeed =
      fix.sog !== null &&
      lastSampled.sog !== null &&
      Math.abs(fix.sog - lastSampled.sog) >= SPEED_CHANGE;
    return turned || changedSpeed;
  }

  function lastPointOf(entryId) {
    const row = db
      .prepare(
        'SELECT time, lat, lon FROM track_points WHERE entry_id = ? ORDER BY time DESC, id DESC LIMIT 1'
      )
      .get(entryId);
    return row ? { entryId, time: Date.parse(row.time), lat: row.lat, lon: row.lon } : null;
  }

  function flush(entry, now) {
    withTransaction(db, () => {
      let previous = lastWritten?.entryId === entry.id ? lastWritten : lastPointOf(entry.id);
      const startedAt = Date.parse(entry.start_time);
      const insert = db.prepare(
        `INSERT INTO track_points (entry_id, time, lat, lon, sog, cog, stw, tws, twd, aws, awa, heading)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      let added = 0;
      for (const point of pending) {
        if (point.time < startedAt || (previous && point.time <= previous.time)) {
          continue;
        }
        insert.run(
          entry.id,
          iso(point.time),
          point.lat,
          point.lon,
          point.sog,
          point.cog,
          point.stw,
          point.tws,
          point.twd,
          point.aws,
          point.awa,
          point.heading
        );
        if (previous) {
          added += distanceBetween(previous, point);
        }
        previous = { entryId: entry.id, time: point.time, lat: point.lat, lon: point.lon };
      }

      if (added > 0) {
        db.prepare(
          'UPDATE log_entries SET distance = distance + ?, updated_at = ? WHERE id = ?'
        ).run(added, iso(now), entry.id);
      }
      lastWritten = previous;
    });
    pending = [];
  }

  return {
    sample() {
      const now = clock();
      const fix = readFix(now);
      if (!fix || !isWorthKeeping(fix)) {
        return;
      }
      lastSampled = fix;
      pending.push(fix);
      pending = pending.filter((point) => point.time >= now - MAX_REFINEMENT_AGE_MS);

      const entry = db
        .prepare("SELECT id, start_time, stopped_since FROM log_entries WHERE state = 'active'")
        .get();
      if (entry && entry.stopped_since === null) {
        flush(entry, now);
      }
    }
  };
}

module.exports = { createTrackRecorder, SAMPLE_INTERVAL_MS, TRACK_DEFAULTS };
