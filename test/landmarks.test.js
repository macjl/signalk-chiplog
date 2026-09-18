const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const {
  createLandmarkFinder,
  kindOf,
  landmarkFrom,
  overpassQuery,
  parseElements,
  LANDMARK_DEFAULTS
} = require('../lib/landmark-finder');
const {
  cellBounds,
  entryCells,
  isAreaFetched,
  listEntryLandmarks,
  nextPendingArea,
  saveArea,
  MAX_RELEVANT_M
} = require('../lib/landmarks');
const { insert, insertEntry, startServer, T0 } = require('./helpers');

// What the public Overpass instance answered around the Cap Ferret: the
// lighthouse is a building way with its centre, tagged as a landmark too.
const LIGHTHOUSE = {
  type: 'way',
  id: 715849418,
  center: { lat: 44.6459646, lon: -1.2488154 },
  tags: {
    building: 'yes',
    man_made: 'lighthouse',
    name: 'Phare du Cap-Ferret',
    'seamark:light:1:range': '22',
    'seamark:light:2:range': '14',
    'seamark:name': 'Cap Ferret',
    'seamark:type': 'landmark'
  }
};
const CAPE = {
  type: 'node',
  id: 7515678201,
  lat: 44.652747,
  lon: -1.1394754,
  tags: { name: "Pointe de l'Aiguillon", natural: 'cape' }
};
const HARBOUR = {
  type: 'node',
  id: 661146437,
  lat: 44.6616892,
  lon: -1.1527159,
  tags: { leisure: 'marina', name: 'Petit Port', 'seamark:type': 'harbour' }
};
const UNNAMED_HARBOUR = {
  type: 'way',
  id: 1,
  center: { lat: 44.66, lon: -1.15 },
  tags: { 'seamark:type': 'harbour' }
};
const CHANNEL_BEACON = {
  type: 'node',
  id: 2,
  lat: 44.66,
  lon: -1.16,
  tags: { name: '6 c', 'seamark:type': 'beacon_lateral' }
};

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body)
  });
}

describe('landmarks read from OpenStreetMap', () => {
  it('are the features a position is traditionally read against', () => {
    assert.equal(kindOf(LIGHTHOUSE.tags), 'lighthouse');
    assert.equal(kindOf(CAPE.tags), 'cape');
    assert.equal(kindOf(HARBOUR.tags), 'harbour');
    assert.equal(kindOf({ 'seamark:type': 'light_minor' }), 'light');
    assert.equal(kindOf({ 'seamark:type': 'beacon_isolated_danger' }), 'beacon');
    // A lateral or cardinal mark is named after the channel, not the place.
    assert.equal(kindOf(CHANNEL_BEACON.tags), null);
  });

  it('take the local name, and the greatest range of a sectored light', () => {
    const landmark = landmarkFrom(LIGHTHOUSE);

    assert.equal(landmark.name, 'Phare du Cap-Ferret');
    assert.equal(landmark.kind, 'lighthouse');
    assert.equal(landmark.lightRange, 22 * 1852);
    // A way is placed at the centre Overpass was asked for.
    assert.deepEqual([landmark.lat, landmark.lon], [44.6459646, -1.2488154]);
  });

  it('leave out what has no name to tell the crew', () => {
    assert.equal(landmarkFrom(UNNAMED_HARBOUR), null);
    assert.deepEqual(
      parseElements([LIGHTHOUSE, UNNAMED_HARBOUR, CHANNEL_BEACON, CAPE]).map((one) => one.name),
      ['Phare du Cap-Ferret', "Pointe de l'Aiguillon"]
    );
  });

  it('are fetched for as far out as any kind of amer is named from', async () => {
    const { KIND_RANGE_M } = await import('../public/js/landmarks.mjs');

    assert.equal(Math.max(...Object.values(KIND_RANGE_M)), MAX_RELEVANT_M);
  });

  it('are asked for over the cell and the margin an amer can be seen across', () => {
    const query = overpassQuery(cellBounds({ cellLat: 89, cellLon: -3 }));

    assert.match(query, /^\[out:json\]\[timeout:60\];/);
    // The cell is 44.5..45°N, 1.5..2°W; the margin widens it, more in
    // longitude than in latitude at that latitude.
    assert.match(query, /nwr\["man_made"="lighthouse"\]\(44\.2504,-1\.8529,45\.2496,-0\.6471\);/);
    assert.match(query, /out tags center;$/);
  });
});

describe('landmark areas', () => {
  let dataDir;
  let db;

  const cell = { cellLat: 89, cellLon: -3 };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-landmarks-'));
    ({ db } = openDatabase(dataDir));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const passage = (fields = {}) =>
    insertEntry(db, { start_lat: 44.66, start_lon: -1.15, ...fields });

  it('are the half-degree cells a passage has positions in', () => {
    const id = passage({ end_lat: 45.2, end_lon: -1.6 });
    insert(db, 'track_points', { entry_id: id, time: T0, lat: 44.9, lon: -1.6 });

    assert.deepEqual(entryCells(db, id), [
      { cellLat: 89, cellLon: -4 },
      { cellLat: 89, cellLon: -3 },
      { cellLat: 90, cellLon: -4 }
    ]);
  });

  it('cover a cell plus the range an amer carries', () => {
    const bounds = cellBounds(cell);
    const latMargin = MAX_RELEVANT_M / 111320;

    assert.ok(Math.abs(bounds.south - (44.5 - latMargin)) < 1e-9);
    assert.ok(Math.abs(bounds.north - (45 + latMargin)) < 1e-9);
    // A degree of longitude is shorter than one of latitude at 45°N.
    assert.ok(bounds.west < -1.5 - latMargin);
  });

  it('are fetched newest passage first, and each passage only until it is covered', () => {
    const older = passage();
    const newer = passage({
      start_time: '2026-09-20T08:00:00.000Z',
      end_time: '2026-09-20T12:00:00.000Z',
      start_lat: 46.2
    });

    assert.deepEqual(nextPendingArea(db), {
      entryId: newer,
      cell: { cellLat: 92, cellLon: -3 },
      remaining: 1
    });

    saveArea(db, { cellLat: 92, cellLon: -3 }, [], T0);
    assert.equal(nextPendingArea(db).entryId, older);

    saveArea(db, cell, [], T0);
    assert.equal(nextPendingArea(db), null);
    assert.equal(
      db.prepare('SELECT landmarks_pending AS p FROM log_entries WHERE id = ?').get(newer).p,
      0
    );
  });

  it('keep an open passage pending, since it sails on into new cells', () => {
    const active = passage({ state: 'active', end_time: null });
    saveArea(db, cell, [], T0);

    assert.equal(nextPendingArea(db), null);
    assert.equal(
      db.prepare('SELECT landmarks_pending AS p FROM log_entries WHERE id = ?').get(active).p,
      1
    );

    insert(db, 'track_points', { entry_id: active, time: T0, lat: 45.1, lon: -1.15 });
    assert.deepEqual(nextPendingArea(db).cell, { cellLat: 90, cellLon: -3 });
  });

  it('hand a passage the landmarks its journal could be read against', () => {
    const id = passage();
    saveArea(db, cell, parseElements([LIGHTHOUSE, CAPE, HARBOUR]), T0);
    // Well outside the passage's area, and so outside its list.
    saveArea(db, { cellLat: 60, cellLon: 0 }, parseElements([{ ...CAPE, id: 99, lat: 30.5 }]), T0);

    const landmarks = listEntryLandmarks(db, id);

    assert.deepEqual(landmarks.map((one) => one.name).sort(), [
      'Petit Port',
      'Phare du Cap-Ferret',
      "Pointe de l'Aiguillon"
    ]);
    const lighthouse = landmarks.find((one) => one.kind === 'lighthouse');
    assert.equal(lighthouse.lightRange, 22 * 1852);
    assert.deepEqual(lighthouse.position, { lat: 44.6459646, lon: -1.2488154 });
  });
});

describe('the landmark lookup', () => {
  let dataDir;
  let db;
  let requests;
  let answer;

  const settings = { landmarksEnabled: true, overpassUrl: LANDMARK_DEFAULTS.overpassUrl };

  const finder = () =>
    createLandmarkFinder({
      db,
      settings,
      userAgent: 'signalk-chiplog/test',
      fetch: (url, options) => {
        requests.push({ url, options });
        return answer();
      }
    });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-landmark-lookup-'));
    ({ db } = openDatabase(dataDir));
    insertEntry(db, { start_lat: 44.66, start_lon: -1.15 });
    requests = [];
    answer = () => jsonResponse({ elements: [LIGHTHOUSE, CAPE, UNNAMED_HARBOUR] });
    settings.landmarksEnabled = true;
    settings.overpassUrl = LANDMARK_DEFAULTS.overpassUrl;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fetches one area, records what it found and never asks for it again', async () => {
    const result = await finder().resolveNext();

    assert.equal(result.outcome, 'fetched');
    assert.equal(result.count, 2);
    assert.ok(isAreaFetched(db, { cellLat: 89, cellLon: -3 }));
    assert.deepEqual(
      db
        .prepare('SELECT name FROM landmarks ORDER BY name')
        .all()
        .map((row) => row.name),
      ['Phare du Cap-Ferret', "Pointe de l'Aiguillon"]
    );

    const { url, options } = requests[0];
    assert.equal(url, 'https://overpass-api.de/api/interpreter');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['User-Agent'], 'signalk-chiplog/test');
    assert.match(decodeURIComponent(options.body), /nwr\["natural"="cape"\]/);

    assert.equal((await finder().resolveNext()).outcome, 'idle');
    assert.equal(requests.length, 1);
  });

  it('updates a landmark OpenStreetMap has moved or renamed', async () => {
    await finder().resolveNext();
    db.prepare('DELETE FROM landmark_areas').run();
    answer = () =>
      jsonResponse({
        elements: [{ ...LIGHTHOUSE, tags: { ...LIGHTHOUSE.tags, name: 'Phare du Cap Ferret' } }]
      });

    await finder().resolveNext();

    const names = db
      .prepare("SELECT name FROM landmarks WHERE kind = 'lighthouse'")
      .all()
      .map((row) => row.name);
    assert.deepEqual(names, ['Phare du Cap Ferret']);
  });

  it('retries a busy Overpass, which answers trouble in the body', async () => {
    answer = () => jsonResponse({ elements: [], remark: 'runtime error: Dispatcher_Client' });

    const result = await finder().resolveNext();

    assert.equal(result.outcome, 'failed');
    assert.match(result.error.message, /runtime error/);
    assert.ok(result.retryInMs >= 5 * 60 * 1000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM landmark_areas').get().n, 0);
  });

  it('retries rate limiting and server trouble, and gives up on a refused query', async () => {
    answer = () => jsonResponse({}, 429);
    assert.equal((await finder().resolveNext()).outcome, 'failed');

    answer = () => jsonResponse({}, 400);
    const result = await finder().resolveNext();

    assert.equal(result.outcome, 'refused');
    assert.ok(isAreaFetched(db, { cellLat: 89, cellLon: -3 }));
  });

  it('asks for nothing at all when landmarks are turned off', async () => {
    settings.landmarksEnabled = false;

    assert.equal((await finder().resolveNext()).outcome, 'disabled');
    assert.equal(requests.length, 0);
  });
});

describe('landmarks through the API', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('lists those a passage can be read against, and 404s an unknown passage', async () => {
    const id = insertEntry(ctx.db, { start_lat: 44.66, start_lon: -1.15 });
    saveArea(ctx.db, { cellLat: 89, cellLon: -3 }, parseElements([LIGHTHOUSE, CAPE]), T0);

    const { status, body } = await ctx.request('GET', `/entries/${id}/landmarks`);

    assert.equal(status, 200);
    assert.equal(body.total, 2);
    assert.deepEqual(
      body.items.map((item) => [item.name, item.kind]).sort(),
      [
        ['Phare du Cap-Ferret', 'lighthouse'],
        ["Pointe de l'Aiguillon", 'cape']
      ].sort()
    );

    assert.equal((await ctx.request('GET', '/entries/9999/landmarks')).status, 404);
  });

  it('is empty for a passage whose area has not been fetched', async () => {
    const id = insertEntry(ctx.db, { start_lat: 44.66, start_lon: -1.15 });

    const { body } = await ctx.request('GET', `/entries/${id}/landmarks`);

    assert.deepEqual(body.items, []);
  });
});
