const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { T0, at, startServer, insert, insertEntry } = require('./helpers');

const STROKES = {
  strokes: [
    {
      points: [
        { x: 0, y: 0, t: 0, pressure: 0.4 },
        { x: 10, y: 12, t: 16, pressure: 0.6 }
      ]
    }
  ]
};

describe('events', () => {
  let ctx;
  let entryId;

  beforeEach(async () => {
    ctx = await startServer({
      self: { navigation: { position: { value: { latitude: 46.2, longitude: -1.3 } } } }
    });
    entryId = insertEntry(ctx.db, { state: 'active' });
  });

  afterEach(() => ctx.close());

  describe('POST /entries/:id/events', () => {
    it('logs a manoeuvre shortcut with the current time and vessel position', async () => {
      const before = Date.now();

      const { status, body } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'manoeuvre',
        subtype: 'reef_in',
        comment: '25 kn, second reef',
        payload: { sail: 'main' }
      });

      assert.equal(status, 201);
      assert.equal(body.type, 'manoeuvre');
      assert.equal(body.subtype, 'reef_in');
      assert.equal(body.source, 'manual');
      assert.deepEqual(body.payload, { sail: 'main' });
      assert.deepEqual(body.position, { lat: 46.2, lon: -1.3 });
      assert.ok(Date.parse(body.time) >= before - 1000);
    });

    it('keeps an explicit time and a null position', async () => {
      const { body } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Dolphins off the bow',
        time: at(1),
        position: null
      });
      assert.equal(body.time, at(1));
      assert.equal(body.position, null);
    });

    it('rejects an unknown manoeuvre type', async () => {
      const { status, body } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'manoeuvre',
        subtype: 'barrel_roll'
      });
      assert.equal(status, 400);
      assert.equal(body.error.code, 'unknown_manoeuvre_type');
    });

    it('requires a comment on a text annotation', async () => {
      const { status } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation'
      });
      assert.equal(status, 400);
    });

    it('accepts well-formed handwritten strokes and rejects malformed ones', async () => {
      const valid = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'handwritten_annotation',
        payload: STROKES
      });
      assert.equal(valid.status, 201);
      assert.deepEqual(valid.body.payload, STROKES);

      const invalid = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'handwritten_annotation',
        payload: { strokes: [{ points: [{ x: 1, y: 'two' }] }] }
      });
      assert.equal(invalid.status, 400);
    });

    it('refuses event types that only the plugin produces', async () => {
      const { status } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'sk_alarm',
        subtype: 'notifications.mob'
      });
      assert.equal(status, 400);
    });

    it('answers 404 for an unknown entry', async () => {
      const { status } = await ctx.request('POST', '/entries/999/events', {
        type: 'text_annotation',
        comment: 'lost'
      });
      assert.equal(status, 404);
    });
  });

  describe('GET /entries/:id/events', () => {
    it('lists oldest first and filters by type', async () => {
      insert(ctx.db, 'events', {
        entry_id: entryId,
        time: at(2),
        type: 'text_annotation',
        comment: 'later',
        created_at: T0
      });
      insert(ctx.db, 'events', {
        entry_id: entryId,
        time: at(1),
        type: 'manoeuvre',
        subtype: 'tack',
        created_at: T0
      });

      const all = await ctx.request('GET', `/entries/${entryId}/events`);
      assert.deepEqual(
        all.body.items.map((event) => event.time),
        [at(1), at(2)]
      );

      const manoeuvres = await ctx.request('GET', `/entries/${entryId}/events?type=manoeuvre`);
      assert.equal(manoeuvres.body.total, 1);

      assert.equal((await ctx.request('GET', `/entries/${entryId}/events?type=bogus`)).status, 400);
    });
  });

  describe('PATCH and DELETE /events/:id', () => {
    it('edits a manual event and validates the result', async () => {
      const created = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Wind backing'
      });

      const edited = await ctx.request('PATCH', `/events/${created.body.id}`, {
        comment: 'Wind backing SW'
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.comment, 'Wind backing SW');

      const cleared = await ctx.request('PATCH', `/events/${created.body.id}`, { comment: null });
      assert.equal(cleared.status, 400);
    });

    it('only allows the comment of an automatic event to change', async () => {
      const id = insert(ctx.db, 'events', {
        entry_id: entryId,
        time: T0,
        type: 'sk_alarm',
        subtype: 'notifications.mob',
        source: 'auto',
        created_at: T0
      });

      assert.equal(
        (await ctx.request('PATCH', `/events/${id}`, { comment: 'False alarm' })).status,
        200
      );
      assert.equal((await ctx.request('PATCH', `/events/${id}`, { time: at(1) })).status, 400);
    });

    it('deletes an event', async () => {
      const created = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Oops'
      });
      assert.equal((await ctx.request('DELETE', `/events/${created.body.id}`)).status, 204);
      assert.equal((await ctx.request('DELETE', `/events/${created.body.id}`)).status, 404);
    });
  });
});
