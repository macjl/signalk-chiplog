# Data model

The authoritative schema is the DDL in [`lib/database.js`](../lib/database.js). This document records the conventions and the reasoning behind the non-obvious parts — read it before changing the schema.

Functional requirements it implements are in [SPEC.md](SPEC.md).

## Conventions

**Units follow Signal K, unconverted.** Angles in radians, speeds in m/s, distances in metres, durations in seconds, pressure in Pa, temperatures in K. Values arrive from the SK bus in SI and are exported to the user in knots, degrees and nautical miles; doing that conversion at the presentation layer only means there is exactly one place where a unit bug can live. Never store display units.

**Timestamps are ISO 8601 UTC text** with millisecond precision (`2026-09-13T08:00:00.000Z`). SQLite has no date type; ISO 8601 sorts lexicographically, is readable in a raw export, and sidesteps the ambiguity of storing a boat's local time as it crosses time zones. Local time is a rendering concern.

**Column names are `snake_case`; the REST API exposes `camelCase`.** The mapping happens in the API layer.

**Nullable readings.** Every instrument reading is nullable: a vessel may have no wind sensor, no log, no depth sounder, and per SPEC §4.7 the absence of a sensor must never block logging.

## Entities

### `log_entries`

One row per passage (start → underway → stop), per SPEC §3.1.

`state` is `active` or `closed`. A partial unique index enforces **at most one active entry** at a time — one vessel per instance, and passages are sequential, so two open entries would always be a bug.

`stopped_since` supports the configurable short-stop tolerance: it is set when the vessel stops and cleared if it moves again before the threshold elapses. Only once the threshold passes does the entry close.

`start_place_name` / `end_place_name` are **denormalised on purpose**, alongside the `place_id` references. A logbook is a historical record: renaming a place later (SPEC §4.8) must apply to future passages, not silently rewrite what last year's entries say. The foreign keys are `ON DELETE SET NULL` for the same reason — deleting a place must not erase the name a past entry recorded.

### `track_points` vs `observations`

The spec asks for two different things from the recorded data, so they are two tables:

- **`track_points`** is dense geometry — position, SOG, COG, sampled per SPEC §4.1 (fixed interval plus extra points on heading/speed deltas). It feeds the map and the GPX export. Keeping it narrow matters: a long passage produces a lot of rows.
- **`observations`** is a sparse, wide snapshot of every instrument at one moment: wind, depth, barometer, log, engine hours. These are the rows the facsimile PDF (SPEC §4.5) renders as classic logbook lines. `reason` records why the snapshot was taken (`periodic`, `entry_start`, `entry_end`, `event`).

Merging them would mean either carrying a dozen mostly-null columns on every dense sample, or losing the hourly conditions record. The split keeps each table doing one job.

### `events`

The timestamped timeline within an entry (SPEC §3.3): manoeuvres, annotations, automatic Signal K events.

`type` is the coarse category; `subtype` qualifies it — the manoeuvre key, the SK notification path, the autopilot state. `subtype` is deliberately **not** a foreign key to `manoeuvre_types`: deleting a custom shortcut must not rewrite or cascade away the passages where it was used. The UI falls back to displaying the raw key for a type that no longer exists.

`comment` carries free text for any event. `payload` is JSON, reserved for structured detail: handwritten stroke data (SPEC §4.4), the sail selected on a sail change, the before/after of a manual correction.

`source` distinguishes automatic events from user entries, so corrections can be told apart from detections.

### `places`

The gazetteer behind SPEC §4.8. `source` is `geocoding` (proposed by the online lookup) or `manual` (the user corrected it, so it wins on subsequent passages).

The index on `(lat, lon)` supports a bounding-box prefilter; the exact radius test runs in application code, since SQLite has no spatial functions here and the candidate set after the bounding box is tiny.

### `propulsion_segments`

Engine vs sail periods within an entry (SPEC §4.2), with `average_rpm` and a `source` flag marking segments a user has manually corrected.

### `manoeuvre_types`

The shortcut list (SPEC §4.3). Built-in entries are seeded by the migration with `builtin = 1`; users may disable or reorder them (`enabled`, `sort_order`) and add their own. Seeding uses `ON CONFLICT DO NOTHING`, so a user's edits to a built-in row survive restarts.

## Migrations

`MIGRATIONS` in `lib/database.js` is an ordered, **append-only** list; the applied index is stored in SQLite's `user_version`. Once a version has shipped to a boat, editing its entry would leave that installation on a schema the code no longer expects — add a new entry instead.

Each migration runs in a transaction and rolls back as a unit on failure.

## Deferred

Not in the schema yet, to be added by a later migration when the feature lands:

- **Remote publication state** (SPEC §4.5) — per-entry sync status once a target is defined.
- **Crew/author** (SPEC §3.4) — an author reference on entries and events, if V2 confirms the need.
