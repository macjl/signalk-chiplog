const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATABASE_FILENAME = 'chiplog.sqlite';

// Append-only: each entry is applied once, in order, and its index becomes the
// database's user_version. Never edit or reorder an already-released migration.
const MIGRATIONS = [
  `
  CREATE TABLE places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('geocoding', 'manual')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time TEXT NOT NULL,
    end_time TEXT,
    start_lat REAL,
    start_lon REAL,
    end_lat REAL,
    end_lon REAL,
    start_place_name TEXT,
    end_place_name TEXT,
    start_place_id INTEGER REFERENCES places (id) ON DELETE SET NULL,
    end_place_id INTEGER REFERENCES places (id) ON DELETE SET NULL,
    distance REAL,
    engine_duration INTEGER,
    sail_duration INTEGER
  );

  CREATE INDEX idx_log_entries_start_time ON log_entries (start_time);

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

  CREATE TABLE propulsion_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('engine', 'sail')),
    start_time TEXT NOT NULL,
    end_time TEXT,
    meta TEXT
  );

  CREATE INDEX idx_propulsion_segments_entry_time ON propulsion_segments (entry_id, start_time);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    time TEXT NOT NULL,
    lat REAL,
    lon REAL,
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
    payload TEXT
  );

  CREATE INDEX idx_events_entry_time ON events (entry_id, time);
  `
];

function migrate(db) {
  const { user_version: currentVersion } = db.prepare('PRAGMA user_version').get();

  for (let version = currentVersion; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
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

module.exports = { openDatabase, DATABASE_FILENAME };
