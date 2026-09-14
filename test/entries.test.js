const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { T0, at, startServer, insert, insertEntry } = require('./helpers');

describe('entries', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer({
      self: { navigation: { position: { value: { latitude: 46.5, longitude: -1.79 } } } }
    });
  });

  afterEach(() => ctx.close());

  describe('GET /entries', () => {
    it('lists newest first with a pagination envelope', async () => {
      const older = insertEntry(ctx.db, { start_time: at(0), end_time: at(1) });
      const newer = insertEntry(ctx.db, { start_time: at(24), end_time: at(25) });

      const { status, body } = await ctx.request('GET', '/entries?limit=1');

      assert.equal(status, 200);
      assert.equal(body.total, 2);
      assert.equal(body.limit, 1);
      assert.equal(body.offset, 0);
      assert.deepEqual(
        body.items.map((entry) => entry.id),
        [newer]
      );

      const second = await ctx.request('GET', '/entries?limit=1&offset=1');
      assert.deepEqual(
        second.body.items.map((entry) => entry.id),
        [older]
      );
    });

    it('filters on start time, from inclusive and to exclusive', async () => {
      insertEntry(ctx.db, { start_time: at(0), end_time: at(1) });
      const inside = insertEntry(ctx.db, { start_time: at(24), end_time: at(25) });
      insertEntry(ctx.db, { start_time: at(48), end_time: at(49) });

      const { body } = await ctx.request(
        'GET',
        `/entries?from=${encodeURIComponent(at(24))}&to=${encodeURIComponent(at(48))}`
      );

      assert.deepEqual(
        body.items.map((entry) => entry.id),
        [inside]
      );
    });

    it('rejects invalid pagination and timestamps', async () => {
      assert.equal((await ctx.request('GET', '/entries?limit=0')).status, 400);
      assert.equal((await ctx.request('GET', '/entries?limit=501')).status, 400);
      assert.equal((await ctx.request('GET', '/entries?from=yesterday')).status, 400);
    });
  });

  describe('GET /entries/:id', () => {
    it('returns the entry with camelCase fields, nested positions and counts', async () => {
      const id = insertEntry(ctx.db, {
        start_lat: 46.1591,
        start_lon: -1.1522,
        start_place_name: 'La Rochelle',
        distance: 68500
      });
      insert(ctx.db, 'track_points', { entry_id: id, time: T0, lat: 46.16, lon: -1.15 });
      insert(ctx.db, 'events', {
        entry_id: id,
        time: T0,
        type: 'text_annotation',
        comment: 'Left the harbour',
        created_at: T0
      });

      const { status, body } = await ctx.request('GET', `/entries/${id}`);

      assert.equal(status, 200);
      assert.equal(body.startPlaceName, 'La Rochelle');
      assert.deepEqual(body.startPosition, { lat: 46.1591, lon: -1.1522 });
      assert.equal(body.endPosition, null);
      assert.equal(body.distance, 68500);
      assert.deepEqual(body.counts, { trackPoints: 1, observations: 0, events: 1 });
    });

    it('reports the highest speed and wind seen, preferring true wind', async () => {
      const id = insertEntry(ctx.db);
      insert(ctx.db, 'track_points', { entry_id: id, time: at(0), lat: 46, lon: -1, sog: 3.5 });
      insert(ctx.db, 'track_points', { entry_id: id, time: at(1), lat: 46.1, lon: -1, sog: 6.7 });
      insert(ctx.db, 'track_points', { entry_id: id, time: at(2), lat: 46.2, lon: -1, sog: 4.1 });
      insert(ctx.db, 'observations', {
        entry_id: id,
        time: at(0),
        reason: 'entry_start',
        tws: 8.2,
        aws: 9.5
      });
      insert(ctx.db, 'observations', {
        entry_id: id,
        time: at(1),
        reason: 'periodic',
        tws: 12.9,
        aws: 11
      });

      const { body } = await ctx.request('GET', `/entries/${id}`);

      assert.equal(body.maxSpeed, 6.7);
      assert.equal(body.maxWindSpeed, 12.9);
      assert.equal(body.maxWindApparent, false);
    });

    it('falls back to apparent wind when true wind was never recorded', async () => {
      const id = insertEntry(ctx.db);
      insert(ctx.db, 'observations', { entry_id: id, time: T0, reason: 'entry_start', aws: 9.5 });

      const { body } = await ctx.request('GET', `/entries/${id}`);

      assert.equal(body.maxWindSpeed, 9.5);
      assert.equal(body.maxWindApparent, true);
    });

    it('reports no max speed or wind with nothing recorded', async () => {
      const id = insertEntry(ctx.db);

      const { body } = await ctx.request('GET', `/entries/${id}`);

      assert.equal(body.maxSpeed, null);
      assert.equal(body.maxWindSpeed, null);
      assert.equal(body.maxWindApparent, false);
    });

    it('answers 404 with an error envelope for an unknown entry', async () => {
      const { status, body } = await ctx.request('GET', '/entries/999');
      assert.equal(status, 404);
      assert.equal(body.error.code, 'entry_not_found');
    });

    it('answers 400 for a malformed id', async () => {
      assert.equal((await ctx.request('GET', '/entries/abc')).status, 400);
    });
  });

  describe('PATCH /entries/:id', () => {
    it('remembers a corrected place name and reuses the place within the radius', async () => {
      const first = insertEntry(ctx.db, { start_lat: 46.1591, start_lon: -1.1522 });

      const { status, body } = await ctx.request('PATCH', `/entries/${first}`, {
        startPlaceName: 'Vieux-Port'
      });

      assert.equal(status, 200);
      assert.equal(body.startPlaceName, 'Vieux-Port');
      const place = ctx.db.prepare('SELECT * FROM places WHERE id = ?').get(body.startPlaceId);
      assert.equal(place.name, 'Vieux-Port');
      assert.equal(place.source, 'manual');

      // ~50 m away: inside the default 200 m radius, so the same place is updated.
      const second = insertEntry(ctx.db, {
        start_time: at(24),
        end_time: at(25),
        start_lat: 46.1595,
        start_lon: -1.1522
      });
      const renamed = await ctx.request('PATCH', `/entries/${second}`, {
        startPlaceName: 'Vieux-Port de La Rochelle'
      });
      assert.equal(renamed.body.startPlaceId, body.startPlaceId);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM places').get().n, 1);

      // The earlier entry keeps the name it recorded.
      const unchanged = await ctx.request('GET', `/entries/${first}`);
      assert.equal(unchanged.body.startPlaceName, 'Vieux-Port');
    });

    it('renames a later entry that already reused the place, but not an earlier one', async () => {
      const placeId = insert(ctx.db, 'places', {
        name: 'Vieux-Port',
        lat: 46.1591,
        lon: -1.1522,
        source: 'geocoding',
        created_at: T0,
        updated_at: T0
      });
      const earlier = insertEntry(ctx.db, {
        start_time: at(-48),
        end_time: at(-47),
        start_place_id: placeId,
        start_place_name: 'Vieux-Port',
        start_lat: 46.1591,
        start_lon: -1.1522
      });
      const middle = insertEntry(ctx.db, {
        start_lat: 46.1591,
        start_lon: -1.1522,
        start_place_id: placeId,
        start_place_name: 'Vieux-Port'
      });
      const later = insertEntry(ctx.db, {
        start_time: at(24),
        end_time: at(25),
        start_place_id: placeId,
        start_place_name: 'Vieux-Port',
        start_lat: 46.1591,
        start_lon: -1.1522
      });

      const { status, body } = await ctx.request('PATCH', `/entries/${middle}`, {
        startPlaceName: 'Vieux-Port de La Rochelle'
      });

      assert.equal(status, 200);
      assert.equal(body.startPlaceName, 'Vieux-Port de La Rochelle');

      const laterEntry = await ctx.request('GET', `/entries/${later}`);
      assert.equal(laterEntry.body.startPlaceName, 'Vieux-Port de La Rochelle');

      const earlierEntry = await ctx.request('GET', `/entries/${earlier}`);
      assert.equal(earlierEntry.body.startPlaceName, 'Vieux-Port');
    });

    it('creates a separate place outside the radius', async () => {
      const first = insertEntry(ctx.db, { start_lat: 46.1591, start_lon: -1.1522 });
      const second = insertEntry(ctx.db, {
        start_time: at(24),
        end_time: at(25),
        start_lat: 46.5,
        start_lon: -1.79
      });

      await ctx.request('PATCH', `/entries/${first}`, { startPlaceName: 'La Rochelle' });
      await ctx.request('PATCH', `/entries/${second}`, { startPlaceName: 'Les Sables' });

      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM places').get().n, 2);
    });

    it('stores a name without a place when the entry has no position', async () => {
      const id = insertEntry(ctx.db);
      const { body } = await ctx.request('PATCH', `/entries/${id}`, {
        startPlaceName: 'Somewhere'
      });
      assert.equal(body.startPlaceName, 'Somewhere');
      assert.equal(body.startPlaceId, null);
    });

    it('rejects an end time before the start time', async () => {
      const id = insertEntry(ctx.db);
      const { status } = await ctx.request('PATCH', `/entries/${id}`, { endTime: at(-1) });
      assert.equal(status, 400);
    });

    it('refuses to set the end time of an entry still in progress', async () => {
      const id = insertEntry(ctx.db, { state: 'active' });
      const { status, body } = await ctx.request('PATCH', `/entries/${id}`, { endTime: at(2) });
      assert.equal(status, 409);
      assert.equal(body.error.code, 'entry_active');
    });

    it('rejects unknown fields', async () => {
      const id = insertEntry(ctx.db);
      const { status } = await ctx.request('PATCH', `/entries/${id}`, { state: 'active' });
      assert.equal(status, 400);
    });
  });

  describe('POST /entries/:id/close', () => {
    it('closes at the stop detection already saw, at the current vessel position', async () => {
      const id = insertEntry(ctx.db, { state: 'active', stopped_since: at(1) });

      const { status, body } = await ctx.request('POST', `/entries/${id}/close`);

      assert.equal(status, 200);
      assert.equal(body.state, 'closed');
      assert.equal(body.endTime, at(1));
      assert.equal(body.stoppedSince, null);
      assert.deepEqual(body.endPosition, { lat: 46.5, lon: -1.79 });
    });

    it('closes now when no stop has been detected', async () => {
      const id = insertEntry(ctx.db, { state: 'active' });
      const before = new Date().toISOString();

      const { body } = await ctx.request('POST', `/entries/${id}/close`);

      assert.ok(body.endTime >= before);
    });

    it('answers 409 for an entry already closed', async () => {
      const id = insertEntry(ctx.db);
      const { status, body } = await ctx.request('POST', `/entries/${id}/close`);
      assert.equal(status, 409);
      assert.equal(body.error.code, 'entry_already_closed');
    });
  });

  describe('POST /entries/:id/merge', () => {
    it('folds the later entry into the earlier one', async () => {
      const earlier = insertEntry(ctx.db, {
        start_time: at(0),
        end_time: at(2),
        start_place_name: 'La Rochelle',
        distance: 1000
      });
      const later = insertEntry(ctx.db, {
        state: 'active',
        start_time: at(3),
        end_lat: 46.5,
        end_lon: -1.79,
        end_place_name: 'Les Sables',
        distance: 500
      });
      insert(ctx.db, 'track_points', { entry_id: later, time: at(3), lat: 46.3, lon: -1.5 });
      insert(ctx.db, 'propulsion_segments', {
        entry_id: earlier,
        type: 'engine',
        start_time: at(0),
        end_time: at(1)
      });
      insert(ctx.db, 'propulsion_segments', {
        entry_id: later,
        type: 'sail',
        start_time: at(3),
        end_time: at(5)
      });

      // Merging from the later side still keeps the earlier entry.
      const { status, body } = await ctx.request('POST', `/entries/${later}/merge`, {
        withEntryId: earlier
      });

      assert.equal(status, 200);
      assert.equal(body.id, earlier);
      assert.equal(body.state, 'active');
      assert.equal(body.startPlaceName, 'La Rochelle');
      assert.equal(body.endPlaceName, 'Les Sables');
      assert.equal(body.distance, 1500);
      assert.equal(body.engineDuration, 3600);
      assert.equal(body.sailDuration, 7200);
      assert.equal(body.counts.trackPoints, 1);
      assert.equal((await ctx.request('GET', `/entries/${later}`)).status, 404);
    });

    it('refuses entries that are not consecutive', async () => {
      const a = insertEntry(ctx.db, { start_time: at(0), end_time: at(1) });
      insertEntry(ctx.db, { start_time: at(2), end_time: at(3) });
      const c = insertEntry(ctx.db, { start_time: at(4), end_time: at(5) });

      const { status, body } = await ctx.request('POST', `/entries/${a}/merge`, {
        withEntryId: c
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'entries_not_consecutive');
    });

    it('refuses merging an entry with itself', async () => {
      const id = insertEntry(ctx.db);
      const { status } = await ctx.request('POST', `/entries/${id}/merge`, { withEntryId: id });
      assert.equal(status, 400);
    });
  });

  describe('DELETE /entries/:id', () => {
    it('removes the entry and everything attached to it', async () => {
      const id = insertEntry(ctx.db);
      insert(ctx.db, 'track_points', { entry_id: id, time: T0, lat: 46, lon: -1 });

      const { status } = await ctx.request('DELETE', `/entries/${id}`);

      assert.equal(status, 204);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM track_points').get().n, 0);
    });
  });
});
