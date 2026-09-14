const { writeUsbExport } = require('./export');

// SPEC §4.5: the abandon-ship copy is kept current without anyone thinking of
// it — every few minutes, and as soon as a passage ends.
const USB_EXPORT_DEFAULTS = { usbExportIntervalMinutes: 15, usbExportOnArrival: true };

const CHECK_INTERVAL_MS = 30 * 1000;
// Leaves the drive time to be mounted after the host boots.
const FIRST_EXPORT_DELAY_MS = 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

function createUsbExportScheduler({
  db,
  settings,
  clock = Date.now,
  write = writeUsbExport,
  log = () => {}
}) {
  const intervalMs = settings.usbExportIntervalMinutes * 60 * 1000;
  let nextDueAt = intervalMs > 0 ? clock() + FIRST_EXPORT_DELAY_MS : null;
  let lastActiveEntryId;
  let current = null;
  let queued = null;
  let stopped = false;
  let lastSuccess = null;
  let lastError = null;

  async function perform(reason) {
    const startedAt = clock();
    try {
      const result = await write(db, settings.usbExportPath, iso(startedAt));
      if (lastError) {
        log('info', `USB copy written again (${reason})`);
      }
      lastSuccess = {
        at: iso(clock()),
        reason,
        entries: result.entries,
        written: result.written,
        unchanged: result.unchanged,
        removed: result.removed.length
      };
      lastError = null;
      return result;
    } catch (err) {
      if (stopped) {
        throw err;
      }
      // A missing drive is reported once, not every quarter of an hour.
      if (!lastError || lastError.message !== err.message) {
        log('error', `USB copy failed (${reason}): ${err.message}`);
      }
      lastError = { at: iso(clock()), reason, code: err.code ?? null, message: err.message };
      throw err;
    }
  }

  // One write at a time: a request while one runs is served by a single write
  // after it, which then includes whatever changed meanwhile.
  function run(reason) {
    if (!settings.usbExportPath) {
      return Promise.resolve(null);
    }
    if (!current) {
      current = perform(reason).finally(() => {
        current = null;
      });
      return current;
    }
    queued ??= current
      .catch(() => {})
      .then(() => {
        queued = null;
        return run(reason);
      });
    return queued;
  }

  const background = (reason) => run(reason).catch(() => {});

  return {
    run,

    // Called every few seconds.
    tick() {
      if (stopped || nextDueAt === null || !settings.usbExportPath) {
        return;
      }
      const now = clock();
      if (now >= nextDueAt) {
        nextDueAt = now + intervalMs;
        background('scheduled');
      }
    },

    // Called with each detection outcome: the open passage going away, or
    // giving way to another, is an arrival.
    afterDetection({ activeEntryId }) {
      const previous = lastActiveEntryId;
      lastActiveEntryId = activeEntryId;
      if (
        !stopped &&
        settings.usbExportOnArrival &&
        previous !== undefined &&
        previous !== null &&
        previous !== activeEntryId
      ) {
        background('arrival');
      }
    },

    status() {
      return {
        configured: Boolean(settings.usbExportPath),
        intervalMinutes: settings.usbExportIntervalMinutes,
        onArrival: settings.usbExportOnArrival,
        running: current !== null,
        nextAt: settings.usbExportPath && nextDueAt !== null ? iso(nextDueAt) : null,
        lastSuccess,
        lastError
      };
    },

    stop() {
      stopped = true;
    }
  };
}

module.exports = { createUsbExportScheduler, USB_EXPORT_DEFAULTS, CHECK_INTERVAL_MS };
