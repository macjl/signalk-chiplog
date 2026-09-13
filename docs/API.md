# REST API

The plugin registers its routes through `registerWithRouter`, so everything below is mounted at:

```
/plugins/signalk-chiplog/api
```

The `/api` prefix keeps the plugin's own routes clear of `GET /plugins/signalk-chiplog` and `POST /plugins/signalk-chiplog/configure`, which the Signal K server reserves, and leaves the bare path free to serve the PWA later.

This document is the contract; `getOpenApi()` serves the machine-readable version of the same thing.

## Conventions

**Access levels.** Signal K gives routes registered directly on the router **admin** authentication; `router.access('readonly')` and `router.access('readwrite')` open them further. The policy here:

| Level | What it covers |
|---|---|
| `readonly` | Reading the logbook and exporting it |
| `readwrite` | What the crew does underway: annotations, manoeuvres, closing an entry, correcting a name or a propulsion segment |
| admin | Destructive or configuration-shaped operations: deleting entries and places, managing shortcuts, triggering a USB write |

Corrections are `readwrite` rather than admin on purpose — a crew member at the helm has to be able to fix a wrong place name or a mis-detected engine segment without an admin login.

**JSON is `camelCase`**, mapped from the `snake_case` columns of the [data model](DATA_MODEL.md).

**Units are Signal K SI units** — radians, m/s, metres, seconds. Conversion to degrees, knots and nautical miles belongs to the client. Timestamps are ISO 8601 UTC.

**Errors** return the matching HTTP status with a body of:

```json
{ "error": { "code": "entry_not_active", "message": "Entry 42 is already closed" } }
```

`400` malformed request · `404` unknown resource · `409` operation conflicts with current state (closing a closed entry, merging non-adjacent entries) · `500` unexpected failure.

**Collections** are paginated with `limit` (default 50, max 500) and `offset`, and answer with `{ total, limit, offset, items }`.

## Plugin state

### `GET /state` — `readonly`

What the UI needs to render its header, in one call.

```json
{
  "activeEntryId": 42,
  "detection": "autostate",
  "schemaVersion": 1
}
```

`detection` is `autostate` when `signalk-autostate` is driving stopped/underway state, or `fallback` when the internal SOG threshold is (SPEC §2) — the UI must show the degraded-mode indicator in the latter case. `activeEntryId` is `null` when the vessel is not underway.

## Entries

### `GET /entries` — `readonly`

Query: `from`, `to` (ISO dates, filter on `startTime`), `limit`, `offset`.

Entries are returned newest first. Day grouping (SPEC §3.2) is done by the client, which is why the raw list is returned rather than a pre-grouped structure.

### `GET /entries/:id` — `readonly`

One entry, with the counts the detail view needs:

```json
{
  "id": 42,
  "state": "closed",
  "startTime": "2026-09-13T06:12:00.000Z",
  "endTime": "2026-09-13T15:47:30.000Z",
  "startPosition": { "lat": 46.1591, "lon": -1.1522 },
  "endPosition": { "lat": 46.5012, "lon": -1.7899 },
  "startPlaceName": "La Rochelle",
  "endPlaceName": "Les Sables-d'Olonne",
  "distance": 68500,
  "engineDuration": 4200,
  "sailDuration": 30330,
  "counts": { "trackPoints": 1187, "events": 9, "observations": 11 }
}
```

### `PATCH /entries/:id` — `readwrite`

Accepts `startTime`, `endTime`, `startPlaceName`, `endPlaceName`, `distance`, `startPosition`, `endPosition`.

**Renaming a place here is remembered.** Per SPEC §4.8, setting `startPlaceName`/`endPlaceName` also creates or updates the corresponding `places` row with `source: "manual"`, so the next passage that starts or ends within the configured radius reuses the corrected name without calling the geocoder. Only this entry's stored name changes; past entries keep what they recorded.

### `POST /entries/:id/close` — `readwrite`

Closes an entry that automatic detection has left open. `409` if it is already closed.

### `POST /entries/:id/merge` — `readwrite`

```json
{ "withEntryId": 43 }
```

Manual concatenation of two passages (SPEC §3.1), for when a stop exceeded the tolerance but was really the same outing. The two entries must be consecutive; `409` otherwise. Track points, observations, events and propulsion segments are reassigned to the surviving entry, whose totals are recomputed, and the response returns it.

### `DELETE /entries/:id` — admin

Removes the entry and everything referencing it, by cascade.

## Track, observations, propulsion

### `GET /entries/:id/track` — `readonly`

Query `format`: `geojson` (default) or `gpx`. GeoJSON feeds the webapp map; GPX is the standard export of SPEC §4.1. Both are generated from `track_points` on the fly.

### `GET /entries/:id/observations` — `readonly`

The instrument snapshots behind the facsimile PDF, oldest first.

### `GET /entries/:id/propulsion` — `readonly`

The engine/sail segments of the entry.

### `PATCH /propulsion/:id` — `readwrite`

```json
{ "type": "sail" }
```

Corrects a mis-detected segment (SPEC §4.2); the segment is flagged `source: "manual"` and the entry's engine/sail totals are recomputed.

## Events

### `GET /entries/:id/events` — `readonly`

Optional `type` filter. Oldest first.

### `POST /entries/:id/events` — `readwrite`

The endpoint the tablet's manoeuvre shortcuts and annotations hit:

```json
{
  "type": "manoeuvre",
  "subtype": "reef_in",
  "comment": "25 kn, second reef",
  "payload": { "sail": "main" }
}
```

`time` defaults to now and the position to the vessel's current position, so a shortcut button is a single call with no client-side clock or GPS handling.

### `PATCH /events/:id` — `readwrite`

Accepts `time`, `comment`, `subtype`, `payload`.

### `DELETE /events/:id` — `readwrite`

## Places

### `GET /places` — `readonly`

The gazetteer, for a management screen.

### `PATCH /places/:id` — `readwrite`

Renaming sets `source: "manual"`, which makes the name authoritative for later passages within the radius. Past entries are untouched.

### `DELETE /places/:id` — admin

Entries referencing it keep their recorded names (`ON DELETE SET NULL` on the reference only).

## Manoeuvre shortcuts

### `GET /manoeuvre-types` — `readonly`

Ordered by `sortOrder`; `enabled: false` entries are returned too, so a settings screen can show them.

### `POST /manoeuvre-types` — admin · `PATCH /manoeuvre-types/:key` — admin · `DELETE /manoeuvre-types/:key` — admin

Custom shortcuts (SPEC §4.3, full customization is V2). `PATCH` on a built-in may change `label`, `icon`, `sortOrder` and `enabled` but not `key`; `DELETE` refuses a built-in with `409` — disable it instead. Events that referenced a deleted shortcut keep their `subtype`.

## Export

### `GET /export` — `readonly`

Query: `from`, `to`, `format` (`json`, `csv`, `gpx`, `pdf`). The abandon-ship payload of SPEC §4.5. `pdf` arrives in V1.1.

### `POST /export/usb` — admin

Triggers an immediate write to the configured USB destination, rather than waiting for the scheduled interval. Returns the path written and the number of entries included.
