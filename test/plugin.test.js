const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { startServer, insertEntry } = require('./helpers');

describe('plugin', () => {
  let ctx;

  afterEach(() => ctx?.close());

  describe('GET /state', () => {
    it('opens a passage from a fresh navigation.state as soon as the plugin starts', async () => {
      ctx = await startServer({
        self: {
          navigation: { state: { value: 'sailing', timestamp: new Date().toISOString() } }
        }
      });

      const { status, body } = await ctx.request('GET', '/state');

      assert.equal(status, 200);
      assert.equal(body.detection, 'autostate');
      assert.equal(body.motion, 'underway');
      assert.equal(body.schemaVersion, 2);
      const entry = await ctx.request('GET', `/entries/${body.activeEntryId}`);
      assert.equal(entry.body.state, 'active');
    });

    it('ignores a navigation.state left over from long ago', async () => {
      ctx = await startServer({
        self: { navigation: { state: { value: 'sailing', timestamp: '2026-01-01T00:00:00.000Z' } } }
      });

      const { body } = await ctx.request('GET', '/state');

      assert.deepEqual(body, {
        activeEntryId: null,
        detection: 'fallback',
        motion: 'unknown',
        schemaVersion: 2
      });
    });

    it('reports the active entry', async () => {
      ctx = await startServer();
      const id = insertEntry(ctx.db, { state: 'active', last_moving_at: new Date().toISOString() });
      const { body } = await ctx.request('GET', '/state');
      assert.equal(body.activeEntryId, id);
    });
  });

  it('answers 503 while the plugin is stopped', async () => {
    ctx = await startServer();
    ctx.plugin.stop();

    const { status, body } = await ctx.request('GET', '/entries');

    assert.equal(status, 503);
    assert.equal(body.error.code, 'plugin_not_started');
    ctx.plugin.start({}, () => {});
  });

  it('opens reads to readonly users, crew writes to readwrite, and keeps the rest admin-only', async () => {
    ctx = await startServer();

    const level = (method, path) =>
      ctx.permissions.find((p) => p.method === method && p.path === path)?.level ?? 'admin';

    assert.equal(level('GET', '/api/entries'), 'readonly');
    assert.equal(level('GET', '/api/export'), 'readonly');
    assert.equal(level('POST', '/api/entries/:id/events'), 'readwrite');
    assert.equal(level('PATCH', '/api/places/:id'), 'readwrite');
    assert.equal(level('PATCH', '/api/propulsion/:id'), 'readwrite');
    assert.equal(level('DELETE', '/api/entries/:id'), 'admin');
    assert.equal(level('DELETE', '/api/places/:id'), 'admin');
    assert.equal(level('POST', '/api/manoeuvre-types'), 'admin');
    assert.equal(level('POST', '/api/export/usb'), 'admin');
  });

  it('logs unexpected failures and hides their detail from the client', async () => {
    ctx = await startServer();
    ctx.db.exec('DROP TABLE observations');
    const id = insertEntry(ctx.db);

    const { status, body } = await ctx.request('GET', `/entries/${id}`);

    assert.equal(status, 500);
    assert.equal(body.error.code, 'internal_error');
    assert.equal(ctx.errors.length, 1);
    assert.match(ctx.errors[0], /no such table/);
  });
});
