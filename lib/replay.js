const { withTransaction } = require('./database');
const {
  createPassageDetector,
  DETECTION_DEFAULTS,
  MAX_REFINEMENT_AGE_MS,
  METRES_PER_SECOND_PER_KNOT,
  TICK_INTERVAL_MS
} = require('./detection');
const { createEventWatcher, EVENT_DEFAULTS } = require('./event-watcher');
const { createTrackRecorder, SAMPLE_INTERVAL_MS, TRACK_DEFAULTS } = require('./track-recorder');
const { PROPULSION_DEFAULTS } = require('./propulsion-detector');
const { OBSERVATION_DEFAULTS } = require('./observation-recorder');

const REPLAY_DEFAULTS = {
  ...DETECTION_DEFAULTS,
  ...PROPULSION_DEFAULTS,
  ...OBSERVATION_DEFAULTS,
  ...TRACK_DEFAULTS,
  ...EVENT_DEFAULTS,
  placeMatchRadius: 200
};

// How much simulated time runs between two yields back to the event loop --
// each one a progress report and a single database transaction, so a long
// replay commits (and syncs the disk) once per slice instead of once per
// detection tick and track point. Live code cannot run inside one: the slice
// is synchronous.
const SLICE_MS = 10 * 60 * 1000;

// A window of motion is replayed from this long before it, so detection has
// the raw speeds it dates a departure from (MAX_REFINEMENT_AGE_MS) and its
// averages are warm by the time the vessel moves...
const WINDOW_LEAD_MS = MAX_REFINEMENT_AGE_MS + 10 * 60 * 1000;
// ...and until this long after the stop-closure delay, covering detection's
// late-closure margin and signalk-autostate's lag.
const WINDOW_TRAIL_EXTRA_MS = 25 * 60 * 1000;
// A passage still open when its window ends is followed this much further at
// a time, until it closes.
const WINDOW_EXTENSION_MS = 6 * 60 * 60 * 1000;
// History is loaded as one value per track interval, bounded so detection's
// speed average and freshness rules still see enough readings.
const MAX_BUCKET_MS = 60 * 1000;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function checkAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Replay cancelled', 'AbortError');
  }
}

// Drives the same detection/propulsion/observation/track/event pipeline used
// live (index.js), but against historical Signal K data instead of the
// server's current values, and as fast as the database and `history` allow
// instead of once every real second. `history(path, atMs)` must behave like
// `app.getSelfPath(path)` would have at that historical instant -- the last
// value received at or before it, `undefined` if none yet -- so every
// freshness and staleness rule in the detector applies unchanged. Reuses the
// exact modules live detection uses, unmodified: a reconstructed passage is
// one the plugin would have logged had it been running at the time.
//
// `stepMs` is how often track sampling and event watching run -- every
// second live; detection still ticks every 15 s. Reaching `to`, `extend(toMs)`
// may answer a later end to carry on to (after loading its history).
//
// The caller is responsible for refusing a range that overlaps passages
// already on record -- this only ever adds new ones, it never checks.
async function runReplay({
  db,
  settings,
  history,
  from,
  to,
  stepMs = SAMPLE_INTERVAL_MS,
  extend,
  onProgress,
  signal
}) {
  const fromMs = Date.parse(from);
  let toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new RangeError('replay requires from < to');
  }
  const merged = { ...REPLAY_DEFAULTS, ...settings };

  let now = fromMs;
  const readSelfPath = (path) => history(path, now);
  const clock = () => now;

  const detector = createPassageDetector({ db, readSelfPath, settings: merged, clock });
  const recorder = createTrackRecorder({ db, readSelfPath, settings: merged, clock });
  const watcher = createEventWatcher({
    db,
    readSelfPath,
    settings: merged,
    clock,
    observe: (entryId, time) => detector.observeEvent(entryId, time)
  });

  // Mirrors plugin.start: one detection tick right away, then track sampling
  // and event watching join in from the first step after.
  withTransaction(db, () => detector.tick());
  let nextTickAt = fromMs + TICK_INTERVAL_MS;
  onProgress?.(now, toMs);

  for (;;) {
    while (now < toMs) {
      checkAborted(signal);
      const sliceEnd = Math.min(now + SLICE_MS, toMs);
      withTransaction(db, () => {
        while (now < sliceEnd) {
          now = Math.min(now + stepMs, sliceEnd);
          recorder.sample();
          watcher.check();
          if (now >= nextTickAt) {
            detector.tick();
            nextTickAt += TICK_INTERVAL_MS;
          }
        }
      });
      onProgress?.(now, toMs);
      await yieldToEventLoop();
    }
    const further = extend ? await extend(toMs) : null;
    if (!(further > toMs)) {
      break;
    }
    toMs = further;
  }

  return { from, to: new Date(toMs).toISOString() };
}

// The stretches of [fromMs, toMs] worth replaying, from the intervals a
// motion scan found: each widened by the lead and trail above, overlapping
// ones merged. Between two windows the vessel sat still long enough for any
// passage to have closed, so skipping that time loses nothing detection would
// have logged -- only weather events at anchor.
function planWindows(intervals, settings, fromMs, toMs) {
  const trailMs = settings.stopClosureMinutes * 60 * 1000 + WINDOW_TRAIL_EXTRA_MS;
  const windows = [];
  for (const { from, to } of [...intervals].sort((a, b) => a.from - b.from)) {
    const start = Math.max(fromMs, from - WINDOW_LEAD_MS);
    const end = Math.min(toMs, to + trailMs);
    if (end <= start) {
      continue;
    }
    const last = windows.at(-1);
    if (last && start <= last.to) {
      last.to = Math.max(last.to, end);
    } else {
      windows.push({ from: start, to: end });
    }
  }
  return windows;
}

function hasActivePassage(db) {
  return Boolean(db.prepare("SELECT 1 FROM log_entries WHERE state = 'active' LIMIT 1").get());
}

// A whole retrospective range, the way `history` (lib/influx-history.js)
// allows it to be fast: a light scan of the range for when the vessel moved,
// then each window of motion loaded -- one value per track interval -- and
// replayed on its own, as if the plugin had been started at its beginning.
// `onPhase` reports 'scanning', then 'replaying'; `onProgress(nowMs, toMs)`
// how far through the range either has got.
async function runWindowedReplay({ db, settings, history, from, to, onPhase, onProgress, signal }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new RangeError('replay requires from < to');
  }
  const merged = { ...REPLAY_DEFAULTS, ...settings };
  const bucketMs = Math.min(
    MAX_BUCKET_MS,
    Math.max(SAMPLE_INTERVAL_MS, Math.round(merged.trackIntervalSeconds * 1000))
  );
  const stepMs = Math.min(bucketMs, TICK_INTERVAL_MS);
  const report = (nowMs) => onProgress?.(nowMs, toMs);

  onPhase?.('scanning');
  report(fromMs);
  const stoppedSpeed = (merged.fallbackUnderwaySpeed * METRES_PER_SECOND_PER_KNOT) / 2;
  const intervals = await history.scanMotion(fromMs, toMs, { stoppedSpeed }, report);
  const windows = planWindows(intervals, merged, fromMs, toMs);

  onPhase?.('replaying');
  report(fromMs);
  let reachedMs = fromMs;
  try {
    for (const window of windows) {
      if (window.to <= reachedMs) {
        continue;
      }
      checkAborted(signal);
      const startMs = Math.max(window.from, reachedMs);
      report(startMs);
      history.clear();
      await history.preload(startMs, window.to, null, { bucketMs });
      const done = await runReplay({
        db,
        settings: merged,
        history: history.readSelfPath,
        from: new Date(startMs).toISOString(),
        to: new Date(window.to).toISOString(),
        stepMs,
        signal,
        onProgress: report,
        extend: async (endMs) => {
          if (endMs >= toMs || !hasActivePassage(db)) {
            return null;
          }
          const further = Math.min(endMs + WINDOW_EXTENSION_MS, toMs);
          await history.preload(endMs, further, null, { bucketMs });
          return further;
        }
      });
      reachedMs = Date.parse(done.to);
    }
  } finally {
    history.clear();
  }
  report(toMs);

  return { from, to, windows: windows.length };
}

module.exports = { runReplay, runWindowedReplay, planWindows, REPLAY_DEFAULTS };
