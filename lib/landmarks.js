const { withTransaction } = require('./database');

// The gazetteer of amers (SPEC §4.13) and the bookkeeping of which areas it
// covers. Reading a position against a landmark -- the bearing and distance a
// logbook line shows -- happens in `public/js/landmarks.mjs`, shared with the
// webapp and the PDF; this module only stores and hands out the landmarks.

const METRES_PER_NM = 1852;
const METRES_PER_DEGREE = 111320;

// The widest range any kind of amer is named from, and so the margin a cell is
// fetched with. Kept in step with the largest entry of KIND_RANGE_M in
// public/js/landmarks.mjs, which a test checks.
const MAX_RELEVANT_M = 15 * METRES_PER_NM;

// Landmarks are fetched by half-degree cell -- about 30 nm of latitude, a
// day's sailing across, so a coastal cruise costs a handful of requests.
const CELL_DEGREES = 0.5;

// SQLite's CAST truncates towards zero, which is not FLOOR for a negative
// latitude or longitude; the offsets keep the value positive so it is. They
// are wide enough for any coordinate (lat / 0.5 >= -180, lon / 0.5 >= -360).
const LAT_OFFSET = 400;
const LON_OFFSET = 800;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function toLandmark(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    position: { lat: row.lat, lon: row.lon },
    lightRange: row.light_range,
    osm: { type: row.osm_type, id: row.osm_id },
    updatedAt: row.updated_at
  };
}

// Every position a passage's journal shows a line for: its track, the readings
// and events on it, and its departure and arrival.
const POSITIONS = `
  SELECT lat, lon FROM track_points WHERE entry_id = ?
  UNION ALL
  SELECT lat, lon FROM observations WHERE entry_id = ? AND lat IS NOT NULL
  UNION ALL
  SELECT lat, lon FROM events WHERE entry_id = ? AND lat IS NOT NULL
  UNION ALL
  SELECT start_lat, start_lon FROM log_entries WHERE id = ? AND start_lat IS NOT NULL
  UNION ALL
  SELECT end_lat, end_lon FROM log_entries WHERE id = ? AND end_lat IS NOT NULL
`;

function entryParams(entryId) {
  return [entryId, entryId, entryId, entryId, entryId];
}

// The cells a passage has been in. Its bounding box would do for a coastal
// hop, but a long passage's box covers cells it never came near -- each of
// which would cost a request.
function entryCells(db, entryId) {
  return db
    .prepare(
      `SELECT DISTINCT
         CAST(lat / ${CELL_DEGREES} + ${LAT_OFFSET} AS INTEGER) - ${LAT_OFFSET} AS cell_lat,
         CAST(lon / ${CELL_DEGREES} + ${LON_OFFSET} AS INTEGER) - ${LON_OFFSET} AS cell_lon
       FROM (${POSITIONS})
       ORDER BY cell_lat, cell_lon`
    )
    .all(...entryParams(entryId))
    .map((row) => ({ cellLat: row.cell_lat, cellLon: row.cell_lon }));
}

function entryBounds(db, entryId) {
  const row = db
    .prepare(
      `SELECT MIN(lat) AS min_lat, MAX(lat) AS max_lat, MIN(lon) AS min_lon, MAX(lon) AS max_lon
       FROM (${POSITIONS})`
    )
    .get(...entryParams(entryId));
  return row?.min_lat === null || row?.min_lat === undefined
    ? null
    : { minLat: row.min_lat, maxLat: row.max_lat, minLon: row.min_lon, maxLon: row.max_lon };
}

// How many degrees MAX_RELEVANT_M is, at the latitude it is measured from:
// a degree of longitude shortens towards the poles.
function margins(latitude) {
  const latMargin = MAX_RELEVANT_M / METRES_PER_DEGREE;
  const cosLat = Math.cos(toRadians(Math.min(89, Math.abs(latitude))));
  return { latMargin, lonMargin: cosLat > 0.02 ? latMargin / cosLat : 180 };
}

// The area one cell is fetched for: the cell itself plus the margin, so a
// position anywhere inside it has every amer within range.
function cellBounds({ cellLat, cellLon }) {
  const south = cellLat * CELL_DEGREES;
  const north = south + CELL_DEGREES;
  const west = cellLon * CELL_DEGREES;
  const east = west + CELL_DEGREES;
  const { latMargin, lonMargin } = margins(Math.max(Math.abs(south), Math.abs(north)));
  return {
    south: Math.max(-90, south - latMargin),
    north: Math.min(90, north + latMargin),
    west: Math.max(-180, west - lonMargin),
    east: Math.min(180, east + lonMargin)
  };
}

// The landmarks any line of a passage's journal could be read against: the
// area it sailed through, widened by the range an amer is named from. Near the
// antimeridian the longitude window would wrap, so latitude alone filters
// there and the distance test -- which runs at read time -- stays exact.
function listEntryLandmarks(db, entryId) {
  const bounds = entryBounds(db, entryId);
  if (!bounds) {
    return [];
  }
  const { latMargin, lonMargin } = margins(
    Math.max(Math.abs(bounds.minLat), Math.abs(bounds.maxLat))
  );
  const south = bounds.minLat - latMargin;
  const north = bounds.maxLat + latMargin;
  const west = bounds.minLon - lonMargin;
  const east = bounds.maxLon + lonMargin;
  const rows =
    west < -180 || east > 180
      ? db.prepare('SELECT * FROM landmarks WHERE lat BETWEEN ? AND ?').all(south, north)
      : db
          .prepare('SELECT * FROM landmarks WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
          .all(south, north, west, east);
  return rows.map(toLandmark);
}

function isAreaFetched(db, { cellLat, cellLon }) {
  return (
    db
      .prepare('SELECT 1 FROM landmark_areas WHERE cell_lat = ? AND cell_lon = ?')
      .get(cellLat, cellLon) !== undefined
  );
}

// One fetched area, with the landmarks it found: written together, so a cell
// is only ever recorded as covered once its landmarks are in the table.
function saveArea(db, cell, landmarks, now) {
  withTransaction(db, () => {
    for (const landmark of landmarks) {
      db.prepare(
        `INSERT INTO landmarks
           (osm_type, osm_id, name, kind, lat, lon, light_range, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (osm_type, osm_id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           lat = excluded.lat,
           lon = excluded.lon,
           light_range = excluded.light_range,
           updated_at = excluded.updated_at`
      ).run(
        landmark.osmType,
        landmark.osmId,
        landmark.name,
        landmark.kind,
        landmark.lat,
        landmark.lon,
        landmark.lightRange,
        now,
        now
      );
    }
    db.prepare(
      `INSERT INTO landmark_areas (cell_lat, cell_lon, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT (cell_lat, cell_lon) DO UPDATE SET fetched_at = excluded.fetched_at`
    ).run(cell.cellLat, cell.cellLon, now);
  });
}

// The next cell to fetch, newest passage first, and the passage that wants it.
// A passage whose cells are all covered is no longer pending -- unless it is
// still open, since it may yet sail into a new cell.
function nextPendingArea(db) {
  const pending = db
    .prepare('SELECT id, state FROM log_entries WHERE landmarks_pending = 1 ORDER BY id DESC')
    .all();
  for (const entry of pending) {
    const missing = entryCells(db, entry.id).filter((cell) => !isAreaFetched(db, cell));
    if (missing.length > 0) {
      return { entryId: entry.id, cell: missing[0], remaining: missing.length };
    }
    if (entry.state !== 'active') {
      db.prepare('UPDATE log_entries SET landmarks_pending = 0 WHERE id = ?').run(entry.id);
    }
  }
  return null;
}

module.exports = {
  CELL_DEGREES,
  MAX_RELEVANT_M,
  cellBounds,
  entryBounds,
  entryCells,
  isAreaFetched,
  listEntryLandmarks,
  nextPendingArea,
  saveArea,
  toLandmark
};
