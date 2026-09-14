# REST API

The plugin registers its routes through `registerWithRouter`, so everything below is mounted at:

```
/plugins/signalk-chiplog/api
```

The `/api` prefix keeps the plugin's routes clear of `GET /plugins/signalk-chiplog` and `GET`/`POST /plugins/signalk-chiplog/config`, which the Signal K server reserves. The tablet PWA is a static webapp at `/signalk-chiplog/entry/` and uses this API.

Implemented in [`lib/api.js`](../lib/api.js); the behaviour described here is covered by the tests in [`test/`](../test).

## Conventions

**Access levels.** Signal K gives routes registered directly on the router **admin** authentication; `router.access('readonly')` and `router.access('readwrite')` open them further. The policy here:

| Level | What it covers |
|---|---|
| `readonly` | Reading the logbook and exporting it |
| `readwrite` | What the crew does underway: annotations, manoeuvres, closing an entry, correcting a name or a propulsion segment |
| admin | Destructive or configuration-shaped operations: deleting entries and places, managing shortcuts, triggering a USB write |

Corrections are `readwrite` rather than admin on purpose — a crew member at the helm has to be able to fix a wrong place name or a mis-detected engine segment without an admin login.

On a server too old to provide `router.access()`, every route falls back to admin-only: the plugin stays usable, at the cost of requiring an admin login for reads.

**JSON is `camelCase`**, mapped from the `snake_case` columns of the [data model](DATA_MODEL.md). Positions are `{ "lat": …, "lon": … }` in decimal degrees, or `null`.

**Units are Signal K SI units** — radians, m/s, metres, seconds. Conversion to degrees, knots and nautical miles belongs to the client; the CSV export is the one exception (see [Export](#export)). Timestamps are ISO 8601 UTC; any parseable timestamp is accepted in requests and normalised to millisecond precision.

**Collections** all share one envelope, `{ total, limit, offset, items }`, with `limit` from 1 to 500 (default 50) and `offset` ≥ 0.

**Unknown fields** in a request body are rejected with `400` rather than ignored, so a client typo fails loudly.

**Errors** return the matching HTTP status with a body of:

```json
{ "error": { "code": "entry_already_closed", "message": "Entry 42 is already closed" } }
```

| Status | When | Codes |
|---|---|---|
| `400` | Malformed request | `invalid_request`, `unknown_manoeuvre_type` |
| `404` | Unknown resource | `entry_not_found`, `event_not_found`, `place_not_found`, `propulsion_segment_not_found`, `manoeuvre_type_not_found` |
| `409` | The request conflicts with current state | `no_passage`, `entry_active`, `entry_already_closed`, `entries_not_consecutive`, `manoeuvre_type_exists`, `builtin_manoeuvre_type`, `usb_export_not_configured`, `usb_export_unavailable`, `constraint_violation` |
| `500` | Unexpected failure — detail goes to the server log, not the client | `internal_error` |
| `501` | Not built yet | `not_implemented` |
| `503` | The plugin is disabled or stopped | `plugin_not_started` |

The server registers plugin routes once and never removes them, so they keep answering while the plugin is disabled — with `503` until it is started again.

## Plugin state

### `GET /state` — `readonly`

What the UI needs to render its header, in one call.

```json
{
  "activeEntryId": 42,
  "detection": "autostate",
  "motion": "underway",
  "propulsion": "engine",
  "schemaVersion": 2
}
```

As of the last detection cycle, at most 15 seconds old:

- `detection` is `autostate` while a current, recognised `navigation.state` is driving detection — which is what `signalk-autostate` provides — and `fallback` when the speed fallback is (SPEC §4.2). The UI must show the degraded-mode indicator in the latter case (SPEC §2).
- `motion` is `underway`, `stopped`, or `unknown` when there is no current data to decide.
- `propulsion` is `engine` or `sail` while under way — from engine data, `navigation.state` or the configured default (SPEC §4.2) — and `null` otherwise.
- `activeEntryId` is `null` when no passage is open.

## Entries

### `GET /entries` — `readonly`

Query: `from` (inclusive) and `to` (exclusive), both filtering on `startTime`; `limit`, `offset`.

Newest first. Day grouping (SPEC §3.2) is done by the client, which is why a flat list is returned.

### `GET /entries/:id` — `readonly`

One entry, with the counts the detail view needs:

```json
{
  "id": 42,
  "state": "closed",
  "startTime": "2026-09-13T06:12:00.000Z",
  "endTime": "2026-09-13T15:47:30.000Z",
  "stoppedSince": null,
  "startPosition": { "lat": 46.1591, "lon": -1.1522 },
  "endPosition": { "lat": 46.5012, "lon": -1.7899 },
  "startPlaceId": 3,
  "endPlaceId": 7,
  "startPlaceName": "La Rochelle",
  "endPlaceName": "Les Sables-d'Olonne",
  "startPlacePending": false,
  "endPlacePending": false,
  "distance": 68500,
  "engineDuration": 4200,
  "sailDuration": 30330,
  "openedByEventId": null,
  "createdAt": "2026-09-13T06:12:00.000Z",
  "updatedAt": "2026-09-13T15:47:30.000Z",
  "counts": { "trackPoints": 1187, "observations": 11, "events": 9 }
}
```

On an active entry, `endPosition` is the last position detection saw — not yet an arrival.

`startPlacePending`/`endPlacePending` mean the name was generated from coordinates (`"46.1234N 1.5678W"`) and online geocoding has not answered yet (SPEC §4.8); the name may still change on its own. A UI can show it as provisional. Geocoded names from the public instance are OpenStreetMap data and need its attribution.

### `PATCH /entries/:id` — `readwrite`

Accepts `startTime`, `endTime`, `startPosition`, `endPosition`, `startPlaceName`, `endPlaceName`, `distance`.

- `endTime` can only be set on a closed entry — `409 entry_active` otherwise; use [close](#post-entriesidclose--readwrite). An end before the start is `400`.
- **Renaming a place here is remembered.** Per SPEC §4.8, setting `startPlaceName`/`endPlaceName` also updates the nearest known place within the configured matching radius, or creates one, marking it `source: "manual"`; the entry's `startPlaceId`/`endPlaceId` then points to it. The next passage starting or ending within the radius reuses the name without calling the geocoder. Other entries keep the names they recorded.
- If the entry has no position on that side, the name is stored on the entry alone and no place is created.
- `null` clears a name or a position.
- Setting a name, or clearing it, ends any pending geocoding for that side: a lookup still on its way will not override it. Correcting the position of a side whose name is still pending regenerates that name from the new coordinates and looks it up again.

### `POST /entries/:id/close` — `readwrite`

Closes an open entry, with no request body — confirming an arrival, or ending a passage detection has not ended. If detection has already seen the vessel stop (`stoppedSince`), that is the end time; otherwise it is now. The end position is the one detection recorded, or failing that the vessel's current position. Unless the arrival already has a name, it is named as detection would name it: after a known place, or from its coordinates pending geocoding. `409 entry_already_closed` if it is already closed.

Detection does not reopen an entry closed while the boat is still moving: the next passage starts at the next real departure.

### `POST /entries/:id/merge` — `readwrite`

```json
{ "withEntryId": 43 }
```

Manual concatenation of two passages (SPEC §3.1), for when a stop outlasted the tolerance but was really the same outing.

- **The earlier entry survives**, whichever of the two the request is addressed to, so the passage keeps its id and departure. It takes the later entry's end time, end position, end place and state.
- Track points, observations, propulsion segments and events move to it; distances are summed and engine/sail durations recomputed from the segments.
- The two entries must be consecutive — `409 entries_not_consecutive` — and the earlier one must be closed — `409 entry_active`.

Returns the surviving entry.

### `DELETE /entries/:id` — admin

Removes the entry and everything attached to it. `204`.

## Track, observations, propulsion

### `GET /entries/:id/track` — `readonly`

Query `format`: `geojson` (default) or `gpx`.

GeoJSON is a single `Feature`: a `LineString`, a `Point` for a one-point track, or a `null` geometry for an empty one. `properties` carries the entry's times and place names plus `coordTimes`, the timestamp of each coordinate. GPX 1.1 is served as `application/gpx+xml`.

### `GET /entries/:id/observations` — `readonly`

The instrument snapshots behind the facsimile PDF, oldest first. Paginated. `reason` is `entry_start`, `periodic`, `entry_end` or `event` (SPEC §4.5.1); readings that were not current when the snapshot was taken are `null`.

### `GET /entries/:id/propulsion` — `readonly`

The engine/sail segments, oldest first. Paginated. They cover only time under way, so a stop leaves a gap; the ongoing segment has `endTime: null`.

### `PATCH /propulsion/:id` — `readwrite`

```json
{ "type": "sail" }
```

Corrects a mis-detected segment (SPEC §4.2). The segment is flagged `source: "manual"`, the entry's durations are recomputed, and a `manual_correction` event is added to the timeline at the segment's start time, with the before and after in its payload. Setting the type a segment already has changes nothing.

Correcting the **ongoing** segment holds until the engine data changes: detection does not revert it on its next cycle just because the sensors — or the configured default — still say otherwise.

## Events

### `GET /entries/:id/events` — `readonly`

Optional `type` filter. Oldest first. Paginated.

Besides what clients post, the timeline holds events the plugin logs itself — `sk_alarm`, `autopilot`, `weather_threshold` and `manual_correction`, with `source: "auto"`; their subtypes and payloads are listed in the [data model](DATA_MODEL.md#events). An alarm raised at anchor between passages belongs to the passage that ended there, so its time can be later than that entry's `endTime`.

### `POST /events` — `readwrite`

The endpoint the tablet's manoeuvre shortcuts and annotations hit. The client does not need to know which passage is open: the server attaches the entry to

1. the passage in progress;
2. failing that, for a **departure manoeuvre** — `cast_off` or `anchor_up` — a new passage it opens at the event's time (SPEC §4.3). The passage starts stopped, at the event's position, named as detection would name it; detection carries it on as soon as the vessel moves, or closes it like any long stop if it never leaves. The start is never earlier than the previous passage's end;
3. failing that, the last passage while the vessel is within 1 nm of its arrival — a note in the marina belongs to the passage that ended there;
4. otherwise the request is refused with `409 no_passage`.

```json
{
  "type": "manoeuvre",
  "subtype": "reef_in",
  "comment": "25 kn, second reef",
  "payload": { "sail": "main" },
  "clientRef": "3f6c1a52-8f0e-4a0e-9d43-2a1c5d4b7e10"
}
```

Accepts `type`, `subtype`, `comment`, `payload`, `time`, `position`, `clientRef`:

- `time` defaults to now and `position` to the vessel's position at that time, so a shortcut button is a single call with no client-side clock or GPS; pass `"position": null` to record none. For a past `time` — an entry replayed from an offline queue — the position is the nearest track point within 2 minutes, else the current position if `time` is within 5 minutes of now, else none.
- `clientRef` (1–100 characters) is an idempotency key: posting a `clientRef` already logged answers `200` with that event and changes nothing, so a retry after a lost response neither duplicates the entry nor opens a second passage.

Answers `201` with the event — `entryId` says where it went — plus `"openedEntry": true` when it opened the passage.

A `manoeuvre` posted without `time` also takes an instrument snapshot (`reason: "event"`) at the event's time, so the log shows the conditions it was made in.

Clients may create three types; the others are produced by the plugin itself:

| `type` | Requires |
|---|---|
| `manoeuvre` | `subtype`, the key of an existing manoeuvre type — `400 unknown_manoeuvre_type` otherwise |
| `text_annotation` | `comment` |
| `handwritten_annotation` | `payload.strokes`: `[{ "points": [{ "x", "y", "t", "pressure"? }] }]`, non-empty, numeric |

### `POST /entries/:id/events` — `readwrite`

The same as [`POST /events`](#post-events--readwrite), for a given entry — open or closed — with no attachment rule. `clientRef` and the snapshot behave the same; the response has no `openedEntry`.

### `PATCH /events/:id` — `readwrite`

Accepts `time`, `comment`, `subtype`, `payload`, and validates the result by the same rules as creation. On an event the plugin produced (`sk_alarm`, `autopilot`, `weather_threshold`, `manual_correction`), only `comment` may change — annotating an alarm is fine, rewriting it is not.

### `DELETE /events/:id` — `readwrite`

`204`. Deleting the departure manoeuvre that opened a passage, while the vessel has not moved yet and nothing else was logged in it, deletes that passage too: this is how a mistaken "Cast off" is undone.

## Places

### `GET /places` — `readonly`

The gazetteer, for a management screen, sorted by name — accent- and case-insensitively, so "Île de Ré" sorts among the I's. Paginated.

### `PATCH /places/:id` — `readwrite`

```json
{ "name": "Port des Minimes" }
```

Marks the place `source: "manual"`, which makes the name authoritative for later passages within the radius. Past entries are untouched.

### `DELETE /places/:id` — admin

Entries that referenced it lose the reference but keep their recorded names. `204`.

## Manoeuvre shortcuts

### `GET /manoeuvre-types` — `readonly`

Ordered by `sortOrder`. Disabled types are included, so a settings screen can show them. Paginated.

### `POST /manoeuvre-types` — admin

```json
{ "key": "spinnaker_up", "label": "Hoist spinnaker", "icon": null, "sortOrder": 110, "enabled": true }
```

`key` is 1–40 lowercase letters, digits or underscores; `label` is required. `sortOrder` defaults to after the last type. `409 manoeuvre_type_exists` for a taken key. Answers `201`.

### `PATCH /manoeuvre-types/:key` — admin

Accepts `label`, `icon`, `sortOrder`, `enabled` — on built-in types too. The key cannot change.

### `DELETE /manoeuvre-types/:key` — admin

`409 builtin_manoeuvre_type` for a built-in; disable it instead. Events that used a deleted type keep their `subtype`. `204`.

## Export

### `GET /export` — `readonly`

Query: `format` — `json` (default), `csv`, `gpx` or `pdf`; `from`, `to` as for [`GET /entries`](#get-entries--readonly). Served as an attachment named `chiplog.<format>`.

- **`json`** — the complete record, in SI units: `{ exportedAt, schemaVersion, units, entries }`, where each entry carries its `trackPoints`, `observations`, `propulsion` and `events`. This is the machine-readable abandon-ship payload (SPEC §4.5).
- **`csv`** — one chronological line per departure, observation, event and arrival: a paper logbook readable in any spreadsheet. Unlike everything else, it is **converted to nautical units** — knots, degrees, hPa, °C, nautical miles, engine hours — with units in the column names. Free text that a spreadsheet would execute as a formula is prefixed with `'`.
- **`gpx`** — one track per entry.
- **`pdf`** — `501 not_implemented`; the facsimile arrives in V1.1.

### `POST /export/usb` — admin

Copies the logbook to a `chiplog/` subdirectory of the directory set in the plugin configuration, as one JSON, one CSV and one GPX file per passage, in the same formats as [`GET /export`](#get-export--readonly) restricted to that passage.

- **Names sort by departure**: `<start date>_<start time>Z_<departure>_<arrival>.<format>`, in UTC, with place names reduced to ASCII letters, digits and hyphens — e.g. `2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne.json`. A passage in progress ends in `underway`; one with no name has `unnamed`; two passages starting in the same minute get `_2` on the later one.
- **Incremental.** Only passages that are new or changed since the last export are written. What was exported is recorded in `chiplog/.chiplog-export.json`, with a fingerprint of each passage's content, so a correction made later — a renamed place, a switched engine period, an edited comment, an alarm added at anchor — rewrites that passage. Files already on the drive with no record are kept as they are; a missing file is written again.
- **Obsolete files are removed**: those of passages deleted, merged or renamed. Only files named like passage files are touched in `chiplog/`.
- Each file is flushed to the device and renamed into place, so pulling the drive never leaves a half-written export.

```json
{
  "directory": "/media/usb/chiplog",
  "entries": 12,
  "written": 1,
  "unchanged": 11,
  "files": ["/media/usb/chiplog/2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne.json", "…csv", "…gpx"],
  "removed": []
}
```

`entries` counts all passages, `written` those whose files were written, `unchanged` those left as they were; `files` and `removed` list full paths.

`409 usb_export_not_configured` without a configured directory; `409 usb_export_unavailable` if it does not exist — typically, the drive is not mounted.

## Not yet provided

- **`getOpenApi()`**, the machine-readable version of this document, which the Signal K server can surface. Worth adding once the API has settled, so the two do not have to be kept in step while it still moves.
