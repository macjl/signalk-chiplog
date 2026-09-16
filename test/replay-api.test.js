const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { startServer } = require('./helpers');

describe('retrospective replay API', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('reports an unconfigured, idle job on GET /replay', async () => {
    const { status, body } = await ctx.request('GET', '/replay');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      configured: false,
      running: false,
      progress: null,
      lastResult: null,
      lastError: null
    });
    assert.ok(
      ctx.permissions.some(
        (route) =>
          route.method === 'GET' && route.path === '/api/replay' && route.level === 'readonly'
      )
    );
    assert.equal(
      ctx.permissions.some((route) => route.path === '/api/replay' && route.method === 'POST'),
      false,
      'starting a replay is not exposed at a lower-than-admin level'
    );
  });

  it('refuses to start without InfluxDB configured', async () => {
    const { status, body } = await ctx.request('POST', '/replay', {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z'
    });
    assert.equal(status, 400);
    assert.match(body.error.message, /InfluxDB/);
  });

  it('validates the date range', async () => {
    const missing = await ctx.request('POST', '/replay', { to: '2026-01-02T00:00:00.000Z' });
    assert.equal(missing.status, 400);

    const reversed = await ctx.request('POST', '/replay', {
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z'
    });
    assert.equal(reversed.status, 400);
  });

  it('refuses to cancel when nothing is running', async () => {
    const { status, body } = await ctx.request('POST', '/replay/cancel');
    assert.equal(status, 409);
    assert.equal(body.error.code, 'replay_not_running');
  });
});
