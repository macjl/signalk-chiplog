const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { logCrewEvent, deleteEvent } = require('../lib/events');
const { createBoat, iso, BERTH } = require('./boat');
const { T0, at, startServer, insert, insertEntry } = require('./helpers');

const HERE = { lat: 46.2, lon: -1.3 };
// About 3 nm north of HERE.
const FAR = { lat: 46.25, lon: -1.3 };

describe('POST /events', () => {
  let ctx;

  beforeEach(async () => {
    const timestamp = new Date().toISOString();
    ctx = await startServer({
      self: {
        navigation: {
          position: { value: { latitude: HERE.lat, longitude: HERE.lon }, timestamp }
        },
        environment: { wind: { speedTrue: { value: 8.2, timestamp } } }
      }
    });
  });

  afterEach(() => ctx.close());

  const post = (body) => ctx.request('POST', '/events', body);
  const activeEntries = () =>
    ctx.db.prepare("SELECT * FROM log_entries WHERE state = 'active'").all();

  it('is open to readwrite users', () => {
    assert.ok(
      ctx.permissions.some(
        (route) =>
          route.method === 'POST' && route.path === '/api/events' && route.level === 'readwrite'
      )
    );
  });

  it('attaches to the passage in progress', async () => {
    const entryId = insertEntry(ctx.db, { state: 'active' });

    const { status, body } = await post({ type: 'manoeuvre', subtype: 'tack' });

    assert.equal(status, 201);
    assert.equal(body.entryId, entryId);
    assert.equal(body.openedEntry, false);
    assert.deepEqual(body.position, HERE);
  });

  it('opens a passage when the crew casts off with none open', async () => {
    insertEntry(ctx.db, { end_time: at(1), end_lat: FAR.lat, end_lon: FAR.lon });
    ctx.db
      .prepare(
        "INSERT INTO places (name, lat, lon, source, created_at, updated_at) VALUES ('Port', ?, ?, 'manual', ?, ?)"
      )
      .run(HERE.lat, HERE.lon, T0, T0);

    const { status, body } = await post({ type: 'manoeuvre', subtype: 'cast_off' });

    assert.equal(status, 201);
    assert.equal(body.openedEntry, true);
    const [entry] = activeEntries();
    assert.equal(entry.id, body.entryId);
    assert.equal(entry.start_time, body.time);
    assert.equal(entry.stopped_since, body.time, 'waiting to leave, not under way');
    assert.equal(entry.last_moving_at, null);
    assert.equal(entry.opened_by_event_id, body.id);
    assert.equal(entry.start_place_name, 'Port');
    assert.deepEqual({ lat: entry.start_lat, lon: entry.start_lon }, HERE);

    const { body: detail } = await ctx.request('GET', `/entries/${entry.id}`);
    assert.equal(detail.openedByEventId, body.id);
    assert.equal(detail.counts.observations, 1, 'a live manoeuvre takes a snapshot');
  });

  it('opens a passage when weighing anchor too, pending a name away from known places', async () => {
    const { body } = await post({ type: 'manoeuvre', subtype: 'anchor_up' });

    assert.equal(body.openedEntry, true);
    const [entry] = activeEntries();
    assert.equal(entry.start_place_name, '46.2000N 1.3000W');
    assert.equal(entry.start_place_pending, 1);
  });

  it('never starts a passage before the previous one ended', async () => {
    insertEntry(ctx.db, { end_time: at(2), end_lat: FAR.lat, end_lon: FAR.lon });

    const { body } = await post({ type: 'manoeuvre', subtype: 'cast_off', time: at(1) });

    assert.equal(activeEntries()[0].start_time, at(2));
    assert.equal(body.time, at(1));
  });

  it('attaches other entries to the last passage while still at its arrival', async () => {
    const entryId = insertEntry(ctx.db, { end_lat: 46.201, end_lon: -1.3 });

    const { status, body } = await post({ type: 'text_annotation', comment: 'Fuel taken' });

    assert.equal(status, 201);
    assert.equal(body.entryId, entryId);
    assert.equal(body.openedEntry, false);
    assert.equal(activeEntries().length, 0);
  });

  it('refuses an entry with no passage to belong to', async () => {
    insertEntry(ctx.db, { end_lat: FAR.lat, end_lon: FAR.lon });

    for (const body of [
      { type: 'manoeuvre', subtype: 'tack' },
      { type: 'text_annotation', comment: 'Hello' }
    ]) {
      const { status, body: error } = await post(body);
      assert.equal(status, 409);
      assert.equal(error.error.code, 'no_passage');
    }
    const { body: noHistory } = await post({ type: 'manoeuvre', subtype: 'moor', position: null });
    assert.equal(noHistory.error.code, 'no_passage');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  });

  it('validates the entry before opening anything', async () => {
    const { status } = await post({ type: 'manoeuvre', subtype: 'cast_off', extra: 1 });
    assert.equal(status, 400);
    const { body } = await post({ type: 'text_annotation' });
    assert.equal(body.error.code, 'invalid_request');
    assert.equal(activeEntries().length, 0);
  });

  describe('clientRef', () => {
    it('answers a replayed entry with the event already logged', async () => {
      const first = await post({ type: 'manoeuvre', subtype: 'cast_off', clientRef: 'tablet-1' });
      const again = await post({ type: 'manoeuvre', subtype: 'cast_off', clientRef: 'tablet-1' });

      assert.equal(first.status, 201);
      assert.equal(again.status, 200);
      assert.equal(again.body.id, first.body.id);
      assert.equal(again.body.clientRef, 'tablet-1');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n, 1);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
    });

    it('is honoured on the per-entry route as well', async () => {
      const entryId = insertEntry(ctx.db, { state: 'active' });
      const body = { type: 'text_annotation', comment: 'x', clientRef: 'tablet-2' };

      const first = await ctx.request('POST', `/entries/${entryId}/events`, body);
      const again = await ctx.request('POST', `/entries/${entryId}/events`, body);

      assert.equal(first.status, 201);
      assert.equal(again.status, 200);
      assert.equal(again.body.id, first.body.id);
    });

    it('must be a non-empty string', async () => {
      insertEntry(ctx.db, { state: 'active' });
      for (const clientRef of ['', 42, 'x'.repeat(101)]) {
        const { status } = await post({ type: 'text_annotation', comment: 'x', clientRef });
        assert.equal(status, 400, JSON.stringify(clientRef));
      }
    });
  });

  describe('position of an entry logged after the fact', () => {
    let entryId;

    beforeEach(() => {
      entryId = insertEntry(ctx.db, { state: 'active', start_time: at(-2) });
      for (const [minutes, lat] of [
        [-60, 46.1],
        [-50, 46.11]
      ]) {
        insert(ctx.db, 'track_points', {
          entry_id: entryId,
          time: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
          lat,
          lon: -1.2
        });
      }
    });

    const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

    it('takes the nearest track point', async () => {
      const { body } = await post({ type: 'manoeuvre', subtype: 'tack', time: minutesAgo(51) });
      assert.deepEqual(body.position, { lat: 46.11, lon: -1.2 });
      assert.equal(
        ctx.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n,
        0,
        'no snapshot for a manoeuvre after the fact'
      );
    });

    it('takes the current position for a recent time without track', async () => {
      const { body } = await post({ type: 'manoeuvre', subtype: 'tack', time: minutesAgo(3) });
      assert.deepEqual(body.position, HERE);
    });

    it('records none when nothing tells where the vessel was', async () => {
      const { body } = await post({ type: 'manoeuvre', subtype: 'tack', time: minutesAgo(30) });
      assert.equal(body.position, null);
    });

    it('keeps an explicit position', async () => {
      const { body } = await post({
        type: 'manoeuvre',
        subtype: 'tack',
        time: minutesAgo(51),
        position: FAR
      });
      assert.deepEqual(body.position, FAR);
    });
  });

  describe('DELETE /events/:id', () => {
    it('undoes a departure together with the passage it opened', async () => {
      const { body } = await post({ type: 'manoeuvre', subtype: 'cast_off' });

      const { status } = await ctx.request('DELETE', `/events/${body.id}`);

      assert.equal(status, 204);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n, 0);
    });

    it('keeps the passage once something else was logged in it', async () => {
      const { body } = await post({ type: 'manoeuvre', subtype: 'cast_off' });
      await post({ type: 'text_annotation', comment: 'Crew aboard' });

      await ctx.request('DELETE', `/events/${body.id}`);

      const [entry] = activeEntries();
      assert.equal(entry.id, body.entryId);
      assert.equal(entry.opened_by_event_id, null);
    });

    it('keeps the passage once the vessel has moved', async () => {
      const { body } = await post({ type: 'manoeuvre', subtype: 'cast_off' });
      ctx.db.prepare('UPDATE log_entries SET last_moving_at = ?').run(new Date().toISOString());

      await ctx.request('DELETE', `/events/${body.id}`);

      assert.equal(activeEntries().length, 1);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
    });
  });
});

describe('a passage opened by casting off', () => {
  let boat;

  afterEach(() => boat.close());

  function castOff(time) {
    return logCrewEvent(
      boat.db,
      { type: 'manoeuvre', subtype: 'cast_off' },
      { now: iso(time), vesselPosition: { ...BERTH }, placeMatchRadius: 200 }
    );
  }

  it('carries on as the same passage, from the cast-off, once the vessel moves', () => {
    boat = createBoat().start().sail(5, { sog: 0 });
    const castOffAt = boat.now;
    const { event } = castOff(castOffAt);

    boat.sail(5, { sog: 0 }).sail(20, { sog: 5 });

    const entries = boat.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, 'active');
    assert.equal(entries[0].start_time, iso(castOffAt));
    assert.equal(entries[0].stopped_since, null);
    assert.notEqual(entries[0].last_moving_at, null);
    assert.ok(boat.segments().length > 0, 'propulsion follows the movement');

    assert.throws(() => deleteEvent(boat.db, event.id + 1000));
    deleteEvent(boat.db, event.id);
    assert.equal(boat.entries().length, 1, 'too late to undo the passage');
  });

  it('closes like any long stop when the vessel never leaves', () => {
    boat = createBoat().start().sail(1, { sog: 0 });
    const castOffAt = boat.now;
    castOff(castOffAt);

    boat.sail(40, { sog: 0 });

    const [entry] = boat.entries();
    assert.equal(entry.state, 'closed');
    assert.equal(entry.end_time, iso(castOffAt));
  });
});
