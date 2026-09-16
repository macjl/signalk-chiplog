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
  - **Standard Signal K webapp**: log consultation, plugin configuration, export. Implemented in `public/`, served by Signal K at `/signalk-chiplog/`: day-grouped log, passage page (map, engine/sail strip, logbook lines with a comment edit and, for the crew's own manoeuvres and notes, delete), corrections (place names, engine/sail, close, merge, delete) and export (downloads, USB write). Plugin configuration stays in the Signal K admin, which the webapp links to.
  - **Dedicated, installable PWA, tablet/stylus-oriented**: real-time field entry (handwritten annotations, manoeuvre shortcuts), designed for use at the helm, with gloves or wet fingers. Implemented in `public/entry/`, served at `/signalk-chiplog/entry/`: manoeuvre pad (with the sail picked on a sail change), keyboard notes, a stylus canvas, the latest entries with delete and comment, undo and comment right after each entry, a night mode, and an offline queue (§4.9).
- **Storage**: a single **SQLite** database in the plugin's data folder, covering entries, events, GPS track, and annotations (including vectorized handwritten strokes), accessed through Node's built-in `node:sqlite` module. The GPS track remains exportable as GPX on demand (generated from the database, not stored as a separate file).
- **Instance scope**: one vessel per Signal K instance (standard usage for SK plugins) — no multi-profile/multi-fleet management in the data model.

## 3. Logbook model

### 3.1 Granularity of an entry ("passage")

A log entry corresponds to a start → underway → stop cycle, **with configurable tolerance for short stops**:
- A `stop_closure_threshold` parameter (e.g. default value 30 min, user-configurable) defines the stop duration below which we stay within the same entry (e.g. waiting at a lock, lunch anchorage).
- Beyond the threshold, the entry is closed; a new underway cycle will trigger a new entry.
- Each entry carries: start date/time, end date/time, start/end position, **start/end place name** (see §4.8), distance covered, engine vs sail duration, GPS track.
- Manual concatenation of two entries is possible. The earlier entry's own end — the stop the merge is folding away — would otherwise leave no trace once overwritten by the later entry's end; it is kept as a `stopover` event on the surviving entry instead (§4.6), at that stop's position, dated no earlier than the entry's own arrival reading so it still follows it on the timeline rather than the raw, earlier moment detection dated the stop from.

### 3.2 Grouping by day

Grouping "by day" is a **display-time aggregation view** (an entry may span midnight on a long passage): the logbook calendar/list groups entries by start date, and displays entries spanning multiple days visibly on each day concerned.

Above the day-grouped list, a summary line totals every entry, not just the pages loaded so far: number of passages, total distance, total elapsed time (`GET /entries/stats`).

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

  As implemented (`lib/track-recorder.js`), position fixes are read once a second:
  - an **interval point** every `trackIntervalSeconds` (15 s by default), skipped until the vessel has moved 10 m, so a wait at a lock does not pile up identical points;
  - an extra point on a **course change of 15° or more** — only above 2 kn, since course over ground is noise at low speed — or a **speed change of 1 kn or more**, at most every 2 s.
- **Points belong to a moving passage.** They are held in memory while no passage is open or while the open one is stopped, and attached once it moves: detection dates a departure back to when the vessel left its berth, up to 20 minutes before it opens the entry, so the held points make the track start there rather than a mile out. Up to 20 minutes of points are held.
- **Wind and heading ride along with each point** (migration 6), and **speed through water** since migration 9: true and apparent wind speed/angle, heading and STW — the same readings `observations` takes hourly, but at the track's own resolution, so a figure like the highest wind speed seen on a passage reflects an actual gust rather than whatever an hourly sample happened to catch.
- **Distance** is the sum of the distances between consecutive track points, updated as points are recorded.
- Standard **GPX** export per entry or for a date range, generated on the fly from the SQLite database.
- **Interactive map embedded in the webapp** (track displayed on tile background), in addition to export — no delegation to freeboard-sk for display. A small boat marker sits at the selected point, pointing along its heading (falling back to course over ground); a scrubber under the map steps through the track's points, defaulting to the latest one so it doubles as the boat's current position on a passage in progress. A band below it shows that point's time, SOG, COG, STW, TWS, TWD, TWA and AWA — SI readings converted for display like everywhere else, TWA computed from TWD and heading rather than stored.

### 4.2 Engine/sail and stopped/underway detection

- Automatic engine/sail detection, logged with metadata (average RPM, duration); manual correction possible on an existing entry.

**Engine or sail** (implemented in `lib/propulsion-detector.js`, evaluated with passage detection):

- **Source, in order of trust.** Current `propulsion.*.revolutions` — any engine turning means engine, which covers twin-engine boats; otherwise current `propulsion.*.state` (`started`/`stopped`, as published by `signalk-alternator-engine-on`); otherwise `navigation.state` (`motoring`/`sailing`); otherwise the configured `defaultPropulsion` (`sail` by default, like signalk-autostate). Engine data is current for 2 minutes after it last changed. Engine off while under way counts as sail.
- **Segments only cover time under way.** A passage's first segment starts at its departure; a stop ends the current segment when the vessel stopped, and moving again starts a new one when it started moving — an engine idling at a lock is not motoring time. Engine plus sail duration is therefore time under way.
- **Durations are kept current** during a passage, the open segment counting up to now.
- **Average RPM** is kept for engine segments, over the running engines.
- **Corrections hold.** A manual correction of the ongoing segment lasts until the engine data actually changes, so a boat whose sensors keep reporting the old value — or that has none — keeps the correction rather than reverting on the next cycle. After a restart, an automatic segment that disagrees with the engine is split.
- **An automatic switch shows in the log.** A `propulsion_change` event is logged at each actual sensed transition, the same way a manual correction is above, so the journal reads "under way under engine"/"under way under sail" where it happened, not just the engine/sail strip. Not logged for the passage's first segment, nor for the resync a restart does when it finds the engine disagreeing with an automatic segment — neither is something that happened at that moment.

**Stopped/underway and passages** (implemented in `lib/detection.js`), evaluated every 15 seconds:

- **Decision.** `navigation.state` decides, when it is current and a recognised value: `moored`, `anchored`, `aground` and `not-under-way` mean stopped; `sailing`, `motoring` and the working statuses (fishing, towing…) mean under way. Otherwise the **speed fallback** decides: speed over ground averaged over 3 minutes, under way above the configured speed (1 kn by default) and stopped below half of it. Averaging keeps a boat swinging at anchor from starting a passage; the gap between the two thresholds keeps it from flickering.
- **Several sources of navigation.state.** An AIS class A transponder also reports the boat's own navigational status — often left undefined (`default`), or at "under way using engine" while moored — and Signal K shows whichever source updated last. When signalk-autostate is one of the sources, its value is the one used. When detection falls back to speed, the apps say why: no `navigation.state`, signalk-autostate not decided yet, a value not updated for 20 minutes (with its source and time), or a value Chiplog does not use (with its source).
- **Dating and placing transitions.** signalk-autostate works from distance covered over a window, so it announces a departure several minutes late, when the boat has already left the harbour. Whatever decided, the departure is dated when raw speed first left standstill and placed where the vessel was last still; an arrival is dated when raw speed first dropped to standstill. This is what makes departure and arrival positions fall within a known place's radius (§4.8), which is filled in automatically.
- **Short stops.** A stop marks the entry as stopped; moving again within the tolerance (`stopClosureMinutes`, 30 by default) resumes it; staying stopped closes it, with the end time set to when the vessel stopped — not when the tolerance ran out.
- **Only a transition opens a passage** — or the crew casting off (§4.3). An entry closed by hand while the boat is still moving is not reopened; the next real departure opens the next one.
- **Stale data.** A value counts as current while its timestamp keeps changing — measured by the plugin's own clock rather than by comparing timestamps to it, since a Raspberry Pi without a real-time clock can boot with the wrong date. Without current data, detection neither opens nor ends a passage.
- **Restarts.** While under way, the entry records its last movement about once a minute. If the plugin starts to find a passage open with no movement for longer than the tolerance — typically power switched off on arrival — the passage is closed at that last movement. A restart shorter than the tolerance carries on with the same passage; a longer one mid-passage splits it, which the manual merge (§3.1) repairs.

Known limitation: timestamps written to the logbook come from the host's clock, so a host whose clock is wrong records wrong times. Keep the clock set from GPS (e.g. with the `signalk-set-system-time` plugin).

### 4.3 Manoeuvre shortcuts

- Approach adopted: **predefined + extensible list**.
- Base list to be defined precisely but should cover at minimum: tacking, gybing, reefing in/out, sail change (with selection of the sail hoisted), anchoring (anchored/weighed), mooring/casting off, watch change.
- Each shortcut logs a timestamped event + position in the current entry; the user can add an optional comment right after, or undo it.
- **Departure manoeuvres open the passage.** Casting off or weighing anchor with no passage open opens one at that moment — the crew knows it is leaving before the boat moves. The passage starts stopped: detection carries it on when the vessel gets under way, and closes it like any long stop if it never does. Undoing that manoeuvre before the vessel moves removes the passage.
- **Entries without an open passage.** Other manoeuvres and notes go to the last passage while the vessel is within 1 nm of its arrival, like automatic events (§4.6); otherwise they are refused, with a message asking to cast off first.
- A sail change records the sail hoisted: main, genoa, jib, staysail, spinnaker, gennaker, code 0, storm jib, or a name typed in.
- The user can add their own shortcuts (name, icon, category) in V2 if not a priority for the MVP.

### 4.4 Handwritten and keyboard annotations

- Keyboard entry: free-text field, timestamped, attached to the current entry (or to a specific event).
- Handwritten entry: canvas on the tablet PWA, stylus capture, full-screen while it is the active tab.
  - **Format adopted: vector** (sequence of strokes, each stroke being a list of timestamped points with pressure/width, plus the colour and tool it was drawn with). Allows lossless replay and resizing, and lightweight export. Image rendering (PNG) is still generated on demand for PDF/preview.
  - Implemented in the tablet PWA: pointer events at the device's full rate, pressure from a pen, a toolbar (fine pen, thick pen, highlighter, eraser, undo, colour), and palm rejection — once a pen has touched the canvas, fingers are ignored. Points are in canvas pixels with the canvas size stored alongside. The eraser removes only the points it actually touches, splitting a stroke in two rather than deleting all of it; undo restores the state before the last stroke or eraser gesture, whichever came last. A stroke's colour and width (and `tool: "highlighter"` for its transparency) travel with it end to end — drawn the same way in the webapp's timeline and the PDF, not just on the tablet.
- Both annotation types appear in the entry's timeline, timestamped and geolocated.

### 4.5 Backup / continuity in case of abandoning ship

Two complementary mechanisms adopted for V1:
1. **Automatic export to USB drive** (PDF, CSV, JSON, GPX) — **configurable** write frequency (e.g. every X minutes, or on each entry closure). Requires a USB drive to be permanently plugged into the Signal K host.
   - The copy holds **one file per format per passage**, named `2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne.json` so that sorting by name sorts by departure, in a `chiplog/` subdirectory. Each export writes only new or changed passages — a USB drive is slow and wears — and removes the files of passages deleted, merged or renamed. Written automatically every `usbExportIntervalMinutes` (15 by default; 0 turns it off) and at each arrival (`usbExportOnArrival`, on by default), and on demand from the webapp. A missing drive is logged once, shown in the plugin status and on the export page, and the copy resumes when it is back.
   - The PDF follows a **traditional logbook facsimile** layout, delivered in V1.1:
     - A4 landscape, a page per day (continued on further pages when full), in ship's time: the webapp's download uses the browser's time zone and language, the USB copy the plugin's `logbookTimeZone` (the server's by default) and `logbookLanguage`. The time zone and its UTC offset are printed on every page.
     - Columns: time, position, course (or heading), speed over ground, wind (true, else apparent), barometer, depth, engine or sail, remarks. Departure and arrival lines carry their instrument snapshot, place, distance, duration and engine/sail times; a passage crossing midnight is announced at the top of the next day; each day ends with its distance and engine/sail times.
     - Remarks say what the webapp says (manoeuvres with the sail, notes, alarms, autopilot, weather, corrections), from the same modules; handwritten notes are drawn from their strokes.
     - Generated without dependency: the standard PDF Helvetica fonts, whose WinAnsi encoding covers English and French.
2. **Automatic publication to a remote server** — target undefined for V1, designed as a **generic extension point** (user-configurable webhook/API), with no fixed integration to a particular service.

### 4.5.1 Instrument snapshots

The logbook lines the facsimile PDF renders — and the CSV export already lists — come from instrument snapshots (`observations`; see [DATA_MODEL.md](DATA_MODEL.md) for the readings recorded). During a passage one is taken:

- **at departure**, when detection opens the entry;
- **on each clock boundary** of `observationIntervalMinutes` — on the hour by default, as on a paper log — including during a short stop, as long as the entry is open;
- **at arrival**, dated from the actual end of the passage rather than from the later tick that closes the entry once the stop has held past the tolerance — except when it closes long after the tolerance ran out, typically after a power cut, since conditions then say nothing about that arrival;
- **with each manoeuvre, note or sketch** the crew logs as it happens, so the reef appears with the wind that called for it and a note with the conditions when it was written. One logged with an explicit past time — replayed from the tablet's offline queue — gets no snapshot: current readings say nothing about a moment already gone by.

A snapshot already in a periodic slot, such as one taken for a manoeuvre, stands in for the periodic one.

Engine hours are recorded for every engine that publishes an hour counter (`propulsion.<id>.runTime`), so a twin-engine boat logs both. The passage page and the PDF show each engine's counter at departure and at arrival — the latest reading for a passage in progress — and the hours run in between; the CSV has a column per engine. Sensors are followed on every detection cycle, not only when a snapshot is due, so a sensor that died during the hour is recognised as such.

### 4.5.2 Tide forecast

When a passage opens, the plugin fetches the predicted water height near the departure position for the next 24 hours, and shows it on the passage page: the departure's place name, the high/low tide times and heights, and the height curve.

As implemented (`lib/tide-forecaster.js`):

- **Source.** [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api) (`sea_level_height_msl`), free and keyless under CC BY 4.0 — no per-vessel account or cost, like the Nominatim geocoding service. `tidesEnabled` turns it off; `tideUrl` points at a self-hosted Open-Meteo instance instead of the public one, mirroring `geocodingUrl`.
- **Relative to mean sea level, not a chart datum.** `sea_level_height_msl` is referenced to global MSL; nautical tide tables (SHOM and similar) reference "hauteur d'eau" to the lowest astronomical tide instead, which can differ by several metres and is not something a day of readings can derive. The API and the webapp say so plainly (`datum: "msl"`, a note under the chart) rather than presenting a height that looks charted but is not. Times of high and low tide are unaffected — a vertical offset does not move them.
- **One fetch per passage, at departure**, not a continuous subscription: the position and the 24 h window are fixed at that moment. Requested and stored in one call — no separate lookup for extremes; a high or low is a local peak or trough in the stored hourly curve, found when displayed rather than by asking the service twice.
- **Offline is normal, as for geocoding**: a failed request is retried after 5 minutes, doubling up to an hour, for as long as the departure is still recent enough for a fetch to mean anything (3 hours); past that, or once the service answers with nothing usable for the position (an inland lake, a river far from tidal water), no forecast is recorded and none is asked for again for that passage.
- **Hourly resolution**, so a high or low tide time is accurate to within about half an hour — adequate for a logbook reference, not for a lock or a bar crossing planned to the minute.

### 4.6 Automatically logged Signal K events

In addition to engine/sail and manual manoeuvres, the log automatically captures:
- **critical SK notifications** (`alarm`/`emergency` levels: MOB, engine alarm, anchor watch triggered, etc.);
- **autopilot state changes** (engaged/disengaged);
- **configurable weather threshold crossings** (e.g. wind > X knots), to automatically trace the conditions that prompted a manoeuvre.

As implemented (`lib/event-watcher.js`, checked every second):

- **Notifications.** Any Signal K notification reaching `alarm` or `emergency` is critical, whatever its path — no list of paths to maintain, and an alarm from a plugin nobody anticipated is still logged. The log records it when raised (with an instrument snapshot), on escalation, and when it clears or disappears. `warn` and `alert` are not logged. After a restart, the log itself says what was already recorded: an alarm still open is not repeated, and one that cleared meanwhile is closed.
- **Autopilot.** Engagement, disengagement, and mode changes while engaged, from `steering.autopilot.engaged` and `.mode` (the server's Autopilot API) or, for older autopilot plugins, `steering.autopilot.state` (`standby` meaning disengaged), each with an instrument snapshot. The target heading or wind angle goes with it. Only during a passage: an autopilot tried at the dock is not logbook material. Autopilot alarms arrive as notifications.
- **Wind thresholds.** True wind speed averaged over two minutes, so a gust does not count, logged when it rises above each configured threshold (`windSpeedThresholds`, 20 and 30 kn by default) and when it falls back below it, with hysteresis (2 kn or 10 %, whichever is larger). The first reading after start-up only sets where the wind stands: a gale already blowing is a condition, not a crossing.
- **Barometric drop.** A fall of `pressureDropThreshold` (4 hPa by default, 0 to disable) over three hours, logged once, and again only after the fall has eased to half that. The three hours of history are held in memory, so the check needs three hours after a restart.

**Which passage an event belongs to.** The open one. Between passages, alarms and weather events go to the last passage if the vessel is still within a nautical mile of where it ended: an anchor dragging overnight belongs to the passage that brought the boat to that anchorage, and appears after its arrival. Further away, with no passage to hold them, they are not logged.

### 4.7 Reading Signal K data

- Subscription to relevant paths (position, speed, heading, wind, propulsion, navigation state) via the SK server's standard subscription mechanism.
- The plugin must tolerate the absence of certain data (e.g. no wind sensor) without blocking the creation/operation of an entry.

### 4.8 Place names (departure / arrival)

When creating and closing an entry, Chiplog attempts to associate a **place name** with the departure position and the arrival position (only these two points — no naming along the track):

1. **Local lookup first**: the plugin checks whether the position falls within the radius of an already-known place (created automatically or manually corrected during a previous passage). If so, its name is reused directly, with no network call.
2. **Otherwise, online reverse geocoding** (e.g. Nominatim/OpenStreetMap) if a connection is available: the returned name is proposed as a default value, editable before confirmation.
3. **If neither works** (no known place nearby, no connection): a name generated from the coordinates is used by default (e.g. "46.1234N 1.5678W"), pending manual correction.

**Matching radius**: a single global configurable parameter in the plugin settings (e.g. 200 m by default), applied to all registered places — no per-place setting in V1.

**Remembering corrections**: as soon as the user edits the proposed name (whether it came from online geocoding or the coordinate-generated name), the correction is stored as a **known place** (name + position) and will automatically be reused for any future departure/arrival position falling within the configured radius — with no further call to the online service. It also renames that place on any entry already logged that reused it and is timestamped later than the one being corrected, so the log does not go on showing a name now known to be wrong; an entry timestamped earlier keeps the name it recorded.

**As implemented** (`lib/place-names.js`):

- **Steps 1 and 3 happen at once, step 2 later.** Detection cannot wait on the network — usually absent at sea — so a departure or arrival gets a known place's name immediately or, failing that, a name from its coordinates flagged as *pending*. A background queue then looks pending names up online, newest passage first.
- **The service** is any Nominatim-compatible endpoint (`geocodingUrl`), the public OpenStreetMap instance by default. `geocodingEnabled` turns lookups off for privacy; pending names then keep their coordinates until corrected, and are looked up if it is turned back on. Its usage policy is respected: an identifying `User-Agent`, at most one request every 2 seconds, and a handful of requests per passage.
- **Offline is normal.** A failed request keeps the name pending and retries after 5 minutes, doubling up to an hour, so names fill in once the boat is back in range.
- **Choosing the name.** Near a marina Nominatim answers with the quay's road, and at sea with a bare administrative boundary; neither is a logbook place name. The name is the settlement with its district when there is one — "La Rochelle (Les Minimes)" — or a marina's or harbour's own name when that is what was found. No settlement at all is a final answer: the coordinates stay, and the position is not asked about again.
- **The places table is the cache.** Each geocoded name becomes a place with `source: geocoding`, so the next departure or arrival within the radius is named from it with no request — and a crew correction of that name (`source: manual`) wins from then on.
- **A lookup never overrides the crew.** A result is written only if the name is still pending *for the position that was looked up*: a name typed or removed, or a position corrected, while the request was out stays as the crew left it.
- **Attribution.** Names from the public instance are OpenStreetMap data (© OpenStreetMap contributors, ODbL); a UI displaying them must say so.

### 4.9 Tablet entry and the boat's network

- **Offline queue.** An entry the server cannot take — no Wi-Fi, server or plugin down, access not granted yet — is kept on the tablet with the time it was made, corrected by the server's clock, and sent in order once the server answers again. Each carries an identifier, so one that reached the server before the connection dropped is not logged twice. Its position is the track's at that time. An entry the server refuses on replay (e.g. no passage to attach it to) is set aside and shown, to discard.
- **Access.** With Signal K security on, logging needs read/write access. The tablet uses Signal K's device access requests: it asks once, an administrator approves it in the Signal K admin, and the tablet keeps the token. Signing in with a user account also works.
- **Installing and starting offline** use a service worker, which browsers only allow over HTTPS (or on localhost). Over plain HTTP — the usual boat set-up — the app works and queues entries, but needs the server to load. Signal K's own SSL setting provides HTTPS.
- The list of manoeuvre shortcuts is remembered on the tablet, so an app started offline has its buttons.

### 4.10 Retrospective analysis

Reconstructs passages Chiplog never saw live — installed after the fact, or stopped for a while — from a history the boat already has in InfluxDB 1.x, written there by [signalk-to-influxdb](https://github.com/tkurki/signalk-to-influxdb) (a recommended companion plugin, not a dependency).

- **Same pipeline as live, not a re-implementation.** `lib/replay.js` drives the exact detection, propulsion, observation, track recording and event watching modules used every 15 seconds live (§4.2, §4.5.1), but by a virtual clock stepping through the requested past range as fast as the database allows, fed by historical values instead of the server's current ones. A passage it produces is one Chiplog would have logged had it been running at the time — the same thresholds, the same freshness rules, no separate "historical" logic to keep in sync.
- **Only where the vessel moved.** A light first pass (`"scanning"` in `GET /replay`) reads the whole range as one mean speed over ground per minute, plus signalk-autostate's `navigation.state`, and keeps the stretches where the vessel may have been under way: a minute whose mean speed reaches half the fallback under-way speed (deliberately generous — replaying too much only costs time), or an under-way autostate state, until the next state or until it would have gone stale (20 min). Each stretch is widened by 30 minutes before (detection dates a departure from up to 20 minutes of raw speeds) and by the stop-closure delay plus 25 minutes after (detection's late-closure margin, autostate's lag); overlapping ones merge into a window. Only windows are loaded and replayed (`"replaying"`), each as if the plugin had been started at its beginning; a passage still open when its window ends is followed six hours further at a time until it closes. Weeks in port therefore cost next to nothing — the approach [signalk-sailing-logbook](https://github.com/johansolve/signalk-sailing-logbook) takes, without its separate detector. Stepping every second through the whole range, loading every raw reading, made a month take the best part of an hour and more memory than a Raspberry Pi has.
- **At the track interval, not every second.** A window's history is loaded as the last value of each `trackIntervalSeconds` bucket (bounded to 1–60 s), dated at the bucket's end so the replay never sees a reading before it was published, and track sampling and event watching step at that interval (detection still ticks every 15 s). The extra track points live recording adds on turns and speed changes between two intervals are lost; manoeuvre precision is not what a reconstruction is for.
- **Commits once per slice.** The replay runs ten simulated minutes per database transaction (`withTransaction` calls made inside it join it), rather than committing — and syncing an SD card — for every detection tick and track point. A slice is synchronous, so live code never runs inside one.
- **Reads InfluxDB directly, in bounded requests.** `lib/influx-history.js` knows signalk-to-influxdb's schema: one measurement per Signal K path, tagged with context (self) and source (for a path more than one source publishes, `navigation.state` chief among them — resolved the same way the server itself would). The motion scan asks for a week at a time; a window's history is fetched six hours at a time, with a short pause between requests, then answered from memory as fast as the replay loop asks, and dropped once the window is done — a boat's InfluxDB often shares its Raspberry Pi with Signal K itself, and a fixed-size request keeps each query's result small and gives the database room to recover between them.
- **Filtered to one vessel context** — the server's own by default, overridable (`influxSelfContext`) for running the replay from a different Signal K server than the one that wrote the history, e.g. development against a production database. Before fetching anything, the actual context values found in the database are checked against it: none matching fails with what was found instead of a replay that runs to completion and reconstructs nothing, silently.
- **Every InfluxDB query is bounded to 30 s.** Node's `fetch` has no timeout of its own, so an unreachable or overloaded database would otherwise hang far longer than that for an error no clearer once it arrived — a bare "fetch failed" instead of the actual connection problem.
- **One reconstruction at a time**, run in the background from the webapp: `POST /replay` starts it and returns immediately, `GET /replay` reports progress (including which phase is in flight), `POST /replay/cancel` stops one in flight, fetching or replaying (`lib/replay-job.js`).
- **Refuses a range that overlaps a passage already on record**, rather than risking a duplicate or a conflicting one — reconstruction only ever adds passages, never merges into or edits an existing one.
- **Refuses to run while a passage is under way**, whatever the requested range: the replay drives the same detector, track recorder and event watcher as live detection, against the same database, so the two touching the open passage's row at once would corrupt it rather than merely disagree.
- **Known gaps, by what a typical InfluxDB history holds:**
  - Weather thresholds (§4.5) crossed while the vessel lay still outside any window — strong wind or a falling barometer at anchor after arrival — are not logged, and each window starts with the barometer's three-hour reference empty, as after a plugin restart.
  - Signal K notifications (alarms) usually are not archived as a time series the way a numeric reading is, so critical-notification events are not reconstructed.
  - True wind angle is derived from true wind direction and heading rather than read as its own path, since it needs no sensor of its own — the same as live.
  - A boat with more than one active source for a path Chiplog does not explicitly tag-disambiguate falls back to whichever the history holds, same as detection's own fallback when a source is unrecognised (§4.2).

## 5. Data model and API

The data model has been refined into a precise schema: the authoritative DDL lives in [`lib/database.js`](../lib/database.js), with the conventions and rationale documented in [DATA_MODEL.md](DATA_MODEL.md). Entities: `log_entries`, `track_points`, `observations`, `propulsion_segments`, `events`, `places`, `manoeuvre_types`, `tide_forecasts`.

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
8. Manual + automatic configurable USB export (JSON/CSV/GPX from V1; facsimile PDF in V1.1).
9. Day-grouped view in the consultation webapp.

Brought forward from V2: handwritten annotations, in the tablet PWA (§4.4).

Deferred to V2: full shortcut customization, publication to a remote server, dedicated mobile companion app, crew profiles/permissions, advanced map (offline tiles, etc.).

*(This MVP breakdown is a proposal — to be validated with you before committing to it.)*

## 7. Decisions settled during scoping

| Topic | Decision |
|---|---|
| Storage | SQLite (single database: entries, events, track, annotations) |
| SQLite driver | Node's built-in `node:sqlite` — no native compilation, which matters on Raspberry Pi. Raises the floor to Node >= 22.13 |
| Handwritten annotation format | Vector (timestamped strokes/points + pressure, canvas size); implemented in V1 in the tablet PWA |
| Author / multi-crew | No author concept in V1 (V2 if the need is confirmed) |
| signalk-autostate dependency | Optional, with internal fallback (SOG threshold) if absent |
| Engine/sail sources | `propulsion.*.revolutions`, then `propulsion.*.state`, then `navigation.state`, then a configurable default (`sail`); segments only cover time under way (§4.2) |
| Critical notifications | Any notification in `alarm` or `emergency`, whatever its path (§4.6) |
| Weather thresholds | True wind averaged over 2 min against configurable speeds (20 and 30 kn); barometric fall of 4 hPa over 3 h (§4.6) |
| Events between passages | Attached to the last passage while within 1 nm of its arrival; otherwise not logged (§4.6) |
| Webapp stack | Preact + htm as one vendored ES module, no build step, no CDN (a boat is usually offline); Leaflet for the map. The tablet PWA shares it |
| Entry with no passage open | Cast off / anchor up opens a passage; other entries go to the last passage within 1 nm of its arrival, else are refused (§4.3) |
| Tablet offline | Entries queued on the tablet with their time and an idempotency key, replayed in order (§4.9) |
| Tablet access | Signal K device access request, token kept on the tablet; a user login works too (§4.9) |
| Webapp languages | English and French, chosen from the browser (`?lang=` overrides) |
| Map tiles | OpenStreetMap with the OpenSeaMap seamark overlay, online; offline the track is still drawn on a blank map. Offline charts are V2 |
| Instrument snapshots | At departure, hourly on the clock (configurable), at arrival and with each live manoeuvre, note or sketch (§4.5.1) |
| Tide forecast | Open-Meteo Marine, free and keyless, fetched once at departure for the next 24 h; extremes found from the stored curve, not asked for separately; heights relative to mean sea level, disclosed as such rather than presented as a charted datum (§4.5.2) |
| Speed fallback | SOG averaged over 3 min; under way above a configurable speed (1 kn), stopped below half of it. Transitions dated from raw speed in both modes (§4.2) |
| GPS track sampling | Configurable fixed interval (15 s) + extra point on a 15° course or 1 kn speed change (§4.1) |
| PDF export | Traditional logbook facsimile, A4 landscape, a page per day in ship's time, English or French; home-made PDF writer with the standard fonts, no dependency (§4.5) |
| USB copy | One JSON, CSV and GPX file per passage, written when new or changed; every 15 min and at each arrival by default (§4.5) |
| Automatic SK events (beyond engine/sail/manoeuvre) | Critical notifications, autopilot, configurable weather thresholds |
| Multi-vessel | One vessel per Signal K instance, no multi-profiles |
| Remote server target | Undefined for V1; designed as a generic extension point (configurable webhook/API) |
| Automatic place names | Online geocoding (e.g. Nominatim/OSM) with fallback to already-known local places |
| Geocoding service | Any Nominatim-compatible endpoint, public OpenStreetMap instance by default, can be disabled; looked up in the background, retried when offline (§4.8) |
| Place matching radius | A single global configurable radius (no per-place setting in V1) |
| Place not found (offline, first visit) | Name generated from coordinates, manually correctable |

### Remaining minor points (non-blocking for starting)

- None at present.

## 8. Suggested next steps

1. ~~Define the precise SQLite schema (DDL) and the plugin's REST API.~~ Done — see [DATA_MODEL.md](DATA_MODEL.md) and [API.md](API.md).
2. ~~Implement the REST API defined in [API.md](API.md) on top of the schema.~~ Done, with tests. `getOpenApi()` remains.
3. ~~Stopped/underway and passage detection.~~ Done (§4.2), with track recording (§4.1), engine/sail segments, instrument snapshots (§4.5.1), automatic events (§4.6) and place names with online geocoding (§4.8). The plugin's data side is complete.
4. ~~Build the tablet entry PWA.~~ Done (§2, §4.3, §4.4, §4.9), handwriting included.
5. ~~Build the consultation webapp.~~ Done (§2). Not in it yet: a places page and manoeuvre-shortcut management.
6. ~~Scheduled USB export (§4.5), then the facsimile PDF (V1.1).~~ Done.
