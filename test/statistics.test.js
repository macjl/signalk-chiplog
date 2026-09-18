const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { distanceBetween } = require('../lib/places');
const { T0, at, startServer, insert, insertEntry } = require('./helpers');

const KNOT = 1852 / 3600;

function place(db, name, countryCode) {
  return insert(db, 'places', {
    name,
    lat: 46,
    lon: -1,
    source: 'geocoding',
    country_code: countryCode,
    country_checked: 1,
    created_at: T0,
    updated_at: T0
  });
}

function point(db, entryId, time, lat, fields = {}) {
  insert(db, 'track_points', { entry_id: entryId, time, lat, lon: -1, ...fields });
}

describe('GET /statistics', () => {
  let ctx;
  let rochelle;
  let gijon;
  let plymouth;
  let short;
  let crossing;
  let hop;

  // Three passages, the middle one stopping over half way through:
  //   short    2 h,  20 km, La Rochelle -> Gijón       (FR -> ES)
  //   crossing 10 h, 60 km, Gijón -> Plymouth via A Coruña (ES -> GB)
  //   hop      1 h,   5 km, in progress
  beforeEach(async () => {
    ctx = await startServer();
    rochelle = place(ctx.db, 'La Rochelle', 'FR');
    gijon = place(ctx.db, 'Gijón', 'ES');
    plymouth = place(ctx.db, 'Plymouth', 'GB');

    short = insertEntry(ctx.db, {
      start_time: at(0),
      end_time: at(2),
      distance: 20000,
      start_place_id: rochelle,
      start_place_name: 'La Rochelle',
      end_place_id: gijon,
      end_place_name: 'Gijón'
    });
    point(ctx.db, short, at(0), 46.0, { sog: 3 * KNOT, tws: 6 });
    point(ctx.db, short, at(1), 46.1, { sog: 7 * KNOT, tws: 12, aws: 15 });

    crossing = insertEntry(ctx.db, {
      start_time: at(24),
      end_time: at(34),
      distance: 60000,
      start_place_id: gijon,
      start_place_name: 'Gijón',
      end_place_id: plymouth,
      end_place_name: 'Plymouth',
      engine_duration: 0,
      sail_duration: 36000
    });
    // Two legs, 0.2° and 0.3° of latitude, with the stop at at(28).
    point(ctx.db, crossing, at(24), 46.0, { sog: 5 * KNOT });
    point(ctx.db, crossing, at(26), 46.1, { sog: 9 * KNOT });
    point(ctx.db, crossing, at(28), 46.2, { sog: 4 * KNOT });
    point(ctx.db, crossing, at(29), 46.2, { sog: 0 });
    point(ctx.db, crossing, at(31), 46.3, { sog: 6 * KNOT });
    point(ctx.db, crossing, at(34), 46.5, { sog: 6 * KNOT });
    insert(ctx.db, 'events', {
      entry_id: crossing,
      time: at(28),
      type: 'stopover',
      comment: 'A Coruña',
      source: 'auto',
      created_at: at(28)
    });

    hop = insertEntry(ctx.db, {
      state: 'active',
      start_time: at(48),
      end_time: null,
      distance: 5000,
      start_place_id: plymouth,
      start_place_name: 'Plymouth'
    });
    // Nothing but an apparent wind reading, from an instrument snapshot.
    insert(ctx.db, 'observations', {
      entry_id: hop,
      time: at(48.5),
      reason: 'periodic',
      sog: 2 * KNOT,
      aws: 18
    });
  });

  afterEach(() => ctx.close());

  const statistics = async (query = '') => {
    const { status, body } = await ctx.request('GET', `/statistics${query}`);
    assert.equal(status, 200);
    return body;
  };

  it('is readable with read-only access', () => {
    assert.deepEqual(
      ctx.permissions.find((route) => route.path === '/api/statistics'),
      { method: 'GET', path: '/api/statistics', level: 'readonly' }
    );
  });

  it('totals the passages, and dates the first and the last', async () => {
    const body = await statistics();

    assert.equal(body.count, 3);
    assert.equal(body.distance, 85000);
    assert.equal(body.firstTime, at(0));
    assert.ok(body.lastTime > at(48), 'the passage in progress runs up to now');
    // 2 h + 10 h, plus everything the passage in progress has run so far.
    assert.ok(body.duration > 12 * 3600 + 3600);
  });

  it('reports the highest speed and wind, preferring true wind to apparent', async () => {
    const body = await statistics();

    assert.equal(body.maxSpeed, 9 * KNOT);
    // 12 m/s true wind on `short`; the apparent 15 and 18 m/s do not count
    // where a true wind was read, but stand in for `hop`, which has none.
    assert.equal(body.maxWindSpeed, 18);
    assert.equal(body.maxWindApparent, true);
    const wind = body.top.maxWindSpeed;
    assert.deepEqual(
      wind.map((passage) => [passage.id, passage.maxWindSpeed, passage.maxWindApparent]),
      [
        [hop, 18, true],
        [short, 12, false]
      ]
    );
  });

  it('ranks passages by each figure, the most first', async () => {
    const { top } = await statistics();
    const ids = (ranking) => top[ranking].map((passage) => passage.id);

    assert.deepEqual(ids('distance'), [crossing, short, hop]);
    // The passage in progress has been running since, by the clock, days ago.
    assert.deepEqual(ids('duration'), [hop, crossing, short]);
    assert.deepEqual(ids('maxSpeed'), [crossing, short, hop]);
    // 20 km in 2 h beats 60 km in 10 h; the passage in progress has covered
    // 5 km over all the time it has been open.
    assert.deepEqual(ids('averageSpeed'), [short, crossing, hop]);
    assert.equal(top.averageSpeed[0].averageSpeed, 20000 / 7200);
  });

  it('leaves a passage out of a ranking it has no figure for', async () => {
    const { top } = await statistics();

    assert.deepEqual(
      top.maxSpeed.map((passage) => passage.id),
      [crossing, short, hop]
    );
    assert.ok(!top.maxWindSpeed.some((passage) => passage.id === crossing));
  });

  it('keeps five passages at most', async () => {
    for (let index = 0; index < 6; index += 1) {
      insertEntry(ctx.db, { start_time: at(100 + index * 2), end_time: at(101 + index * 2) });
    }

    const { top } = await statistics();

    assert.equal(top.duration.length, 5);
  });

  it('finds the longest stretch without a stop, cutting a passage where it stopped over', async () => {
    const { longestNonStop } = await statistics();

    // `crossing` is 60 km on paper, but the track shows 0.2° (22 km) before
    // A Coruña and 0.3° (33 km) after it: the stop is what splits the passage,
    // and the stretch after it is the longest of the log.
    assert.equal(longestNonStop.entryId, crossing);
    assert.equal(longestNonStop.startPlaceName, 'A Coruña');
    assert.equal(longestNonStop.endPlaceName, 'Plymouth');
    assert.equal(longestNonStop.startTime, at(29));
    assert.equal(longestNonStop.endTime, at(34));
    assert.equal(longestNonStop.duration, 5 * 3600);
    const expected =
      distanceBetween({ lat: 46.2, lon: -1 }, { lat: 46.3, lon: -1 }) +
      distanceBetween({ lat: 46.3, lon: -1 }, { lat: 46.5, lon: -1 });
    assert.ok(Math.abs(longestNonStop.distance - expected) < 1e-6);
  });

  it('takes a passage that never stopped whole', async () => {
    const body = await statistics(`?to=${encodeURIComponent(at(3))}`);

    assert.equal(body.longestNonStop.entryId, short);
    assert.equal(body.longestNonStop.distance, 20000);
    assert.equal(body.longestNonStop.duration, 2 * 3600);
    assert.equal(body.longestNonStop.startPlaceName, 'La Rochelle');
    assert.equal(body.longestNonStop.endPlaceName, 'Gijón');
  });

  it('lists the countries of the departures and arrivals, in order of first visit', async () => {
    const { countries } = await statistics();

    assert.deepEqual(
      countries.map((country) => [country.code, country.firstTime]),
      [
        ['FR', at(0)],
        ['ES', at(2)],
        ['GB', at(34)]
      ]
    );
  });

  it('counts only the countries of the range, and skips a place with none', async () => {
    const nowhere = place(ctx.db, 'Open water', null);
    insertEntry(ctx.db, {
      start_time: at(200),
      end_time: at(201),
      start_place_id: nowhere,
      end_place_id: nowhere
    });

    const body = await statistics(
      `?from=${encodeURIComponent(at(24))}&to=${encodeURIComponent(at(100))}`
    );

    assert.deepEqual(
      body.countries.map((country) => country.code),
      ['ES', 'GB']
    );
    assert.equal(body.count, 2);
    assert.equal((await statistics(`?from=${encodeURIComponent(at(150))}`)).countries.length, 0);
  });

  it('filters like the entry list: on start time, from inclusive and to exclusive', async () => {
    const body = await statistics(
      `?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(24))}`
    );

    assert.equal(body.count, 1);
    assert.equal(body.top.distance[0].id, short);
  });

  it('is empty, not an error, when nothing matches', async () => {
    const body = await statistics(`?from=${encodeURIComponent('2030-01-01T00:00:00.000Z')}`);

    assert.equal(body.count, 0);
    assert.equal(body.distance, 0);
    assert.equal(body.firstTime, null);
    assert.equal(body.lastTime, null);
    assert.equal(body.maxSpeed, null);
    assert.equal(body.maxWindSpeed, null);
    assert.equal(body.longestNonStop, null);
    assert.deepEqual(body.countries, []);
    assert.deepEqual(body.top.duration, []);
  });

  it('rejects a range that is not a timestamp', async () => {
    const { status } = await ctx.request('GET', '/statistics?from=yesterday');

    assert.equal(status, 400);
  });
});
