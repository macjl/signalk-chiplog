# Chiplog — Initial Specifications

Signal K plugin: automated digital logbook, with handwriting/keyboard entry on tablet.

Status: draft v0.2 — result of two scoping sessions; the structuring points (§7) are now settled.

## 1. Context and goal

Chiplog aims to replace the paper logbook with a Signal K plugin that:
- leverages data already available on the Signal K bus to automate entries (position, speed, engine/sail state, stopped/underway);
- allows fast manual entry (handwritten or keyboard annotations) for anything sensors can't infer;
- remains consultable and usable even if the vessel is lost (export/external sync).

Functional references: [meri-imperiumi/signalk-logbook](https://github.com/meri-imperiumi/signalk-logbook) (and its fork johansolve/signalk-sailing-logbook) for the semi-automatic log model, [@meri-imperiumi/signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) for navigation state detection.

**Reuse decision**: we draw inspiration from signalk-logbook's functional and data model, but write a fresh codebase tailored to our specific needs (handwritten annotations, configurable navigation granularity, abandon-ship export). We do not fork the existing repository.

## 2. Architecture principles adopted

- **Backend**: standard Signal K plugin (Node.js), subscribing to relevant SK deltas, managing the lifecycle of log entries, and exposing an HTTP (REST) API for the webapps.
- **Stopped/underway detection**: `signalk-autostate` as an **optional** dependency. If present and active, Chiplog reads `navigation.state`. If absent, a minimal internal fallback (configurable SOG speed threshold) takes over in degraded mode, with a UI indicator flagging that detection is running in simplified mode.
- **Engine/sail detection**: automatic, based on `propulsion.*.state`/`revolutions` and `navigation.state`/`sailing` (depending on what autostate exposes), with the option to manually correct an entry afterwards.
- **User interfaces** (two distinct surfaces):
  - **Standard Signal K webapp**: log consultation, plugin configuration, export.
  - **Dedicated, installable PWA, tablet/stylus-oriented**: real-time field entry (handwritten annotations, manoeuvre shortcuts), designed for use at the helm, with gloves or wet fingers.
- **Storage**: a single **SQLite** database in the plugin's data folder, covering entries, events, GPS track, and annotations (including vectorized handwritten strokes), accessed through Node's built-in `node:sqlite` module. The GPS track remains exportable as GPX on demand (generated from the database, not stored as a separate file).
- **Instance scope**: one vessel per Signal K instance (standard usage for SK plugins) — no multi-profile/multi-fleet management in the data model.

## 3. Logbook model

### 3.1 Granularity of an entry ("passage")

A log entry corresponds to a start → underway → stop cycle, **with configurable tolerance for short stops**:
- A `stop_closure_threshold` parameter (e.g. default value 30 min, user-configurable) defines the stop duration below which we stay within the same entry (e.g. waiting at a lock, lunch anchorage).
- Beyond the threshold, the entry is closed; a new underway cycle will trigger a new entry.
- Each entry carries: start date/time, end date/time, start/end position, **start/end place name** (see §4.8), distance covered, engine vs sail duration, GPS track.
- Manual concatenation of two entries is possible.

### 3.2 Grouping by day

Grouping "by day" is a **display-time aggregation view** (an entry may span midnight on a long passage): the logbook calendar/list groups entries by start date, and displays entries spanning multiple days visibly on each day concerned.

### 3.3 Events within an entry

Within an entry in progress, a timestamped timeline of events is recorded:
- engine ↔ sail changes (automatic, with the option of manual correction);
- manoeuvres (see §4.3);
- free-form annotations (text or handwritten);
- automatic Signal K events (see §4.6).

### 3.4 Author / multi-crew

No notion of author per event/annotation in V1: the logbook is a single shared document for the vessel. Crew profile management (author per entry, skipper/crew permissions) is deferred to a V2 if the need is confirmed in practice.

## 4. Detailed features

### 4.1 Boat track

- **Combined** sampling: a point at least every X seconds (configurable fixed interval, e.g. 10–30 s by default) **and** an additional point as soon as a significant heading or speed delta is detected (manoeuvres, tacks) — ensures a faithful track during dynamic phases without inflating volume in straight lines.
- Standard **GPX** export per entry or for a date range, generated on the fly from the SQLite database.
- **Interactive map embedded in the webapp** (track displayed on tile background), in addition to export — no delegation to freeboard-sk for display.

### 4.2 Engine/sail and stopped/underway detection

- `navigation.state` (via signalk-autostate) drives stopped/underway detection.
- Automatic engine/sail detection, logged with metadata (average RPM, duration); manual correction possible on an existing entry.

### 4.3 Manoeuvre shortcuts

- Approach adopted: **predefined + extensible list**.
- Base list to be defined precisely but should cover at minimum: tacking, gybing, reefing in/out, sail change (with selection of the sail hoisted), anchoring (anchored/weighed), mooring/casting off, watch change.
- Each shortcut logs a timestamped event + position in the current entry; the user can add an optional comment right after.
- The user can add their own shortcuts (name, icon, category) in V2 if not a priority for the MVP.

### 4.4 Handwritten and keyboard annotations

- Keyboard entry: free-text field, timestamped, attached to the current entry (or to a specific event).
- Handwritten entry: canvas on the tablet PWA, stylus capture.
  - **Format adopted: vector** (sequence of strokes, each stroke being a list of timestamped points with pressure/width). Allows lossless replay and resizing, and lightweight export. Image rendering (PNG) is still generated on demand for PDF/preview.
  - The feature itself is deferred to V2 (cf. §6); the format is fixed now so the data model doesn't need to be migrated later.
- Both annotation types appear in the entry's timeline, timestamped and geolocated.

### 4.5 Backup / continuity in case of abandoning ship

Two complementary mechanisms adopted for V1:
1. **Automatic export to USB drive** (PDF, CSV, JSON) — **configurable** write frequency (e.g. every X minutes, or on each entry closure). Requires a USB drive to be permanently plugged into the Signal K host.
   - The PDF follows a **traditional logbook facsimile** layout (time / position / heading / wind / remarks columns, organized by day). Higher formatting effort than CSV/JSON, so delivered in **V1.1** once the rest is stabilized (cf. §6) — CSV/JSON remain available from V1.
2. **Automatic publication to a remote server** — target undefined for V1, designed as a **generic extension point** (user-configurable webhook/API), with no fixed integration to a particular service.

### 4.6 Automatically logged Signal K events

In addition to engine/sail and manual manoeuvres, the log automatically captures:
- **critical SK notifications** (`alarm`/`emergency` levels: MOB, engine alarm, anchor watch triggered, etc.);
- **autopilot state changes** (engaged/disengaged);
- **configurable weather threshold crossings** (e.g. wind > X knots), to automatically trace the conditions that prompted a manoeuvre.

The exact list of SK paths/notifications covered and the default threshold values remain to be refined during technical design (cf. §7).

### 4.7 Reading Signal K data

- Subscription to relevant paths (position, speed, heading, wind, propulsion, navigation state) via the SK server's standard subscription mechanism.
- The plugin must tolerate the absence of certain data (e.g. no wind sensor) without blocking the creation/operation of an entry.

### 4.8 Place names (departure / arrival)

When creating and closing an entry, Chiplog attempts to associate a **place name** with the departure position and the arrival position (only these two points — no naming along the track):

1. **Local lookup first**: the plugin checks whether the position falls within the radius of an already-known place (created automatically or manually corrected during a previous passage). If so, its name is reused directly, with no network call.
2. **Otherwise, online reverse geocoding** (e.g. Nominatim/OpenStreetMap) if a connection is available: the returned name is proposed as a default value, editable before confirmation.
3. **If neither works** (no known place nearby, no connection): a name generated from the coordinates is used by default (e.g. "46.1234N 1.5678W"), pending manual correction.

**Matching radius**: a single global configurable parameter in the plugin settings (e.g. 200 m by default), applied to all registered places — no per-place setting in V1.

**Remembering corrections**: as soon as the user edits the proposed name (whether it came from online geocoding or the coordinate-generated name), the correction is stored as a **known place** (name + position) and will automatically be reused for any future departure/arrival position falling within the configured radius — with no further call to the online service.

Technical considerations to be scoped during detailed design: local caching of geocoding responses (avoid re-querying the service for the same area), compliance with the chosen online service's usage policy (call frequency, application identification), and an option to configure/disable the online service call for privacy reasons (position sent to a third party).

## 5. Data model and API

The data model has been refined into a precise schema: the authoritative DDL lives in [`lib/database.js`](../lib/database.js), with the conventions and rationale documented in [DATA_MODEL.md](DATA_MODEL.md). Entities: `log_entries`, `track_points`, `observations`, `propulsion_segments`, `events`, `places`, `manoeuvre_types`.

Two points worth carrying back into this document:

- Dense track geometry (`track_points`) and sparse instrument snapshots (`observations`) are separate tables: the first feeds the map and GPX export (§4.1), the second provides the hourly condition lines the facsimile PDF renders (§4.5).
- No author field in V1 (cf. §3.4). The exported GPX file is derived from track points, not stored as such.

The plugin's REST API is specified in [API.md](API.md).

## 6. MVP scope (proposal)

1. Automatic start/stop detection (signalk-autostate if present, internal fallback otherwise) and entry creation/closure with configurable threshold, with manual concatenation of two entries possible.
2. Automatic engine/sail detection with manual correction.
3. GPS track (combined sampling) + GPX export + basic map display in the webapp.
4. Timestamped keyboard annotations.
5. Manoeuvre shortcuts (basic predefined list).
6. Automatic SK events: critical notifications, autopilot, configurable weather thresholds.
7. Departure/arrival place names (online geocoding + known places, manual correction remembered).
8. Manual + automatic configurable USB export (JSON/CSV from V1; facsimile PDF in V1.1).
9. Day-grouped view in the consultation webapp.

Deferred to V2: implementation of handwritten annotations (the vector format is already fixed in the data model, §4.4/§5), full shortcut customization, publication to a remote server, dedicated mobile companion app, crew profiles/permissions, advanced map (offline tiles, etc.).

*(This MVP breakdown is a proposal — to be validated with you before committing to it.)*

## 7. Decisions settled during scoping

| Topic | Decision |
|---|---|
| Storage | SQLite (single database: entries, events, track, annotations) |
| SQLite driver | Node's built-in `node:sqlite` — no native compilation, which matters on Raspberry Pi. Raises the floor to Node >= 22.13 |
| Handwritten annotation format | Vector (timestamped strokes/points + pressure), fixed in the data model now even though implementation is V2 |
| Author / multi-crew | No author concept in V1 (V2 if the need is confirmed) |
| signalk-autostate dependency | Optional, with internal fallback (SOG threshold) if absent |
| GPS track sampling | Configurable fixed interval + extra point on heading/speed delta |
| PDF export | Traditional logbook facsimile, delivered in V1.1 |
| Automatic SK events (beyond engine/sail/manoeuvre) | Critical notifications, autopilot, configurable weather thresholds |
| Multi-vessel | One vessel per Signal K instance, no multi-profiles |
| Remote server target | Undefined for V1; designed as a generic extension point (configurable webhook/API) |
| Automatic place names | Online geocoding (e.g. Nominatim/OSM) with fallback to already-known local places |
| Place matching radius | A single global configurable radius (no per-place setting in V1) |
| Place not found (offline, first visit) | Name generated from coordinates, manually correctable |

### Remaining minor points (non-blocking for starting)

- Exact list of Signal K notification paths considered "critical" (MOB, engine alarm, anchor watch...).
- Default values for configurable weather thresholds (wind, etc.) and the GPS interval.
- Precise layout template for the facsimile PDF (to be mocked up in V1.1).
- Exact behaviour of the signalk-autostate internal fallback (default SOG threshold, hysteresis to avoid stopped/underway oscillation).
- Precise choice of online geocoding service (public Nominatim instance vs self-hosted) and default value for the place matching radius.

## 8. Suggested next steps

1. ~~Define the precise SQLite schema (DDL) and the plugin's REST API.~~ Done — see [DATA_MODEL.md](DATA_MODEL.md) and [API.md](API.md).
2. Implement the REST API defined in [API.md](API.md) on top of the schema.
3. Prototype engine/sail + stopped/underway detection (with and without signalk-autostate) on real/simulated data.
4. Mock up the tablet entry screen (PWA) — at least the manoeuvres/text-annotations part for V1, with the handwriting canvas mockable in parallel to prepare V2.
5. Settle the SK paths to monitor for automatic events (§4.6); the manoeuvre shortcut list is now seeded by the schema.
