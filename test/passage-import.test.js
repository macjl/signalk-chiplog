const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { convertGeoJson, importPassages } = require('../scripts/import-postgsail');
const { at, insertEntry, startServer } = require('./helpers');

const START = { lat: 46.1466, lon: -1.1686 };
const END = { lat: 46.2044, lon: -1.3647 };

// A passage with nothing but its bounds, for the ones only their dates matter to.
const bare = (startHours, endHours) =>
  passage({
    startTime: at(startHours),
    endTime: at(endHours),
    trackPoints: [],
    observations: [],
    propulsion: []
  });

function passage(overrides = {}) {
  return {
    startTime: at(0),
    endTime: at(2),
    startPosition: START,
    endPosition: END,
    startPlaceName: 'La Rochelle',
    endPlaceName: 'Saint-Martin',
    trackPoints: [
      { time: at(0), lat: START.lat, lon: START.lon, sog: 2, cog: 1, tws: 6, twd: 2 },
      { time: at(1), lat: 46.17, lon: -1.25, sog: 3 },
      { time: at(2), lat: END.lat, lon: END.lon, sog: 0 }
    ],
    observations: [
      { time: at(0), reason: 'entry_start', position: START, sog: 2, airTemp: 295, depth: null },
      { time: at(2), reason: 'entry_end', position: END, waterTemp: 290 }
    ],
    startTanks: [{ type: 'fuel', id: '0', level: 0.95 }],
    startBatteries: [{ id: 'house', voltage: 13.3, stateOfCharge: 0.6 }],
    propulsion: [
      { type: 'engine', startTime: at(0), endTime: at(0.5) },
      { type: 'sail', startTime: at(0.5), endTime: at(2) }
    ],
    ...overrides
  };
}

describe('POST /entries', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('adds a closed passage with its track, readings and engine/sail periods', async () => {
    const { status, body } = await ctx.request('POST', '/entries', passage());

    assert.equal(status, 201);
    assert.equal(body.state, 'closed');
    assert.equal(body.startTime, at(0));
    assert.equal(body.endTime, at(2));
    assert.equal(body.startPlaceName, 'La Rochelle');
    assert.equal(body.endPlaceName, 'Saint-Martin');
    assert.equal(body.startPlacePending, false);
    assert.equal(body.engineDuration, 1800);
    assert.equal(body.sailDuration, 5400);
    assert.equal(body.maxSpeed, 3);
    assert.deepEqual(body.startTanks, [{ type: 'fuel', id: '0', level: 0.95 }]);
    assert.deepEqual(body.startBatteries, [{ id: 'house', voltage: 13.3, stateOfCharge: 0.6 }]);
    assert.deepEqual(body.counts, { trackPoints: 3, observations: 2, events: 0 });
    // Sum over the track, as for a passage logged live: about 16 km here.
    assert.ok(body.distance > 16000 && body.distance < 17000, `distance ${body.distance}`);

    const { body: observations } = await ctx.request('GET', `/entries/${body.id}/observations`);
    assert.equal(observations.items[0].airTemp, 295);
    assert.equal(observations.items[1].waterTemp, 290);
    assert.equal(observations.items[1].reason, 'entry_end');
    assert.deepEqual(observations.items[0].position, START);
  });

  it('uses the distance it is given', async () => {
    const { body } = await ctx.request('POST', '/entries', passage({ distance: 12345 }));

    assert.equal(body.distance, 12345);
  });

  it('turns the names into places, and reuses them for the next passage', async () => {
    await ctx.request('POST', '/entries', passage());
    const { body: second } = await ctx.request('POST', '/entries', {
      ...bare(3, 5),
      startPlaceName: 'Marina'
    });

    const { body: places } = await ctx.request('GET', '/places');
    assert.deepEqual(places.items.map((place) => place.name).sort(), [
      'La Rochelle',
      'Saint-Martin'
    ]);
    assert.ok(places.items.every((place) => place.source === 'manual'));
    // Named as the source says, but tied to the place already there.
    assert.equal(second.startPlaceName, 'Marina');
    assert.equal(second.startPlaceId, places.items.find((p) => p.name === 'La Rochelle').id);
  });

  it('takes a place of the same name a little further off for the same place', async () => {
    await ctx.request('POST', '/entries', passage());

    // About 400 m from La Rochelle, past the 200 m radius: same name, same place.
    const { body } = await ctx.request('POST', '/entries', {
      ...bare(3, 5),
      startPosition: { lat: START.lat + 0.0036, lon: START.lon },
      startPlaceName: 'la rochelle'
    });

    const { body: places } = await ctx.request('GET', '/places');
    assert.equal(places.total, 2);
    assert.equal(body.startPlaceId, places.items.find((p) => p.name === 'La Rochelle').id);
  });

  it('does not take a place of the same name further than 500 m for the same place', async () => {
    await ctx.request('POST', '/entries', passage());

    // About 600 m off.
    await ctx.request('POST', '/entries', {
      ...bare(3, 5),
      startPosition: { lat: START.lat + 0.0054, lon: START.lon },
      startPlaceName: 'La Rochelle'
    });

    const { body: places } = await ctx.request('GET', '/places');
    assert.equal(places.total, 3);
  });

  it('names a passage with no place name from its position, pending geocoding', async () => {
    const { body } = await ctx.request('POST', '/entries', {
      startTime: at(0),
      endTime: at(1),
      startPosition: START,
      endPosition: END
    });

    assert.equal(body.startPlaceName, '46.1466N 1.1686W');
    assert.equal(body.startPlacePending, true);
    assert.deepEqual(body.counts, { trackPoints: 0, observations: 0, events: 0 });
  });

  it('leaves a passage that detection would not reopen', async () => {
    const { body } = await ctx.request('POST', '/entries', passage());

    const row = ctx.db.prepare('SELECT closed_by, landmarks_pending FROM log_entries').get();
    assert.equal(body.state, 'closed');
    assert.equal(row.closed_by, null);
    assert.equal(row.landmarks_pending, 1);
  });

  it('refuses a passage overlapping one on record, and stores nothing of it', async () => {
    await ctx.request('POST', '/entries', passage());

    const { status, body } = await ctx.request('POST', '/entries', bare(1, 3));

    assert.equal(status, 409);
    assert.equal(body.error.code, 'entry_overlaps');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n, 1);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM track_points').get().n, 3);
  });

  it('accepts a passage that starts where another ends', async () => {
    await ctx.request('POST', '/entries', passage());

    const { status } = await ctx.request('POST', '/entries', bare(2, 4));

    assert.equal(status, 201);
  });

  it('refuses a passage overlapping the one in progress', async () => {
    insertEntry(ctx.db, { state: 'active', start_time: at(1) });

    const { status, body } = await ctx.request('POST', '/entries', passage());

    assert.equal(status, 409);
    assert.equal(body.error.code, 'entry_overlaps');
  });

  it('rejects readings outside the passage', async () => {
    const outside = [{ time: at(3), lat: 46, lon: -1 }];

    for (const [field, value] of [
      ['trackPoints', outside],
      ['observations', [{ time: at(-1), reason: 'periodic' }]],
      ['propulsion', [{ type: 'sail', startTime: at(1), endTime: at(3) }]]
    ]) {
      const { status, body } = await ctx.request('POST', '/entries', passage({ [field]: value }));
      assert.equal(status, 400, field);
      assert.equal(body.error.code, 'invalid_request');
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n, 0);
  });

  it('rejects a malformed request', async () => {
    const bad = [
      { ...passage(), endTime: at(-1) },
      { ...passage(), extra: 1 },
      { ...passage(), startTanks: [{ type: 'fuel', id: '0' }] },
      { ...passage(), startTanks: [{ type: 'fuel', level: 0.5 }] },
      { ...passage(), startTanks: [{ type: 'fuel', id: '0', level: -1 }] },
      { ...passage(), startBatteries: [{ id: 'house' }] },
      { ...passage(), startBatteries: [{ voltage: 12 }] },
      { ...passage(), trackPoints: 'no' },
      { ...passage(), trackPoints: [{ time: at(0), lat: 91, lon: 0 }] },
      { ...passage(), trackPoints: [{ time: at(0), lat: 1, lon: 1, sog: 'fast' }] },
      { ...passage(), observations: [{ time: at(0), reason: 'whenever' }] },
      { ...passage(), propulsion: [{ type: 'steam', startTime: at(0), endTime: at(1) }] },
      { ...passage(), propulsion: [{ type: 'sail', startTime: at(1), endTime: at(0) }] },
      { endTime: at(1) }
    ];
    for (const body of bad) {
      const response = await ctx.request('POST', '/entries', body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    }
  });

  it('needs an administrator', () => {
    assert.ok(
      !ctx.permissions.some((route) => route.path === '/api/entries' && route.method === 'POST')
    );
  });
});

// One trip of four positions and one of three, in PostgSail's units.
function feature(time, lon, lat, properties = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      time,
      status: 'sailing',
      speedoverground: 5,
      courseovergroundtrue: 90,
      heading: 450,
      truewindspeed: 10,
      truewinddirection: -90,
      windangleapparent: -120,
      windspeedapparent: 12,
      outsidetemperature: 300,
      watertemperature: 301,
      outsidepressure: null,
      depth: null,
      tanklevel: 0.95,
      voltage: 13.34000015258789,
      stateofcharge: 0.5979999923706054,
      ...properties
    }
  };
}

const EXPORT = {
  type: 'FeatureCollection',
  features: [
    feature('2026-08-16T12:00:00+00:00', -61.0, 14.5, {
      trip: { name: 'Les Trois-Îlets → Anse Noire', distance: 1.2, duration: 'PT1H' }
    }),
    feature('2026-08-16T12:30:00.500+00:00', -61.01, 14.51, { status: 'motoring' }),
    feature('2026-08-16T13:00:00+00:00', -61.02, 14.52, { status: 'motoring' }),
    feature('2026-08-16T13:20:00+00:00', -61.03, 14.53, { status: 'moored', speedoverground: 0 }),
    feature('2026-08-16T15:00:00+00:00', -61.03, 14.53, {
      trip: { name: 'Renamed by hand', distance: 0.1, duration: 'PT1H' }
    }),
    feature('2026-08-16T15:10:00+00:00', -61.04, 14.54, { outsidepressure: 1013 }),
    feature('2026-08-16T16:00:00+00:00', -61.05, 14.55, { trip: { name: 'Lonely' } })
  ]
};

describe('PostgSail conversion', () => {
  it('cuts the export into passages at each trip, leaving out one with a single position', () => {
    const { passages, skipped } = convertGeoJson(EXPORT);

    assert.equal(skipped, 1);
    assert.equal(passages.length, 2);
    assert.equal(passages[0].body.startTime, '2026-08-16T12:00:00.000Z');
    assert.equal(passages[0].body.endTime, '2026-08-16T13:20:00.000Z');
    assert.equal(passages[0].body.trackPoints.length, 4);
    assert.equal(passages[1].body.trackPoints.length, 2);
  });

  it('notes the fuel level of the first position as the tank at departure', () => {
    const [first, second] = convertGeoJson(EXPORT).passages;

    assert.deepEqual(first.body.startTanks, [{ type: 'fuel', id: '0', level: 0.95 }]);
    assert.deepEqual(second.body.startTanks, [{ type: 'fuel', id: '0', level: 0.95 }]);
  });

  it('notes the house battery of the first position at departure', () => {
    const [first] = convertGeoJson(EXPORT).passages;

    assert.deepEqual(first.body.startBatteries, [
      { id: 'house', voltage: 13.34, stateOfCharge: 0.598 }
    ]);
  });

  it('reads the places from the trip name, when it has them', () => {
    const [first, second] = convertGeoJson(EXPORT).passages;

    assert.equal(first.body.startPlaceName, 'Les Trois-Îlets');
    assert.equal(first.body.endPlaceName, 'Anse Noire');
    assert.deepEqual(first.body.startPosition, { lat: 14.5, lon: -61 });
    assert.equal(second.body.startPlaceName, undefined);
  });

  it('converts to Signal K units', () => {
    const [{ body }] = convertGeoJson(EXPORT).passages;
    const point = body.trackPoints[0];

    assert.equal(point.time, '2026-08-16T12:00:00.000Z');
    assert.equal(point.sog, 2.572);
    assert.equal(point.tws, 5.144);
    assert.equal(point.aws, 6.173);
    assert.equal(point.heading, 1.5708); // 450° is 90°
    assert.equal(point.twd, 4.71239); // -90° is 270°
    assert.equal(point.cog, 1.5708);
    assert.equal(point.awa, -2.0944);
    assert.equal(body.observations[0].airTemp, 300);
  });

  it('gives instrument snapshots at departure, arrival and on the clock', () => {
    const [{ body }] = convertGeoJson(EXPORT).passages;

    assert.deepEqual(
      body.observations.map((o) => [o.reason, o.time]),
      [
        ['entry_start', '2026-08-16T12:00:00.000Z'],
        ['periodic', '2026-08-16T13:00:00.000Z'],
        ['entry_end', '2026-08-16T13:20:00.000Z']
      ]
    );
    const none = convertGeoJson(EXPORT, { observationIntervalMinutes: 0 }).passages[0].body;
    assert.deepEqual(
      none.observations.map((o) => o.reason),
      ['entry_start', 'entry_end']
    );
  });

  it('takes a pressure below 2000 for hectopascals', () => {
    const [, { body }] = convertGeoJson(EXPORT).passages;

    assert.equal(body.observations[1].pressure, 101300);
  });

  it('makes engine and sail periods from the status, moored not being under way', () => {
    const [{ body }] = convertGeoJson(EXPORT).passages;

    assert.deepEqual(body.propulsion, [
      { type: 'sail', startTime: '2026-08-16T12:00:00.000Z', endTime: '2026-08-16T12:30:00.500Z' },
      { type: 'engine', startTime: '2026-08-16T12:30:00.500Z', endTime: '2026-08-16T13:20:00.000Z' }
    ]);
  });

  it('refuses a file that is not a FeatureCollection', () => {
    assert.throws(() => convertGeoJson({ type: 'Feature' }), /FeatureCollection/);
  });
});

describe('PostgSail import through the API', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('imports every passage, and skips them all when run again', async () => {
    const { passages } = convertGeoJson(EXPORT);
    const log = [];

    const first = await importPassages(passages, { apiUrl: ctx.baseUrl, log: (l) => log.push(l) });
    const again = await importPassages(passages, { apiUrl: ctx.baseUrl });

    assert.deepEqual(first, { imported: 2, alreadyThere: 0, failed: null });
    assert.deepEqual(again, { imported: 0, alreadyThere: 2, failed: null });
    assert.match(log[0], /^\[1\/2\] Les Trois-Îlets → Anse Noire .*imported as entry 1$/);
    const { body } = await ctx.request('GET', '/entries');
    assert.equal(body.total, 2);
    const entry = body.items.at(-1);
    assert.equal(entry.startPlaceName, 'Les Trois-Îlets');
    assert.equal(entry.engineDuration, 3000);
    assert.equal(entry.sailDuration, 1800);
  });

  it('stops at a failure other than an overlap', async () => {
    const { passages } = convertGeoJson(EXPORT);
    passages[0].body.propulsion = [{ type: 'steam', startTime: 'x', endTime: 'y' }];

    const summary = await importPassages(passages, { apiUrl: ctx.baseUrl });

    assert.equal(summary.imported, 0);
    assert.match(summary.failed, /^\[1\/2\] .*HTTP 400 /);
  });

  it('reports a server that cannot be reached', async () => {
    const { passages } = convertGeoJson(EXPORT);

    const summary = await importPassages(passages, { apiUrl: 'http://127.0.0.1:1/api' });

    assert.equal(summary.imported, 0);
    assert.match(summary.failed, /^\[1\/2\]/);
  });
});
