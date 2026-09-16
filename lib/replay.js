const { createPassageDetector, DETECTION_DEFAULTS, TICK_INTERVAL_MS } = require('./detection');
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

// The finest step the loop needs: sampling and event watching both run every
// second live (SAMPLE_INTERVAL_MS === CHECK_INTERVAL_MS), detection every 15.
const STEP_MS = SAMPLE_INTERVAL_MS;
// How often onProgress is called and control is yielded back to the event
// loop -- fine enough for a responsive progress bar, coarse enough that a
// multi-week replay is not dominated by callback/microtask overhead.
const PROGRESS_INTERVAL_MS = 60 * 1000;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
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
// The caller is responsible for refusing a range that overlaps passages
// already on record -- this only ever adds new ones, it never checks.
async function runReplay({ db, settings, history, from, to, onProgress, signal }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
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
  // and event watching join in from the first second after.
  detector.tick();
  let nextTickAt = fromMs + TICK_INTERVAL_MS;
  let sinceProgress = 0;
  onProgress?.(now, toMs);

  while (now < toMs) {
    if (signal?.aborted) {
      throw new DOMException('Replay cancelled', 'AbortError');
    }
    now = Math.min(now + STEP_MS, toMs);
    recorder.sample();
    watcher.check();
    if (now >= nextTickAt) {
      detector.tick();
      nextTickAt += TICK_INTERVAL_MS;
    }
    sinceProgress += STEP_MS;
    if (sinceProgress >= PROGRESS_INTERVAL_MS || now === toMs) {
      sinceProgress = 0;
      onProgress?.(now, toMs);
      await yieldToEventLoop();
    }
  }

  return { from, to };
}

module.exports = { runReplay, REPLAY_DEFAULTS };
