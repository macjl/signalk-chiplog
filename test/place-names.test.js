const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { updateEntry } = require('../lib/entries');
const {
  coordinatesName,
  createPlaceNamer,
  GEOCODING_DEFAULTS,
  pickName
} = require('../lib/place-names');
const { createBoat, addPlace } = require('./boat');
const { startServer, insertEntry } = require('./helpers');

const MINIMES = { lat: 46.1466, lon: -1.1686 };

// What the public Nominatim instance answered for these positions.
const NEAR_MARINA = {
  category: 'highway',
  type: 'service',
  name: 'Quai du Bout Blanc',
  address: {
    road: 'Quai du Bout Blanc',
    quarter: 'Les Minimes',
    city: 'La Rochelle',
    municipality: 'La Rochelle',
    county: 'Charente-Maritime',
    country: 'France',
    country_code: 'fr'
  }
};
const OPEN_SEA = {
  category: 'boundary',
  type: 'administrative',
  name: 'France métropolitaine',
  address: { region: 'France métropolitaine', country: 'France', country_code: 'fr' }
};

const MINUTE = 60 * 1000;

function jsonResponse(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

describe('place names', () => {
  it('are generated from coordinates with hemispheres', () => {
    assert.equal(coordinatesName({ lat: 46.12346, lon: -1.56789 }), '46.1235N 1.5679W');
    assert.equal(coordinatesName({ lat: -16.8, lon: 179.9999 }), '16.8000S 179.9999E');
  });

  describe('chosen from a Nominatim answer', () => {
    it('take the settlement and its district rather than the quay road', () => {
      assert.equal(pickName(NEAR_MARINA), 'La Rochelle (Les Minimes)');
    });

    it('take a marina or harbour by its own name', () => {
      assert.equal(
        pickName({ type: 'marina', name: 'Port des Minimes', address: { city: 'La Rochelle' } }),
        'Port des Minimes'
      );
    });

    it('take a village alone', () => {
      assert.equal(pickName({ type: 'house', address: { village: 'Ars-en-Ré' } }), 'Ars-en-Ré');
    });

    it('find nothing in a bare administrative boundary, as at sea', () => {
      assert.equal(pickName(OPEN_SEA), null);
    });
  });

  describe('at departure and arrival', () => {
    let boat;

    afterEach(() => boat.close());

    it('fall back to coordinates, pending geocoding, away from known places', () => {
      boat = createBoat().start().sail(5, { sog: 0 }).sail(10, { sog: 5 });

      const [entry] = boat.entries();
      assert.equal(
        entry.start_place_name,
        coordinatesName({ lat: entry.start_lat, lon: entry.start_lon })
      );
      assert.equal(entry.start_place_pending, 1);
      assert.equal(entry.start_place_id, null);
    });

    it('use a known place without waiting for geocoding', () => {
      boat = createBoat();
      addPlace(boat.db, 'Les Minimes', boat.position);
      boat.start().sail(5, { sog: 0 }).sail(10, { sog: 5 });

      const [entry] = boat.entries();
      assert.equal(entry.start_place_name, 'Les Minimes');
      assert.equal(entry.start_place_pending, 0);
    });
  });
});

describe('online geocoding', () => {
  let dataDir;
  let db;
  let requests;
  let answer;

  const settings = (overrides = {}) => ({
    ...GEOCODING_DEFAULTS,
    placeMatchRadius: 200,
    ...overrides
  });

  function namer(overrides) {
    return createPlaceNamer({
      db,
      settings: settings(overrides),
      userAgent: 'signalk-chiplog/test',
      fetch: (url, options) => {
        requests.push({ url: new URL(url), options });
        return answer(url, options);
      }
    });
  }

  function pendingDeparture(position = MINIMES, fields = {}) {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO log_entries (state, start_time, end_time, start_lat, start_lon, start_place_name,
           start_place_pending, created_at, updated_at)
         VALUES ('closed', ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        fields.startTime ?? '2026-09-13T08:00:00.000Z',
        fields.endTime ?? '2026-09-13T12:00:00.000Z',
        position.lat,
        position.lon,
        coordinatesName(position),
        '2026-09-13T08:00:00.000Z',
        '2026-09-13T08:00:00.000Z'
      );
    return Number(lastInsertRowid);
  }

  const entry = (id) => db.prepare('SELECT * FROM log_entries WHERE id = ?').get(id);
  const places = () => db.prepare('SELECT * FROM places').all();

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-geocoding-'));
    ({ db } = openDatabase(dataDir));
    requests = [];
    answer = () => jsonResponse(NEAR_MARINA);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('names a pending departure and remembers the place for next time', async () => {
    const id = pendingDeparture();

    const result = await namer().resolveNext();

    assert.equal(result.outcome, 'resolved');
    assert.equal(entry(id).start_place_name, 'La Rochelle (Les Minimes)');
    assert.equal(entry(id).start_place_pending, 0);
    const [place] = places();
    assert.equal(place.name, 'La Rochelle (Les Minimes)');
    assert.equal(place.source, 'geocoding');
    assert.equal(place.country_code, 'FR');
    assert.equal(place.country_checked, 1);
    assert.equal(entry(id).start_place_id, place.id);

    const [{ url, options }] = requests;
    assert.equal(url.origin + url.pathname, 'https://nominatim.openstreetmap.org/reverse');
    assert.equal(url.searchParams.get('format'), 'jsonv2');
    assert.equal(url.searchParams.get('lat'), String(MINIMES.lat));
    assert.equal(options.headers['User-Agent'], 'signalk-chiplog/test');
  });

  it('names the next departure from that remembered place, without a request', async () => {
    const service = namer();
    pendingDeparture();
    await service.resolveNext();

    const later = pendingDeparture(
      { lat: MINIMES.lat + 0.0005, lon: MINIMES.lon },
      { startTime: '2026-09-14T08:00:00.000Z', endTime: '2026-09-14T12:00:00.000Z' }
    );
    const result = await service.resolveNext();

    assert.equal(result.outcome, 'known');
    assert.equal(requests.length, 1);
    assert.equal(entry(later).start_place_name, 'La Rochelle (Les Minimes)');
  });

  it('keeps the coordinates, and stops asking, when there is nothing to name', async () => {
    const id = pendingDeparture({ lat: 46.05, lon: -1.6 });
    answer = () => jsonResponse(OPEN_SEA);

    const service = namer();
    assert.equal((await service.resolveNext()).outcome, 'no_result');
    assert.equal((await service.resolveNext()).outcome, 'idle');

    assert.equal(entry(id).start_place_name, '46.0500N 1.6000W');
    assert.equal(entry(id).start_place_pending, 0);
    assert.equal(places().length, 0);
  });

  describe('countries of places', () => {
    function place(fields = {}) {
      const now = '2026-09-13T08:00:00.000Z';
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO places (name, lat, lon, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          fields.name ?? 'Les Minimes',
          MINIMES.lat,
          MINIMES.lon,
          fields.source ?? 'manual',
          now,
          now
        );
      return Number(lastInsertRowid);
    }
    const country = (id) =>
      db.prepare('SELECT country_code, country_checked FROM places WHERE id = ?').get(id);

    it('fills in a place saved without one, asking at country level', async () => {
      const id = place();
      answer = () => jsonResponse(OPEN_SEA);

      const result = await namer().resolveNext();

      assert.equal(result.outcome, 'country');
      assert.equal(requests[0].url.searchParams.get('zoom'), '3');
      assert.equal(requests[0].url.searchParams.get('lat'), String(MINIMES.lat));
      assert.equal(country(id).country_code, 'FR');
      assert.equal(country(id).country_checked, 1);
      assert.equal((await namer().resolveNext()).outcome, 'idle');
      assert.equal(requests.length, 1);
    });

    it('names pending departures before it looks up any country', async () => {
      const id = place();
      pendingDeparture({ lat: 45.9, lon: -1.3 });

      assert.equal((await namer().resolveNext()).outcome, 'resolved');
      assert.equal(country(id).country_checked, 0);
      assert.equal((await namer().resolveNext()).outcome, 'country');
    });

    it('stops asking about a position that has no country', async () => {
      const id = place();
      answer = () => jsonResponse({}, 404);

      assert.equal((await namer().resolveNext()).outcome, 'country');

      assert.equal(country(id).country_code, null);
      assert.equal(country(id).country_checked, 1);
      assert.equal((await namer().resolveNext()).outcome, 'idle');
    });

    it('tries again later when the service cannot answer', async () => {
      const id = place();
      answer = () => jsonResponse({}, 429);

      const result = await namer().resolveNext();

      assert.equal(result.outcome, 'failed');
      assert.equal(country(id).country_checked, 0);
    });

    it('does not ask while geocoding is switched off', async () => {
      place();

      const result = await namer({ geocodingEnabled: false }).resolveNext();

      assert.equal(result.outcome, 'disabled');
      assert.equal(requests.length, 0);
    });
  });

  it('treats an unknown position as final, but rate limiting as worth retrying', async () => {
    pendingDeparture();
    answer = () => jsonResponse({}, 429);
    assert.equal((await namer().resolveNext()).outcome, 'failed');

    answer = () => jsonResponse({}, 404);
    assert.equal((await namer().resolveNext()).outcome, 'no_result');
  });

  it('retries a network failure with a growing delay, and keeps the name pending', async () => {
    const id = pendingDeparture();
    answer = () => Promise.reject(new TypeError('fetch failed'));
    const service = namer();

    const delays = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await service.resolveNext();
      assert.equal(result.outcome, 'failed');
      delays.push(result.retryInMs / MINUTE);
    }
    assert.deepEqual(delays, [5, 10, 20, 40, 60, 60]);
    assert.equal(entry(id).start_place_pending, 1);

    answer = () => jsonResponse(NEAR_MARINA);
    const recovered = await service.resolveNext();
    assert.equal(recovered.outcome, 'resolved');
    assert.equal(recovered.retryInMs, 2000, 'back to normal pace');
  });

  describe('while a lookup is on its way', () => {
    let reply;

    beforeEach(() => {
      answer = () => new Promise((resolve) => (reply = resolve));
    });

    const edit = (id, patch) =>
      updateEntry(db, id, patch, { placeMatchRadius: 200, now: '2026-09-13T13:00:00.000Z' });
    const arrive = () => reply({ ok: true, status: 200, json: () => Promise.resolve(NEAR_MARINA) });

    it('leaves a name the crew removed removed', async () => {
      const id = pendingDeparture();

      const lookup = namer().resolveNext();
      edit(id, { startPlaceName: null });
      arrive();
      await lookup;

      assert.equal(entry(id).start_place_name, null);
      assert.equal(entry(id).start_place_pending, 0);
    });

    it('does not give a corrected position the name of the one it replaced', async () => {
      const id = pendingDeparture();

      const lookup = namer().resolveNext();
      edit(id, { startPosition: { lat: 46.05, lon: -1.6 } });
      arrive();
      await lookup;

      assert.equal(entry(id).start_place_name, '46.0500N 1.6000W');
      assert.equal(entry(id).start_place_pending, 1, 'still to be looked up, at its new position');
    });
  });

  it('does not reach the service when disabled', async () => {
    pendingDeparture();

    const result = await namer({ geocodingEnabled: false }).resolveNext();

    assert.equal(result.outcome, 'disabled');
    assert.equal(requests.length, 0);
  });

  it('abandons a lookup in flight when stopped, without writing', async () => {
    const id = pendingDeparture();
    answer = (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason))
      );

    const service = namer();
    const lookup = service.resolveNext();
    service.stop();

    assert.equal((await lookup).outcome, 'stopped');
    assert.equal(entry(id).start_place_pending, 1);
  });

  it('uses a self-hosted Nominatim', async () => {
    pendingDeparture();

    await namer({ geocodingUrl: 'https://geo.example.internal/nominatim' }).resolveNext();

    assert.equal(
      requests[0].url.href.split('?')[0],
      'https://geo.example.internal/nominatim/reverse'
    );
  });
});

describe('pending place names through the API', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer({
      self: {
        navigation: { position: { value: { latitude: 46.5, longitude: -1.79 } } }
      }
    });
  });

  afterEach(() => ctx.close());

  it('are exposed, cleared by a typed name, and follow a corrected position', async () => {
    const id = insertEntry(ctx.db, {
      start_lat: 46.05,
      start_lon: -1.6,
      start_place_name: '46.0500N 1.6000W',
      start_place_pending: 1
    });

    let { body } = await ctx.request('GET', `/entries/${id}`);
    assert.equal(body.startPlacePending, true);

    ({ body } = await ctx.request('PATCH', `/entries/${id}`, {
      startPosition: { lat: 46.06, lon: -1.61 }
    }));
    assert.equal(body.startPlaceName, '46.0600N 1.6100W');
    assert.equal(body.startPlacePending, true);

    ({ body } = await ctx.request('PATCH', `/entries/${id}`, { startPlaceName: 'Chassiron' }));
    assert.equal(body.startPlaceName, 'Chassiron');
    assert.equal(body.startPlacePending, false);
  });

  it('name the arrival when a passage is closed by hand', async () => {
    const id = insertEntry(ctx.db, { state: 'active' });

    const { body } = await ctx.request('POST', `/entries/${id}/close`);

    assert.equal(body.endPlaceName, '46.5000N 1.7900W');
    assert.equal(body.endPlacePending, true);
  });
});
