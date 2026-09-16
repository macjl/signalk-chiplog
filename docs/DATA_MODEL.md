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

`stopped_since` supports the configurable short-stop tolerance: it is set when the vessel stops and cleared if it moves again before the threshold elapses. Only once the threshold passes does the entry close, with `end_time` taken from `stopped_since`.

`last_moving_at` (migration 2) is a heartbeat: passage detection refreshes it about once a minute while under way. It exists for restarts — when the plugin comes back to an open entry, it is the only record of when the boat was last seen moving, and so dates the end of a passage that stopped while the plugin was off. It is not exposed by the API.

`opened_by_event_id` (migration 4) points to the departure manoeuvre — cast off or anchor up — that opened the entry by hand before the vessel moved (SPEC §4.3). Such an entry starts with `stopped_since` equal to `start_time` and `last_moving_at` null: detection sees a stopped passage, resumes it on the first movement and closes it like any long stop if the vessel never leaves. Deleting that event while `last_moving_at` is still null and nothing else was logged deletes the entry too — the undo of a mistaken tap.

While an entry is **active**, `end_lat`/`end_lon` hold the last position seen moving, then the position where the vessel stopped; they become the arrival position when the entry closes. Clients should not present them as an arrival until `state` is `closed`.

`start_place_name` / `end_place_name` are **denormalised on purpose**, alongside the `place_id` references. A logbook is a historical record: renaming a place later (SPEC §4.8) must apply to future passages, not silently rewrite what last year's entries say. The foreign keys are `ON DELETE SET NULL` for the same reason — deleting a place must not erase the name a past entry recorded.

### `track_points` vs `observations`

The spec asks for two different things from the recorded data, so they are two tables:

- **`track_points`** is dense geometry — position, SOG, COG (true), and, since migration 6, wind and heading (`tws`, `twd`, `aws`, `awa`, `heading`), plus, since migration 9, speed through water (`stw`) — at the same read each point takes — sampled per SPEC §4.1 (fixed interval plus extra points on heading/speed deltas). It feeds the map, the GPX export, and figures that need a real maximum rather than an hourly sample, such as `maxWindSpeed` (`GET /entries/:id`); the passage page's position scrubber (SPEC §4.1) reads it directly rather than interpolating from the hourly `observations`. True wind angle is not a column: it is `twd` minus `heading`, computed where shown rather than stored, since it needs no sensor of its own. Keeping it narrow still matters: a long passage produces a lot of rows — about 240 an hour under way at the default 15 s interval. Point times come from the host clock, like entry times, so they always fall within their entry. `log_entries.distance` is kept as the running sum of the distances between an entry's consecutive points.
- **`observations`** is a sparse, wide snapshot of every instrument at one moment: wind, depth, barometer, log, engine hours. These are the rows the facsimile PDF (SPEC §4.5) renders as classic logbook lines. `reason` records why the snapshot was taken (`periodic`, `entry_start`, `entry_end`, `event`).

The two overlap on wind and heading since migration 6, and on speed through water since migration 9, but still do different jobs: `observations` is the timed, reasoned record the PDF renders as logbook lines; `track_points` is the dense series a chart or a maximum is computed from. Merging them would mean either carrying every instrument column on the dense table, unread most of the time, or losing the hourly conditions record — so each keeps its own copy of what it needs, even where that duplicates a reading.

**Where observation columns come from** (`lib/observation-recorder.js`). A reading is recorded only while current — its Signal K timestamp changed within the stated age — and is `null` otherwise. Counters are the exception: their last value stays a true reading while they do not move, so they are recorded whatever their age.

| Column | Signal K path | Current for |
|---|---|---|
| `lat`, `lon` | `navigation.position` | 2 min |
| `sog` | `navigation.speedOverGround` | 2 min |
| `cog` | `navigation.courseOverGroundTrue` | 2 min |
| `heading` | `navigation.headingTrue`, else `navigation.headingMagnetic` + `navigation.magneticVariation` | 2 min (variation 15 min) |
| `stw` | `navigation.speedThroughWater` | 2 min |
| `twd`, `tws` | `environment.wind.directionTrue`, `environment.wind.speedTrue` | 2 min |
| `awa`, `aws` | `environment.wind.angleApparent`, `environment.wind.speedApparent` | 2 min |
| `depth` | `environment.depth.belowSurface`, else `environment.depth.belowTransducer` | 2 min |
| `pressure` | `environment.outside.pressure` | 15 min |
| `air_temp` | `environment.outside.temperature` | 15 min |
| `water_temp` | `environment.water.temperature` | 15 min |
| `trip_log` | `navigation.log` | counter |
| `engine_runtimes` | `propulsion.<id>.runTime` of every engine that has one, as JSON `{"port": 2924700, "starboard": 2873220}` in seconds, `main` first then by id (migration 5) | counter |
| `engine_runtime` | the first of `engine_runtimes`: `propulsion.main.runTime`, else the first engine that has one — kept for readers of the single value | counter |

True wind is taken as published, not computed from apparent wind; a boat without a true-wind source can add one with the `signalk-derived-data` plugin. A snapshot in which every column would be `null` is not recorded.

### `events`

The timestamped timeline within an entry (SPEC §3.3): manoeuvres, annotations, automatic Signal K events.

`type` is the coarse category; `subtype` qualifies it — the manoeuvre key, the SK notification path, the autopilot state. `subtype` is deliberately **not** a foreign key to `manoeuvre_types`: deleting a custom shortcut must not rewrite or cascade away the passages where it was used. The UI falls back to displaying the raw key for a type that no longer exists.

`comment` carries free text for any event. `payload` is JSON, reserved for structured detail: handwritten stroke data (SPEC §4.4), the sail selected on a sail change, the before/after of a manual correction.

`source` distinguishes automatic events from user entries, so corrections can be told apart from detections.

Events the plugin produces (SPEC §4.6), all with `source: 'auto'`:

| `type` | `subtype` | `payload` |
|---|---|---|
| `sk_alarm` | the notification path, e.g. `notifications.mob` | `{ state, message }` — `state` is `alarm`, `emergency`, or `normal` when it cleared |
| `autopilot` | `engaged`, `disengaged` or `mode_changed` | `{ mode, state, target }` — `target` in radians, a number or `{ headingTrue, headingMagnetic, windAngleApparent, windAngleTrue }`; `null` once disengaged |
| `weather_threshold` | `wind_above` or `wind_below` | `{ threshold, windSpeed }` in m/s |
| `weather_threshold` | `pressure_drop` | `{ drop, over, pressure }` — Pa, seconds, Pa |
| `manual_correction` | `propulsion` | `{ segmentId, before, after }` |
| `propulsion_change` (migration 7) | *(none)* | `{ segmentId, before, after }` — same shape as `manual_correction`, for an automatic switch rather than a crew override |
| `stopover` (migration 10) | *(none)* | `{ placeName, placePending }` — the place and position an entry ended at, before a merge (SPEC §3.1) folded it into the middle of the surviving passage |

`client_ref` (migration 4) is an optional idempotency key chosen by the client, unique when present. The tablet sets it on every entry, so one replayed from its offline queue after a lost response returns the event already logged instead of a duplicate.

`propulsion_change` (migration 7) and `stopover` (migration 10) needed `type`'s CHECK constraint widened, which SQLite can only do by rebuilding the table — `lib/database.js`'s `addPropulsionChangeEventType` and `addStopoverEventType`. Foreign keys are turned off around the rebuild: `log_entries.opened_by_event_id` references `events`, and with them enforced, `DROP TABLE events` would fire its `ON DELETE SET NULL` for every referencing row before the table (and the reference) is gone.

`stopover`'s `lat`/`lon` and `comment` are also set, unlike the other automatic types: `comment` carries the raw place name, like an `sk_alarm`'s message, so it still reads in a CSV export or before a crew annotation is added on top of it. Its `time` is the merged-away entry's own `entry_end` observation, not `end_time`: detection dates `end_time` from the last movement it saw, but only takes that observation once the stop has held past the closure threshold and the entry actually closes — up to `stopClosureMinutes` later — and the event needs to sort after it, not before.

An event's `time` may fall **after its entry's `end_time`**: alarms and weather events between passages go to the passage that ended where the vessel still is.

### `places`

The gazetteer behind SPEC §4.8. `source` is `geocoding` (proposed by the online lookup) or `manual` (the user corrected it, so it wins on subsequent passages). It doubles as the geocoding cache: a departure or arrival within the radius of any place, whatever its source, is named from it without a request.

On `log_entries`, `start_place_pending` and `end_place_pending` (migration 3) flag a name generated from coordinates that online geocoding has yet to answer for. They are cleared when the lookup resolves or finds nothing to name, and as soon as someone sets the name. A pending name follows a corrected position: the generated name is regenerated and the lookup redone.

The index on `(lat, lon)` supports a bounding-box prefilter; the exact radius test runs in application code, since SQLite has no spatial functions here and the candidate set after the bounding box is tiny.

### `propulsion_segments`

Engine vs sail periods within an entry (SPEC §4.2), with `average_rpm` and a `source` flag marking segments a user has manually corrected.

Segments cover only time **under way**: a stop ends one and moving again starts the next, so there are gaps during stops and `engine_duration + sail_duration` on the entry is time under way, not elapsed time. At most one segment is open (`end_time IS NULL`) — the ongoing one of the active entry — and it counts up to now in the entry's durations, which are rewritten on every detection cycle while under way.

### `manoeuvre_types`

The shortcut list (SPEC §4.3). Built-in entries are seeded by the migration with `builtin = 1`; users may disable or reorder them (`enabled`, `sort_order`) and add their own. Seeding uses `ON CONFLICT DO NOTHING`, so a user's edits to a built-in row survive restarts.

### `tide_forecasts` (migration 8)

At most one row per entry (`entry_id` is the primary key), fetched once near departure (SPEC §4.5.2): `lat`/`lon` are the position asked about, `points` the JSON `[{ time, height }]` hourly curve for the 24 h from departure, height in metres. No row means no attempt has resolved yet — still pending, or the departure is now too old for one to be worth making. `points: []` means a fetch answered but had nothing usable for the position (an inland lake); `getTideForecast` (`lib/tide-forecaster.js`) treats that the same as no row, since the webapp has nothing to show either way — the distinction only matters to the fetcher itself, so it does not keep re-asking.

There is no `datum` column: every row is Open-Meteo `sea_level_height_msl`, relative to mean sea level rather than the chart datum nautical tide tables use, and `getTideForecast` reports that as the constant `datum: "msl"` rather than storing it per row. A second source with a different reference would need one.

High and low tide are not stored: they are the local peaks and troughs of `points`, found when read (`public/js/tide.mjs`'s `tideExtremes`), the same principle as `maxSpeed`/`maxWindSpeed` on `GET /entries/:id`.

## Migrations

`MIGRATIONS` in `lib/database.js` is an ordered, **append-only** list; the applied index is stored in SQLite's `user_version`. Once a version has shipped to a boat, editing its entry would leave that installation on a schema the code no longer expects — add a new entry instead.

Most entries are a SQL string, run inside a transaction. An entry may instead be a function `(db, version)` for the rare change a transaction can't express as one statement or that needs a pragma toggled outside one — such as `addPropulsionChangeEventType` (migration 7), which rebuilds a table to change a CHECK constraint. A function migration must set `user_version` itself once it has made its change durable.

Each migration runs in a transaction and rolls back as a unit on failure.

## Deferred

Not in the schema yet, to be added by a later migration when the feature lands:

- **Remote publication state** (SPEC §4.5) — per-entry sync status once a target is defined.
- **Crew/author** (SPEC §3.4) — an author reference on entries and events, if V2 confirms the need.
