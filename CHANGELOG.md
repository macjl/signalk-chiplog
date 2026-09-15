# Changelog

All notable changes to Chiplog are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The tablet app's stylus canvas now prevents the default action on every contact, not just the pen's — a resting palm's touch was left to the browser, which could hijack it as a gesture and cancel the pen's in-progress stroke, or show a native text-selection highlight over the canvas.

## [1.1.0] - 2026-09-15

### Added

- A summary above the logbook's day-grouped list: number of passages, total distance and total time, across every passage logged rather than just the pages currently loaded (`GET /entries/stats`).
- Tide forecast: fetched near the departure position for the next 24 hours when a passage opens (Open-Meteo Marine, free and keyless, configurable and can be turned off), shown on the passage page with the departure's place, the date, time and height of each high/low tide, and the water height curve. Sits next to the engine/sail card, each taking about half the width on a wide screen instead of the full width. Heights are relative to mean sea level, not the chart datum nautical tide tables use, and the app says so (`datum: "msl"` in the API).
- Editing and deleting logbook lines from the webapp's passage page: any line's comment can be corrected, and a manoeuvre or note the crew logged themselves can be deleted (automatic lines — alarms, autopilot, weather, corrections — can only be annotated).
- Highest speed and wind seen on a passage, shown alongside the average speed on the passage page (`maxSpeed`/`maxWindSpeed` in the API). Wind (true and apparent) and heading now ride along with every track point, not just the hourly instrument snapshot, so a gust between snapshots is no longer missed.
- Automatic engine/sail switches now show as a line in the passage log, not just on the engine/sail strip, with the conditions at that moment (`propulsion_change` event).
- Facsimile PDF logbook: A4 landscape, a page per day in ship's time, with time, position, course, speed, wind, barometer, depth, engine or sail and remarks; departure and arrival lines with passage totals, day totals, handwritten notes drawn. Downloadable from the export page in the webapp's language and the device's time zone.
- Engine hours of every engine: each engine's hour counter is recorded in readings, shown at departure and arrival with the hours run on the passage page and in the PDF, and exported as one CSV column per engine and in the JSON (`engineRuntimes`).
- One PDF per passage in the USB copy, in the new logbook language and ship's time zone settings. Existing copies gain their PDFs at the next copy.
- Screenshots for the Signal K App Store listing (`signalk.screenshots` in `package.json`).

### Changed

- The tablet app's comment and delete actions on a recent entry are now icon buttons, keeping the same touch target size.
- Times are shown on the 24-hour clock in English too.

### Fixed

- The log reading in instrument snapshots now comes from `navigation.log` (the total, non-resettable distance log), not `navigation.trip.log`, which a crew resetting the trip counter could zero out mid-passage.
- Renaming a departure or arrival now also renames that place on every later passage that already reused it, as documented; an earlier passage keeps the name it recorded.
- An alarm's message is no longer repeated as its comment in the passage log.
- The arrival correction field no longer appears, and is refused by the API (`409 entry_active`), on a passage still in progress — it has no arrival yet, only a moving last-seen position.
- A note or handwritten sketch logged live now takes an instrument snapshot too, like a manoeuvre already did, so the conditions it was written in show in the log.
- The App Store icon (`signalk.appIcon`) pointed at a non-existent `icon.svg` at the package root; the icon has always lived at `public/icon.svg`.

## [1.0.0] - 2026-09-13

First release.

### Added

#### Logbook

- One logbook entry per passage, opened when the boat gets under way and closed when it arrives, with a configurable tolerance for short stops (30 minutes by default).
- Under way or stopped decided from `navigation.state` published by [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate), or from speed over ground averaged over 3 minutes when it is absent. Departures and arrivals are dated from raw speed, so the passage starts where the boat actually left.
- signalk-autostate's value is preferred when another source, such as the boat's own AIS transponder, also publishes `navigation.state`. When detection works from speed alone, the apps say why.
- Passages closed at their last movement after a power cut; passages split by a long stop can be merged back.
- GPS track at a configurable interval (15 s by default), with extra points on turns and speed changes; distance from the track.
- Engine and sail periods from engine revolutions, engine state, `navigation.state` or a configurable default, with manual correction.
- Instrument readings at departure, every hour on the hour (configurable), at arrival and with each live manoeuvre.
- Automatic events: Signal K alarms and emergencies, autopilot changes, true wind crossing configurable thresholds, barometer falling over 3 hours.
- Departure and arrival names from known places, then online geocoding (any Nominatim-compatible service, can be turned off); a renamed place is remembered for later passages.

#### Logbook webapp

- Status bar, passages grouped by day, passage page with map (OpenStreetMap and OpenSeaMap), engine and sail periods, and the log of readings and events, handwritten notes included.
- Corrections: rename departure or arrival, switch an engine or sail period, close, merge and delete passages.
- Export of the whole logbook or a date range as JSON, CSV (nautical units) or GPX.
- English and French.

#### Tablet entry app

- Installable app at `/signalk-chiplog/entry/`, designed for gloves and wet fingers, with a red night mode.
- Manoeuvre shortcuts, with the sail picked on a sail change; casting off or weighing anchor opens the passage before the boat moves.
- Keyboard notes and stylus handwriting with pressure and palm rejection.
- Undo and comment right after each entry; latest entries with edit and delete.
- Entries kept on the tablet while the Wi-Fi is down and sent in order when it is back, never twice.
- Signal K device access requests when security is enabled; offline start-up over HTTPS.

#### Abandon-ship copy

- One JSON, CSV and GPX file per passage on a USB drive, named to sort by date, written only when new or changed, with obsolete files removed.
- Copied automatically every 15 minutes and at each arrival (both configurable), or on demand; a missing drive is reported in the plugin status and on the export page.

#### API and data

- REST API under `/plugins/signalk-chiplog/api`, documented in [docs/API.md](docs/API.md).
- Single SQLite database through Node's built-in `node:sqlite`: no native module to build.

[Unreleased]: https://github.com/ricard33/signalk-chiplog/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ricard33/signalk-chiplog/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ricard33/signalk-chiplog/releases/tag/v1.0.0
