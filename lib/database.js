const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATABASE_FILENAME = 'chiplog.sqlite';

// Manoeuvre shortcuts shipped with the plugin (SPEC §4.3). Users may disable or
// reorder them and add their own; a later migration adds new built-in ones.
const BUILTIN_MANOEUVRE_TYPES = [
  ['tack', 'Tack', 10],
  ['gybe', 'Gybe', 20],
  ['reef_in', 'Reef in', 30],
  ['reef_out', 'Shake out reef', 40],
  ['sail_change', 'Sail change', 50],
  ['anchor_down', 'Anchor down', 60],
  ['anchor_up', 'Anchor up', 70],
  ['moor', 'Moor', 80],
  ['cast_off', 'Cast off', 90],
  ['watch_change', 'Watch change', 100]
];

// Append-only: each entry is applied once, in order, and its index becomes the
// database's user_version. Never edit or reorder an already-released migration.
const MIGRATIONS = [
  `
  -- Units follow Signal K: angles in radians, speeds in m/s, distances in
  -- metres, durations in seconds, pressure in Pa, temperatures in K.
  -- Timestamps are ISO 8601 UTC text with millisecond precision.

  CREATE TABLE places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('geocoding', 'manual')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Supports the bounding-box prefilter of the radius match; the exact
  -- distance test then runs in application code.
  CREATE INDEX idx_places_position ON places (lat, lon);

  CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed')),
    start_time TEXT NOT NULL,
    end_time TEXT,
    -- Set when the vessel stops, cleared if it moves again before the
    -- configured tolerance elapses (SPEC §3.1).
    stopped_since TEXT,
    start_lat REAL,
    start_lon REAL,
    end_lat REAL,
    end_lon REAL,
    start_place_id INTEGER REFERENCES places (id) ON DELETE SET NULL,
    end_place_id INTEGER REFERENCES places (id) ON DELETE SET NULL,
    -- Denormalised on purpose: the logbook records the name as it stood at the
    -- time, so renaming a place later must not rewrite past entries.
    start_place_name TEXT,
    end_place_name TEXT,
    distance REAL NOT NULL DEFAULT 0,
    engine_duration INTEGER NOT NULL DEFAULT 0,
    sail_duration INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_time IS NULL OR end_time >= start_time),
    CHECK (state = 'active' OR end_time IS NOT NULL)
  );

  CREATE INDEX idx_log_entries_start_time ON log_entries (start_time);

  -- One vessel per instance, passages are sequential: at most one open entry.
  CREATE UNIQUE INDEX idx_log_entries_single_active
    ON log_entries (state) WHERE state = 'active';

  -- Dense geometry for the map and the GPX export (SPEC §4.1). Deliberately
  -- narrow: instrument readings live in observations instead.
  CREATE TABLE track_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    time TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    sog REAL,
    cog REAL
  );

  CREATE INDEX idx_track_points_entry_time ON track_points (entry_id, time);

  -- Sparse instrument snapshots: the rows the facsimile PDF renders as
  -- logbook lines (SPEC §4.5). Every reading is nullable, since a boat may
  -- lack any given sensor (SPEC §4.7).
  CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    time TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('periodic', 'entry_start', 'entry_end', 'event')),
    lat REAL,
    lon REAL,
    sog REAL,
    cog REAL,
    heading REAL,
    stw REAL,
    twd REAL,
    tws REAL,
    awa REAL,
    aws REAL,
    depth REAL,
    pressure REAL,
    air_temp REAL,
    water_temp REAL,
    trip_log REAL,
    engine_runtime REAL
  );

  CREATE INDEX idx_observations_entry_time ON observations (entry_id, time);

  CREATE TABLE propulsion_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('engine', 'sail')),
    start_time TEXT NOT NULL,
    end_time TEXT,
    -- 'manual' once a user correction has overridden the detection (SPEC §4.2).
    source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
    average_rpm REAL,
    CHECK (end_time IS NULL OR end_time >= start_time)
  );

  CREATE INDEX idx_propulsion_segments_entry_time
    ON propulsion_segments (entry_id, start_time);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    time TEXT NOT NULL,
    type TEXT NOT NULL CHECK (
      type IN (
        'manoeuvre',
        'text_annotation',
        'handwritten_annotation',
        'sk_alarm',
        'autopilot',
        'weather_threshold',
        'manual_correction'
      )
    ),
    -- Qualifies the type: manoeuvre key, Signal K notification path, autopilot
    -- state. Intentionally not a foreign key, so history survives a manoeuvre
    -- type being deleted.
    subtype TEXT,
    lat REAL,
    lon REAL,
    comment TEXT,
    -- JSON, for structured detail only: handwritten strokes, sail selection,
    -- the before/after of a correction.
    payload TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_events_entry_time ON events (entry_id, time);
  CREATE INDEX idx_events_type ON events (type);

  CREATE TABLE manoeuvre_types (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );
  `,
  `
  -- Last time passage detection saw the vessel moving, refreshed about once a
  -- minute while under way. After a restart it dates the end of a passage that
  -- stopped while the plugin was not running.
  ALTER TABLE log_entries ADD COLUMN last_moving_at TEXT;
  `,
  `
  -- A place name generated from coordinates while online geocoding has not
  -- yet answered for that departure or arrival. Cleared once resolved, or as
  -- soon as someone types a name.
  ALTER TABLE log_entries ADD COLUMN start_place_pending INTEGER NOT NULL DEFAULT 0
    CHECK (start_place_pending IN (0, 1));
  ALTER TABLE log_entries ADD COLUMN end_place_pending INTEGER NOT NULL DEFAULT 0
    CHECK (end_place_pending IN (0, 1));
  `,
  `
  -- The departure manoeuvre (cast off, anchor up) that opened this passage by
  -- hand before the vessel moved. Undoing that manoeuvre before any movement
  -- removes the passage with it.
  ALTER TABLE log_entries ADD COLUMN opened_by_event_id INTEGER
    REFERENCES events (id) ON DELETE SET NULL;

  -- Idempotency key chosen by the client, so an entry replayed from the
  -- tablet's offline queue after a lost response is not logged twice.
  ALTER TABLE events ADD COLUMN client_ref TEXT;
  CREATE UNIQUE INDEX idx_events_client_ref ON events (client_ref)
    WHERE client_ref IS NOT NULL;

  -- Finds the vessel's position at the time of an entry logged after the fact,
  -- before knowing which passage it belongs to.
  CREATE INDEX idx_track_points_time ON track_points (time);
  `
];

function seedBuiltinManoeuvreTypes(db) {
  const insert = db.prepare(
    `INSERT INTO manoeuvre_types (key, label, sort_order, builtin)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (key) DO NOTHING`
  );
  for (const [key, label, sortOrder] of BUILTIN_MANOEUVRE_TYPES) {
    insert.run(key, label, sortOrder);
  }
}

function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSchemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function migrate(db) {
  const currentVersion = getSchemaVersion(db);

  for (let version = currentVersion; version < MIGRATIONS.length; version += 1) {
    withTransaction(db, () => {
      db.exec(MIGRATIONS[version]);
      if (version === 0) {
        seedBuiltinManoeuvreTypes(db);
      }
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }

  return { from: currentVersion, to: MIGRATIONS.length };
}

function openDatabase(dataDirPath) {
  const db = new DatabaseSync(path.join(dataDirPath, DATABASE_FILENAME));

  // WAL keeps reads working while a passage is being written, and survives
  // the abrupt power cuts a boat installation gets.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const migrated = migrate(db);

  return { db, migrated };
}

module.exports = { openDatabase, withTransaction, getSchemaVersion, DATABASE_FILENAME };
