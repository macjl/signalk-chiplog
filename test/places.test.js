const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { distanceBetween, findNearestPlace } = require('../lib/places');
const { T0, startServer, insert, insertEntry } = require('./helpers');

function memoryPlaces(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, lat REAL, lon REAL, source TEXT, created_at TEXT, updated_at TEXT)'
  );
  const statement = db.prepare('INSERT INTO places (name, lat, lon) VALUES (?, ?, ?)');
  for (const [name, lat, lon] of rows) {
    statement.run(name, lat, lon);
  }
  return db;
}

describe('place matching', () => {
  it('measures great-circle distance', () => {
    // One arc-minute of latitude is one nautical mile.
    const distance = distanceBetween({ lat: 46, lon: -1 }, { lat: 46 + 1 / 60, lon: -1 });
    assert.ok(Math.abs(distance - 1852) < 5, `expected ~1852 m, got ${distance}`);
  });

  it('returns the nearest place within the radius', () => {
    const db = memoryPlaces([
      ['Far', 46.01, -1],
      ['Near', 46.0005, -1]
    ]);
    assert.equal(findNearestPlace(db, { lat: 46, lon: -1 }, 200).name, 'Near');
    assert.equal(findNearestPlace(db, { lat: 46, lon: -1 }, 10), null);
  });

  it('matches across the antimeridian', () => {
    const db = memoryPlaces([['Taveuni', -16.8, 179.9999]]);
    assert.equal(findNearestPlace(db, { lat: -16.8, lon: -179.9999 }, 200).name, 'Taveuni');
  });
});

describe('places API', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('lists places sorted by name', async () => {
    for (const name of ['Rochefort', 'Île de Ré']) {
      insert(ctx.db, 'places', {
        name,
        lat: 46,
        lon: -1,
        source: 'geocoding',
        created_at: T0,
        updated_at: T0
      });
    }
    const { body } = await ctx.request('GET', '/places');
    assert.deepEqual(
      body.items.map((place) => place.name),
      ['Île de Ré', 'Rochefort']
    );
  });

  it('renaming makes the place manual', async () => {
    const id = insert(ctx.db, 'places', {
      name: 'Port',
      lat: 46,
      lon: -1,
      source: 'geocoding',
      created_at: T0,
      updated_at: T0
    });
    const { status, body } = await ctx.request('PATCH', `/places/${id}`, {
      name: 'Port des Minimes'
    });
    assert.equal(status, 200);
    assert.equal(body.name, 'Port des Minimes');
    assert.equal(body.source, 'manual');
  });

  it('deleting a place keeps the names recorded on entries', async () => {
    const placeId = insert(ctx.db, 'places', {
      name: 'Minimes',
      lat: 46,
      lon: -1,
      source: 'manual',
      created_at: T0,
      updated_at: T0
    });
    const entryId = insertEntry(ctx.db, { start_place_id: placeId, start_place_name: 'Minimes' });

    assert.equal((await ctx.request('DELETE', `/places/${placeId}`)).status, 204);

    const { body } = await ctx.request('GET', `/entries/${entryId}`);
    assert.equal(body.startPlaceId, null);
    assert.equal(body.startPlaceName, 'Minimes');
  });
});
