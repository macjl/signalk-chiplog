const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { startServer, insertEntry } = require('./helpers');

describe('plugin', () => {
  let ctx;

  afterEach(() => ctx?.close());

  describe('GET /state', () => {
    it('reports the active entry and autostate-driven detection', async () => {
      ctx = await startServer({ self: { navigation: { state: { value: 'sailing' } } } });
      const id = insertEntry(ctx.db, { state: 'active' });

      const { status, body } = await ctx.request('GET', '/state');

      assert.equal(status, 200);
      assert.deepEqual(body, { activeEntryId: id, detection: 'autostate', schemaVersion: 1 });
    });

    it('reports fallback detection when navigation.state is absent', async () => {
      ctx = await startServer();
      const { body } = await ctx.request('GET', '/state');
      assert.equal(body.activeEntryId, null);
      assert.equal(body.detection, 'fallback');
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
