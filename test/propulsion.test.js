const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { at, startServer, insert, insertEntry } = require('./helpers');

describe('propulsion', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('lists the segments of an entry', async () => {
    const entryId = insertEntry(ctx.db);
    insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'engine',
      start_time: at(0),
      end_time: at(1),
      average_rpm: 1800
    });

    const { status, body } = await ctx.request('GET', `/entries/${entryId}/propulsion`);

    assert.equal(status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.items[0].averageRpm, 1800);
  });

  it('corrects a mis-detected segment, recomputes totals and logs the correction', async () => {
    const entryId = insertEntry(ctx.db, { engine_duration: 7200 });
    const segmentId = insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'engine',
      start_time: at(1),
      end_time: at(3)
    });

    const { status, body } = await ctx.request('PATCH', `/propulsion/${segmentId}`, {
      type: 'sail'
    });

    assert.equal(status, 200);
    assert.equal(body.type, 'sail');
    assert.equal(body.source, 'manual');

    const entry = await ctx.request('GET', `/entries/${entryId}`);
    assert.equal(entry.body.engineDuration, 0);
    assert.equal(entry.body.sailDuration, 7200);

    const corrections = await ctx.request(
      'GET',
      `/entries/${entryId}/events?type=manual_correction`
    );
    assert.equal(corrections.body.total, 1);
    const [correction] = corrections.body.items;
    assert.equal(correction.time, at(1));
    assert.deepEqual(correction.payload, {
      segmentId,
      before: { type: 'engine' },
      after: { type: 'sail' }
    });
  });

  it('does nothing when the type is unchanged', async () => {
    const entryId = insertEntry(ctx.db);
    const segmentId = insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'sail',
      start_time: at(0),
      end_time: at(1)
    });

    const { body } = await ctx.request('PATCH', `/propulsion/${segmentId}`, { type: 'sail' });

    assert.equal(body.source, 'auto');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  });

  it('rejects an invalid type', async () => {
    const entryId = insertEntry(ctx.db);
    const segmentId = insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'sail',
      start_time: at(0)
    });
    assert.equal(
      (await ctx.request('PATCH', `/propulsion/${segmentId}`, { type: 'oars' })).status,
      400
    );
  });
});
