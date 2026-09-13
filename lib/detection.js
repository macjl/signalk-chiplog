const { withTransaction } = require('./database');
const { findNearestPlace } = require('./places');
const { createObservationRecorder } = require('./observation-recorder');
const { createPropulsionTracker } = require('./propulsion-detector');
const { toPosition } = require('./rows');

const METRES_PER_SECOND_PER_KNOT = 1852 / 3600;

const TICK_INTERVAL_MS = 15 * 1000;
// Speed is averaged over this window, so a gust swinging the boat at anchor
// does not start a passage.
const SPEED_WINDOW_MS = 3 * 60 * 1000;
const MIN_SPEED_SAMPLES = 6;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const LATE_CLOSURE_MARGIN_MS = 5 * 60 * 1000;
// signalk-autostate needs about ten minutes to notice a change; raw speed
// samples older than this are no longer trusted to date one.
const MAX_REFINEMENT_AGE_MS = 20 * 60 * 1000;

// How long a Signal K value stays current after it last changed.
// signalk-autostate republishes navigation.state at least every ten minutes.
const MAX_AGE_MS = {
  'navigation.state': 20 * 60 * 1000,
  'navigation.speedOverGround': 2 * 60 * 1000,
  'navigation.position': 2 * 60 * 1000
};

const STOPPED_STATES = new Set(['moored', 'anchored', 'aground', 'not-under-way']);
const UNDERWAY_STATES = new Set([
  'sailing',
  'motoring',
  'not under command',
  'towing < 200m',
  'towing > 200m',
  'pushing',
  'fishing',
  'fishing-hampered',
  'trawling',
  'trawling-shooting',
  'trawling-hauling',
  'pilotage',
  'restricted manouverability',
  'restricted manouverability towing < 200m',
  'restricted manouverability towing > 200m',
  'restricted manouverability underwater operations',
  'constrained by draft',
  'mine clearance'
]);

const DETECTION_DEFAULTS = { stopClosureMinutes: 30, fallbackUnderwaySpeed: 1 };

function iso(ms) {
  return new Date(ms).toISOString();
}

function classifyState(state) {
  if (STOPPED_STATES.has(state)) {
    return 'stopped';
  }
  return UNDERWAY_STATES.has(state) ? 'underway' : null;
}

// A value is trusted when its timestamp changed recently by our own clock, so
// a system clock that is off — a Raspberry Pi without a real-time clock boots
// with the wrong date — does not make live data look stale. Only a value seen
// for the first time is judged against the system clock.
function createFreshnessTracker(readSelfPath) {
  const seen = new Map();

  return function readFresh(path, now, maxAge = MAX_AGE_MS[path]) {
    const node = readSelfPath(path);
    if (!node || node.value === null || node.value === undefined || !node.timestamp) {
      return undefined;
    }

    const record = seen.get(path);
    if (!record || record.timestamp !== node.timestamp) {
      let observedAt = now;
      if (!record) {
        const stamped = Date.parse(node.timestamp);
        observedAt = Math.abs(now - stamped) <= maxAge ? Math.min(now, stamped) : null;
      }
      seen.set(path, { timestamp: node.timestamp, observedAt });
    }

    const { observedAt } = seen.get(path);
    return observedAt !== null && now - observedAt <= maxAge ? node.value : undefined;
  };
}

function createSpeedTracker({ underwaySpeed, stoppedSpeed }) {
  const samples = [];
  let motion = 'unknown';
  // Contiguous streaks of raw samples, used to date and place transitions more
  // precisely than the averaged or autostate decision can.
  let lastStill = null;
  let leftStillAt = null;
  let stillSince = null;

  function prune(now) {
    while (samples.length > 0 && samples[0].time < now - SPEED_WINDOW_MS) {
      samples.shift();
    }
  }

  return {
    observe(time, sog, position) {
      samples.push({ time, sog });
      const point = { time, position };
      if (sog < stoppedSpeed) {
        lastStill = point;
        leftStillAt = null;
        stillSince = stillSince ?? point;
      } else {
        leftStillAt = leftStillAt ?? point;
        stillSince = null;
      }
    },

    motion(now) {
      prune(now);
      if (samples.length === 0) {
        motion = 'unknown';
      } else if (samples.length >= MIN_SPEED_SAMPLES) {
        const mean = samples.reduce((sum, sample) => sum + sample.sog, 0) / samples.length;
        if (mean >= underwaySpeed) {
          motion = 'underway';
        } else if (mean < stoppedSpeed) {
          motion = 'stopped';
        }
      }
      return motion;
    },

    departure(now) {
      if (!leftStillAt || now - leftStillAt.time > MAX_REFINEMENT_AGE_MS) {
        return null;
      }
      const berth = lastStill && now - lastStill.time <= MAX_REFINEMENT_AGE_MS ? lastStill : null;
      return { time: leftStillAt.time, position: berth?.position ?? leftStillAt.position };
    },

    arrival(now) {
      return stillSince && now - stillSince.time <= MAX_REFINEMENT_AGE_MS ? stillSince : null;
    }
  };
}

function createPassageDetector({ db, readSelfPath, settings, clock = Date.now }) {
  const readFresh = createFreshnessTracker(readSelfPath);
  const underwaySpeed = settings.fallbackUnderwaySpeed * METRES_PER_SECOND_PER_KNOT;
  const speeds = createSpeedTracker({ underwaySpeed, stoppedSpeed: underwaySpeed / 2 });
  const closureMs = settings.stopClosureMinutes * 60 * 1000;
  const propulsion = createPropulsionTracker({ db, readSelfPath, readFresh, settings });
  const observations = createObservationRecorder({ db, readSelfPath, readFresh, settings });

  let mode = 'fallback';
  let motion = 'unknown';
  let propulsionType = null;
  let resumed = false;

  const activeEntry = () => db.prepare("SELECT * FROM log_entries WHERE state = 'active'").get();

  function knownPlace(position) {
    return position ? findNearestPlace(db, position, settings.placeMatchRadius) : null;
  }

  function storedEnd(entry) {
    return toPosition(entry.end_lat, entry.end_lon);
  }

  function sense(now) {
    const position = readFresh('navigation.position', now);
    const current =
      position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
        ? { lat: position.latitude, lon: position.longitude }
        : null;

    const sog = readFresh('navigation.speedOverGround', now);
    if (typeof sog === 'number' && Number.isFinite(sog)) {
      speeds.observe(now, sog, current);
    }

    observations.sense(now);
    const navigationState = readFresh('navigation.state', now);
    const fromState = classifyState(navigationState);
    mode = fromState ? 'autostate' : 'fallback';
    return {
      motion: fromState ?? speeds.motion(now),
      position: current,
      propulsion: propulsion.sense(now, navigationState)
    };
  }

  // When a stopped passage gets going again, it resumed when raw speed left
  // standstill, not when the averaged or autostate decision caught up.
  function resumeTime(entry, now) {
    const moving = speeds.departure(now);
    const stoppedAt = Date.parse(entry.stopped_since);
    return moving && moving.time > stoppedAt ? moving.time : now;
  }

  function recordMovement(entry, now, position, { force = false } = {}) {
    const last = entry.last_moving_at === null ? null : Date.parse(entry.last_moving_at);
    if (!force && last !== null && now - last < HEARTBEAT_INTERVAL_MS) {
      return;
    }
    const at = position ?? storedEnd(entry);
    db.prepare(
      `UPDATE log_entries
       SET last_moving_at = ?, end_lat = ?, end_lon = ?, stopped_since = NULL, updated_at = ?
       WHERE id = ?`
    ).run(iso(now), at ? at.lat : null, at ? at.lon : null, iso(now), entry.id);
  }

  function markStopped(entry, { time, position }, now) {
    const at = position ?? storedEnd(entry);
    const stoppedAt = time < entry.start_time ? entry.start_time : time;
    db.prepare(
      `UPDATE log_entries SET stopped_since = ?, end_lat = ?, end_lon = ?, updated_at = ?
       WHERE id = ?`
    ).run(stoppedAt, at ? at.lat : null, at ? at.lon : null, iso(now), entry.id);
    return activeEntry();
  }

  function arrivalOf(entry, now, position) {
    const still = speeds.arrival(now);
    if (still && iso(still.time) >= entry.start_time) {
      return { time: iso(still.time), position: still.position ?? position };
    }
    // Without a speed streak, the last recorded movement is the best bound.
    return { time: entry.last_moving_at ?? iso(now), position: storedEnd(entry) ?? position };
  }

  function closePassage(entry, now) {
    const place = entry.end_place_name === null ? knownPlace(storedEnd(entry)) : null;
    db.prepare(
      `UPDATE log_entries
       SET state = 'closed', end_time = stopped_since, stopped_since = NULL,
           end_place_id = ?, end_place_name = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      place ? place.id : entry.end_place_id,
      place ? place.name : entry.end_place_name,
      iso(now),
      entry.id
    );
  }

  function openPassage(now, position) {
    const departure = speeds.departure(now) ?? { time: now, position };
    const previousEnd = db
      .prepare('SELECT MAX(end_time) AS endTime FROM log_entries')
      .get().endTime;
    const startTime =
      previousEnd && iso(departure.time) < previousEnd ? previousEnd : iso(departure.time);
    const start = departure.position ?? position;
    const place = knownPlace(start);

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO log_entries (
         state, start_time, start_lat, start_lon, start_place_id, start_place_name,
         last_moving_at, end_lat, end_lon, created_at, updated_at
       ) VALUES ('active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        startTime,
        start ? start.lat : null,
        start ? start.lon : null,
        place ? place.id : null,
        place ? place.name : null,
        iso(now),
        position ? position.lat : null,
        position ? position.lon : null,
        iso(now),
        iso(now)
      );
    return Number(lastInsertRowid);
  }

  function step(now, current, position, previous) {
    let entry = activeEntry();
    let resumedAt = null;
    let opened = null;
    let closed = null;

    // A passage left open across a restart with no movement recorded for longer
    // than the tolerance ended while the plugin was not running — typically
    // power switched off on arrival.
    if (!resumed) {
      resumed = true;
      if (entry && entry.stopped_since === null) {
        const lastMoving = entry.last_moving_at ?? entry.start_time;
        if (now - Date.parse(lastMoving) >= closureMs) {
          entry = markStopped(entry, { time: lastMoving, position: storedEnd(entry) }, now);
        }
      }
    }

    if (entry && entry.stopped_since === null) {
      if (current === 'underway') {
        recordMovement(entry, now, position);
      } else if (current === 'stopped') {
        entry = markStopped(entry, arrivalOf(entry, now, position), now);
      }
    }

    if (entry && entry.stopped_since !== null) {
      const stoppedFor = now - Date.parse(entry.stopped_since);
      if (stoppedFor >= closureMs) {
        closePassage(entry, now);
        // Closed well after the tolerance ran out means the plugin was not
        // running: current conditions say nothing about that arrival.
        closed = { id: entry.id, late: stoppedFor > closureMs + LATE_CLOSURE_MARGIN_MS };
        entry = null;
      } else if (current === 'underway') {
        resumedAt = resumeTime(entry, now);
        recordMovement(entry, now, position, { force: true });
      }
    }

    // Only a transition opens a passage: an entry closed by hand while still
    // moving must not be reopened on the next tick.
    if (!entry && current === 'underway' && previous !== 'underway') {
      opened = openPassage(now, position);
    }

    return { resumedAt, opened, closed };
  }

  return {
    tick() {
      const now = clock();
      const sensed = sense(now);
      const previous = motion;
      withTransaction(db, () => {
        const outcome = step(now, sensed.motion, sensed.position, previous);
        propulsion.reconcile(now, sensed.propulsion, outcome);
        observations.afterDetection(now, outcome);
      });
      motion = sensed.motion;
      propulsionType = motion === 'underway' ? sensed.propulsion.type : null;
      return {
        mode,
        motion,
        propulsion: propulsionType,
        activeEntryId: activeEntry()?.id ?? null
      };
    },
    mode: () => mode,
    motion: () => motion,
    propulsion: () => propulsionType,
    observeEvent: (entryId, time) => observations.recordEvent(entryId, time, clock())
  };
}

module.exports = {
  createFreshnessTracker,
  createPassageDetector,
  DETECTION_DEFAULTS,
  MAX_REFINEMENT_AGE_MS,
  TICK_INTERVAL_MS
};
