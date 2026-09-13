const { createFreshnessTracker } = require('./detection');
const { distanceBetween } = require('./places');

const METRES_PER_SECOND_PER_KNOT = 1852 / 3600;

const EVENT_DEFAULTS = { windSpeedThresholds: [20, 30], pressureDropThreshold: 4 };

const CHECK_INTERVAL_MS = 1000;

// Any notification reaching these states is critical, whatever its path.
const CRITICAL_STATES = new Set(['alarm', 'emergency']);
const NOTIFICATION_METADATA_KEYS = new Set([
  'meta',
  'values',
  '$source',
  'timestamp',
  'pgn',
  'sentence'
]);

const DISENGAGED_AUTOPILOT_STATES = new Set(['standby', 'off']);

// An anchor alarm goes off between passages. Still this close to where the
// last passage ended, the vessel is at that passage's destination.
const STILL_AT_ARRIVAL_METRES = 1852;

const POSITION_MAX_AGE_MS = 2 * 60 * 1000;
// Thresholds compare the average over this window, so a gust does not count.
const WIND_WINDOW_MS = 2 * 60 * 1000;
const MIN_WIND_COVERAGE_MS = 60 * 1000;
const WIND_MAX_AGE_MS = 2 * 60 * 1000;
const PRESSURE_WINDOW_MS = 3 * 60 * 60 * 1000;
const PRESSURE_SAMPLE_INTERVAL_MS = 60 * 1000;
const PRESSURE_MAX_AGE_MS = 15 * 60 * 1000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function collectNotifications(node, path, found, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) {
    return;
  }
  if ('value' in node) {
    const { value } = node;
    if (value === null || (typeof value === 'object' && typeof value.state === 'string')) {
      found.set(path, value);
    }
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (!NOTIFICATION_METADATA_KEYS.has(key)) {
      collectNotifications(child, `${path}.${key}`, found, depth + 1);
    }
  }
}

function createEventWatcher({ db, readSelfPath, settings, observe, clock = Date.now }) {
  const readFresh = createFreshnessTracker(readSelfPath);

  const seenNotifications = new Map();
  const loggedNotifications = new Map();
  let autopilot = null;
  const windSamples = [];
  const windAbove = new Map();
  const pressureSamples = [];
  let pressureFalling = false;

  function entryFor(type, position) {
    const active = db.prepare("SELECT id FROM log_entries WHERE state = 'active'").get();
    if (active) {
      return active.id;
    }
    if (type === 'autopilot' || !position) {
      return null;
    }
    const last = db
      .prepare(
        `SELECT id, end_lat, end_lon FROM log_entries WHERE state = 'closed'
         ORDER BY end_time DESC, id DESC LIMIT 1`
      )
      .get();
    const stillThere =
      last &&
      last.end_lat !== null &&
      distanceBetween(position, { lat: last.end_lat, lon: last.end_lon }) <=
        STILL_AT_ARRIVAL_METRES;
    return stillThere ? last.id : null;
  }

  function logEvent(cycle, type, subtype, { comment = null, payload, snapshot }) {
    const entryId = entryFor(type, cycle.position);
    if (entryId === null) {
      return false;
    }
    const time = iso(cycle.now);
    db.prepare(
      `INSERT INTO events (entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?)`
    ).run(
      entryId,
      time,
      type,
      subtype,
      cycle.position ? cycle.position.lat : null,
      cycle.position ? cycle.position.lon : null,
      comment,
      JSON.stringify(payload),
      time
    );
    if (snapshot) {
      cycle.snapshots.add(entryId);
    }
    return true;
  }

  // What was last written for a notification, read from the log the first
  // time it is seen, so a restart neither repeats an alarm nor forgets that
  // one was open.
  function lastLoggedState(path) {
    if (!loggedNotifications.has(path)) {
      const row = db
        .prepare(
          `SELECT payload FROM events WHERE type = 'sk_alarm' AND subtype = ?
           ORDER BY time DESC, id DESC LIMIT 1`
        )
        .get(path);
      loggedNotifications.set(path, row ? JSON.parse(row.payload).state : null);
    }
    return loggedNotifications.get(path);
  }

  function checkNotifications(cycle) {
    const current = new Map();
    collectNotifications(readSelfPath('notifications'), 'notifications', current);
    for (const path of seenNotifications.keys()) {
      if (!current.has(path)) {
        current.set(path, null);
      }
    }

    for (const [path, value] of current) {
      const state = value?.state ?? 'normal';
      if (seenNotifications.get(path) === state) {
        continue;
      }
      seenNotifications.set(path, state);

      const logged = lastLoggedState(path);
      const critical = CRITICAL_STATES.has(state);
      // Log a critical state not yet logged, or the end of one that was; a
      // clearing whose alarm never made it into the log is not news.
      const worthLogging = critical ? logged !== state : CRITICAL_STATES.has(logged);
      if (!worthLogging) {
        continue;
      }
      const message = value?.message ?? null;
      if (
        logEvent(cycle, 'sk_alarm', path, {
          comment: message,
          payload: { state, message },
          snapshot: critical
        })
      ) {
        loggedNotifications.set(path, state);
      }
    }
  }

  function readAutopilotTarget() {
    const target = readSelfPath('steering.autopilot.target')?.value;
    if (isFiniteNumber(target)) {
      return target;
    }
    const byKind = {};
    for (const kind of ['headingTrue', 'headingMagnetic', 'windAngleApparent', 'windAngleTrue']) {
      const value = readSelfPath(`steering.autopilot.target.${kind}`)?.value;
      if (isFiniteNumber(value)) {
        byKind[kind] = value;
      }
    }
    return Object.keys(byKind).length > 0 ? byKind : null;
  }

  // The Autopilot API publishes `engaged`; older autopilot plugins only a
  // state such as auto, wind or standby.
  function readAutopilot() {
    const state = readSelfPath('steering.autopilot.state')?.value;
    const mode = readSelfPath('steering.autopilot.mode')?.value;
    const engagedValue = readSelfPath('steering.autopilot.engaged')?.value;

    let engaged = typeof engagedValue === 'boolean' ? engagedValue : null;
    if (engaged === null && typeof state === 'string' && state !== 'alarm') {
      engaged = !DISENGAGED_AUTOPILOT_STATES.has(state);
    }
    if (engaged === null) {
      return null;
    }
    return {
      engaged,
      mode: typeof mode === 'string' ? mode : null,
      state: typeof state === 'string' ? state : null
    };
  }

  function checkAutopilot(cycle) {
    const pilot = readAutopilot();
    if (!pilot) {
      return;
    }
    const activity = pilot.mode ?? pilot.state;
    const previous = autopilot;
    autopilot = { engaged: pilot.engaged, activity };

    let subtype = null;
    if (previous === null) {
      const last = db
        .prepare(
          "SELECT subtype FROM events WHERE type = 'autopilot' ORDER BY time DESC, id DESC LIMIT 1"
        )
        .get();
      if (pilot.engaged && (!last || last.subtype === 'disengaged')) {
        subtype = 'engaged';
      } else if (!pilot.engaged && last && last.subtype !== 'disengaged') {
        subtype = 'disengaged';
      }
    } else if (pilot.engaged !== previous.engaged) {
      subtype = pilot.engaged ? 'engaged' : 'disengaged';
    } else if (pilot.engaged && activity !== previous.activity) {
      subtype = 'mode_changed';
    }

    if (subtype) {
      // The last target lingers in the data model after disengaging.
      const target = pilot.engaged ? readAutopilotTarget() : null;
      logEvent(cycle, 'autopilot', subtype, {
        payload: { mode: pilot.mode, state: pilot.state, target },
        snapshot: false
      });
    }
  }

  function checkWind(cycle) {
    const speed = readFresh('environment.wind.speedTrue', cycle.now, WIND_MAX_AGE_MS);
    if (isFiniteNumber(speed)) {
      windSamples.push({ time: cycle.now, speed });
    }
    while (windSamples.length > 0 && windSamples[0].time <= cycle.now - WIND_WINDOW_MS) {
      windSamples.shift();
    }
    if (windSamples.length === 0 || cycle.now - windSamples[0].time < MIN_WIND_COVERAGE_MS) {
      return;
    }
    const mean = windSamples.reduce((sum, sample) => sum + sample.speed, 0) / windSamples.length;

    for (const knots of settings.windSpeedThresholds) {
      const threshold = knots * METRES_PER_SECOND_PER_KNOT;
      const clearsBelow = threshold - Math.max(2 * METRES_PER_SECOND_PER_KNOT, 0.1 * threshold);
      const wasAbove = windAbove.get(knots);
      let isAbove = wasAbove;
      if (mean >= threshold) {
        isAbove = true;
      } else if (mean < clearsBelow) {
        isAbove = false;
      }
      if (isAbove === undefined) {
        continue;
      }
      windAbove.set(knots, isAbove);
      // The first reading only sets where the wind stands: strong wind already
      // blowing when the plugin starts is a condition, not a crossing.
      if (wasAbove !== undefined && wasAbove !== isAbove) {
        logEvent(cycle, 'weather_threshold', isAbove ? 'wind_above' : 'wind_below', {
          payload: { threshold, windSpeed: mean },
          snapshot: true
        });
      }
    }
  }

  function checkPressure(cycle) {
    if (!settings.pressureDropThreshold) {
      return;
    }
    const pressure = readFresh('environment.outside.pressure', cycle.now, PRESSURE_MAX_AGE_MS);
    const latest = pressureSamples.at(-1);
    if (
      isFiniteNumber(pressure) &&
      (!latest || cycle.now - latest.time >= PRESSURE_SAMPLE_INTERVAL_MS)
    ) {
      pressureSamples.push({ time: cycle.now, pressure });
    }
    while (
      pressureSamples.length > 1 &&
      pressureSamples[1].time <= cycle.now - PRESSURE_WINDOW_MS
    ) {
      pressureSamples.shift();
    }

    const current = pressureSamples.at(-1);
    const reference = pressureSamples[0];
    if (
      !current ||
      cycle.now - current.time > PRESSURE_MAX_AGE_MS ||
      current.time - reference.time < PRESSURE_WINDOW_MS
    ) {
      return;
    }

    const drop = reference.pressure - current.pressure;
    const threshold = settings.pressureDropThreshold * 100;
    if (!pressureFalling && drop >= threshold) {
      pressureFalling = true;
      logEvent(cycle, 'weather_threshold', 'pressure_drop', {
        payload: { drop, over: PRESSURE_WINDOW_MS / 1000, pressure: current.pressure },
        snapshot: true
      });
    } else if (pressureFalling && drop < threshold / 2) {
      pressureFalling = false;
    }
  }

  return {
    check() {
      const now = clock();
      const fix = readFresh('navigation.position', now, POSITION_MAX_AGE_MS);
      const position =
        fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)
          ? { lat: fix.latitude, lon: fix.longitude }
          : null;
      const cycle = { now, position, snapshots: new Set() };

      checkNotifications(cycle);
      checkAutopilot(cycle);
      checkWind(cycle);
      checkPressure(cycle);

      for (const entryId of cycle.snapshots) {
        observe(entryId, iso(now));
      }
    }
  };
}

module.exports = { createEventWatcher, EVENT_DEFAULTS, CHECK_INTERVAL_MS };
