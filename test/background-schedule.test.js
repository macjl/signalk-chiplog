const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { createBackgroundSchedule } = require('../lib/background-schedule');

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// A resolver whose answers the test controls: each call waits for `release`.
function fakeForecaster(result = { outcome: 'idle', retryInMs: 60 * 60 * 1000 }) {
  const resolver = {
    calls: 0,
    stopped: false,
    pending: [],
    resolveNext() {
      resolver.calls += 1;
      return new Promise((resolve) => resolver.pending.push(() => resolve(result)));
    },
    release() {
      resolver.pending.splice(0).forEach((resolve) => resolve());
    },
    stop() {
      resolver.stopped = true;
    }
  };
  return resolver;
}

describe('background schedule', () => {
  let schedule;
  const logs = [];
  const start = (resolver, firstDelayMs = 60 * 60 * 1000) => {
    schedule = createBackgroundSchedule({
      label: 'Test',
      resolver,
      log: (level, message) => logs.push({ level, message }),
      firstDelayMs
    });
    return schedule;
  };

  afterEach(() => schedule?.stop());

  it('runs after the first delay, then as the resolver says', async () => {
    const resolver = fakeForecaster({ outcome: 'fetched', retryInMs: 0 });
    start(resolver, 10);
    assert.equal(resolver.calls, 0);
    await tick(30);
    assert.equal(resolver.calls, 1);
    resolver.release();
    await tick();
    assert.equal(resolver.calls, 2, 'the next one straight away');
  });

  it('runs at once when nudged, cutting a long wait short', async () => {
    const resolver = fakeForecaster();
    start(resolver);
    await tick();
    assert.equal(resolver.calls, 0);

    schedule.nudge();
    await tick();
    assert.equal(resolver.calls, 1);

    resolver.release();
    await tick();
    assert.equal(resolver.calls, 1, 'back to the long wait');
  });

  it('runs again after a fetch in flight when nudged during it, never twice at once', async () => {
    const resolver = fakeForecaster();
    start(resolver, 0);
    await tick();
    assert.equal(resolver.calls, 1);

    schedule.nudge();
    schedule.nudge();
    await tick();
    assert.equal(resolver.calls, 1, 'not alongside the one in flight');

    resolver.release();
    await tick();
    assert.equal(resolver.calls, 2, 'once more, right after');
    resolver.release();
    await tick();
    assert.equal(resolver.calls, 2);
  });

  it('logs a failure and waits the delay it gives', async () => {
    const resolver = fakeForecaster({
      outcome: 'failed',
      error: new Error('fetch failed'),
      retryInMs: 10 * 60 * 1000
    });
    start(resolver, 0);
    await tick();
    resolver.release();
    await tick();
    assert.equal(resolver.calls, 1);
    assert.match(logs.at(-1).message, /Test unavailable, retrying in 10 min: fetch failed/);
  });

  it('stops the resolver, and neither runs nor reschedules afterwards', async () => {
    const resolver = fakeForecaster({ outcome: 'fetched', retryInMs: 0 });
    start(resolver, 0);
    await tick();
    schedule.stop();
    assert.ok(resolver.stopped);
    resolver.release();
    schedule.nudge();
    await tick();
    assert.equal(resolver.calls, 1);
  });
});
