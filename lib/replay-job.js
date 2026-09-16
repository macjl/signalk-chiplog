const { conflict, badRequest } = require('./errors');
const { createInfluxHistory } = require('./influx-history');
const { runReplay } = require('./replay');

const iso = (ms) => new Date(ms).toISOString();

// One reconstruction at a time, run in the background: POST /replay starts
// it and returns immediately, GET /replay polls status() for progress.
function createReplayJob({
  db,
  settings,
  app,
  clock = Date.now,
  log = () => {},
  fetch = globalThis.fetch
}) {
  let current = null;
  let lastResult = null;
  let lastError = null;

  function overlapsExisting(from, to) {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM log_entries
           WHERE start_time < ? AND (end_time IS NULL OR end_time > ?) LIMIT 1`
        )
        .get(to, from)
    );
  }

  async function perform(from, to, signal) {
    const history = createInfluxHistory({
      protocol: settings.influxProtocol,
      host: settings.influxHost,
      port: settings.influxPort,
      database: settings.influxDatabase,
      username: settings.influxUsername,
      password: settings.influxPassword,
      selfContext: app.selfContext,
      fetch
    });
    try {
      await history.preload(Date.parse(from), Date.parse(to));
      await runReplay({
        db,
        settings,
        history: history.readSelfPath,
        from,
        to,
        signal,
        onProgress: (nowMs) => {
          if (current) {
            current.now = iso(nowMs);
          }
        }
      });
      lastResult = { at: iso(clock()), from, to };
    } catch (err) {
      if (err.name === 'AbortError') {
        lastResult = { at: iso(clock()), from, to, cancelled: true };
      } else {
        lastError = { at: iso(clock()), from, to, message: err.message };
        log('error', `Retrospective replay failed (${from} to ${to}): ${err.message}`);
      }
    } finally {
      current = null;
    }
  }

  return {
    start(from, to) {
      if (!settings.influxHost || !settings.influxDatabase) {
        throw badRequest('Configure the InfluxDB connection before running a replay');
      }
      if (current) {
        throw conflict('replay_running', 'A retrospective replay is already running');
      }
      if (overlapsExisting(from, to)) {
        throw conflict(
          'replay_overlaps',
          'This range overlaps passages already on record; nothing was reconstructed'
        );
      }
      const controller = new AbortController();
      current = { from, to, startedAt: iso(clock()), now: from, controller };
      lastError = null;
      perform(from, to, controller.signal);
      return { from, to };
    },

    cancel() {
      if (!current) {
        return false;
      }
      current.controller.abort();
      return true;
    },

    status() {
      return {
        configured: Boolean(settings.influxHost && settings.influxDatabase),
        running: current !== null,
        progress: current && { from: current.from, to: current.to, now: current.now },
        lastResult,
        lastError
      };
    }
  };
}

module.exports = { createReplayJob };
