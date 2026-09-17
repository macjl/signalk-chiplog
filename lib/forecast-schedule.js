// Runs a departure forecaster (tide, weather) as its own chain of timeouts:
// each `resolveNext()` says when the next is due. `nudge()` runs it now --
// when a passage opens, rather than leaving it to the idle poll or a retry
// delay. A nudge during a fetch runs it again as soon as that one ends,
// never a second chain alongside.

const ERROR_RETRY_MS = 5 * 60 * 1000;

function createForecastSchedule({ label, forecaster, log, firstDelayMs }) {
  let timer = null;
  let running = false;
  let nudged = false;
  let stopped = false;

  function schedule(delayMs) {
    clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  }

  async function run() {
    timer = null;
    running = true;
    nudged = false;
    let result;
    try {
      result = await forecaster.resolveNext();
    } catch (err) {
      log('error', `${label} forecast failed: ${err.stack ?? err}`);
      result = { retryInMs: ERROR_RETRY_MS };
    }
    running = false;
    if (stopped || result.outcome === 'stopped') {
      return;
    }
    if (result.outcome === 'failed') {
      // Expected whenever the boat is out of reach of a network.
      log(
        'debug',
        `${label} forecast unavailable, retrying in ${Math.round(result.retryInMs / 60000)} min: ${result.error.message}`
      );
    }
    schedule(nudged ? 0 : result.retryInMs);
  }

  schedule(firstDelayMs);

  return {
    nudge() {
      if (stopped) {
        return;
      }
      if (running) {
        nudged = true;
      } else {
        schedule(0);
      }
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      forecaster.stop();
    }
  };
}

module.exports = { createForecastSchedule };
