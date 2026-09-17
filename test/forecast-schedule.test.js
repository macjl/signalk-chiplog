const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { createForecastSchedule } = require('../lib/forecast-schedule');

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// A forecaster whose answers the test controls: each call waits for `release`.
function fakeForecaster(result = { outcome: 'idle', retryInMs: 60 * 60 * 1000 }) {
  const forecaster = {
    calls: 0,
    stopped: false,
    pending: [],
    resolveNext() {
      forecaster.calls += 1;
      return new Promise((resolve) => forecaster.pending.push(() => resolve(result)));
    },
    release() {
      forecaster.pending.splice(0).forEach((resolve) => resolve());
    },
    stop() {
      forecaster.stopped = true;
    }
  };
  return forecaster;
}

describe('forecast schedule', () => {
  let schedule;
  const logs = [];
  const start = (forecaster, firstDelayMs = 60 * 60 * 1000) => {
    schedule = createForecastSchedule({
      label: 'Test',
      forecaster,
      log: (level, message) => logs.push({ level, message }),
      firstDelayMs
    });
    return schedule;
  };

  afterEach(() => schedule?.stop());

  it('runs after the first delay, then as the forecaster says', async () => {
    const forecaster = fakeForecaster({ outcome: 'fetched', retryInMs: 0 });
    start(forecaster, 10);
    assert.equal(forecaster.calls, 0);
    await tick(30);
    assert.equal(forecaster.calls, 1);
    forecaster.release();
    await tick();
    assert.equal(forecaster.calls, 2, 'the next one straight away');
  });

  it('runs at once when nudged, cutting a long wait short', async () => {
    const forecaster = fakeForecaster();
    start(forecaster);
    await tick();
    assert.equal(forecaster.calls, 0);

    schedule.nudge();
    await tick();
    assert.equal(forecaster.calls, 1);

    forecaster.release();
    await tick();
    assert.equal(forecaster.calls, 1, 'back to the long wait');
  });

  it('runs again after a fetch in flight when nudged during it, never twice at once', async () => {
    const forecaster = fakeForecaster();
    start(forecaster, 0);
    await tick();
    assert.equal(forecaster.calls, 1);

    schedule.nudge();
    schedule.nudge();
    await tick();
    assert.equal(forecaster.calls, 1, 'not alongside the one in flight');

    forecaster.release();
    await tick();
    assert.equal(forecaster.calls, 2, 'once more, right after');
    forecaster.release();
    await tick();
    assert.equal(forecaster.calls, 2);
  });

  it('logs a failure and waits the delay it gives', async () => {
    const forecaster = fakeForecaster({
      outcome: 'failed',
      error: new Error('fetch failed'),
      retryInMs: 10 * 60 * 1000
    });
    start(forecaster, 0);
    await tick();
    forecaster.release();
    await tick();
    assert.equal(forecaster.calls, 1);
    assert.match(
      logs.at(-1).message,
      /Test forecast unavailable, retrying in 10 min: fetch failed/
    );
  });

  it('stops the forecaster, and neither runs nor reschedules afterwards', async () => {
    const forecaster = fakeForecaster({ outcome: 'fetched', retryInMs: 0 });
    start(forecaster, 0);
    await tick();
    schedule.stop();
    assert.ok(forecaster.stopped);
    forecaster.release();
    schedule.nudge();
    await tick();
    assert.equal(forecaster.calls, 1);
  });
});
