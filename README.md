# Chiplog

An automated logbook for [Signal K](https://signalk.org). Chiplog writes the logbook from the data already on your boat's Signal K server — passages, track, engine and sail, instrument readings, alarms — and lets the crew add what sensors cannot know from a tablet at the helm: manoeuvres, notes and handwriting.

- **One entry per passage**, opened when the boat leaves and closed when it arrives, tolerating short stops such as a lock or a lunch anchorage.
- **GPS track**, distance, time under engine and under sail.
- **Hourly instrument readings**, as on a paper log, plus readings at departure, arrival and each manoeuvre.
- **Automatic events**: alarms, autopilot changes, strong wind, falling barometer.
- **Departure and arrival names**, looked up online and corrected once for good.
- **Consultation webapp**: logbook by day, map, timeline, corrections, export.
- **Tablet entry app**: big buttons for gloves and wet fingers, stylus handwriting, night mode, works through Wi-Fi dropouts.
- **Abandon-ship copy**: JSON, CSV and GPX, downloadable or written to a USB drive.

English and French, chosen from the browser's language.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [How the logbook is written](#how-the-logbook-is-written)
- [The logbook webapp](#the-logbook-webapp)
- [The tablet entry app](#the-tablet-entry-app)
- [Configuration](#configuration)
- [Signal K data used](#signal-k-data-used)
- [Backups and abandon ship](#backups-and-abandon-ship)
- [Privacy and online services](#privacy-and-online-services)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Requirements

- **Signal K server 2.x** running on **Node.js 22.13 or later**. Chiplog uses Node's built-in SQLite module, so there is nothing to compile — it installs the same way on a Raspberry Pi.
- **A position and speed over ground** on the Signal K bus (GPS). Everything else is optional and used when present.
- **Recommended:** [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate), which publishes `navigation.state` (moored, anchored, sailing, motoring). Without it, Chiplog decides from speed alone and says so in the apps.
- **Recommended:** a correct system clock, e.g. with `signalk-set-system-time`. The logbook is dated from the server's clock.
- **Optional:** a USB drive left plugged into the server, for the abandon-ship copy.
- **Optional:** an internet connection, for map tiles and place names. The logbook itself never needs one.

## Installation

Install **Chiplog** from the Signal K App Store (**Apps & Plugins → Store**), or from the command line:

```bash
cd ~/.signalk
npm install signalk-chiplog
```

Then restart the Signal K server, and in the Signal K admin:

1. Go to **Apps & Plugins → Configuration**, open **Chiplog**, tick **Enabled** and save. The defaults suit most boats; see [Configuration](#configuration).
2. Open **Webapps**: **Chiplog** is listed there. Its two pages are also reachable directly:
   - the logbook: `http://<your-server>:3000/signalk-chiplog/`
   - the tablet entry app: `http://<your-server>:3000/signalk-chiplog/entry/`

The logbook is stored in a single SQLite file, `~/.signalk/plugin-config-data/signalk-chiplog/chiplog.sqlite`.

## How the logbook is written

### Passages

A **passage** is one logbook entry: from leaving a berth or anchorage to arriving at the next one.

- **Departure.** A passage opens when the boat gets under way. It is dated from the moment the boat actually left — not the few minutes later when the decision was confirmed — and placed where it was last still.
- **Short stops** do not end a passage. Stopping marks it as stopped; moving again within the tolerance (30 minutes by default) carries on with the same passage. Staying stopped longer closes it, with the arrival time set to when the boat stopped.
- **Casting off** from the tablet opens the passage right away, before the boat moves (see [Departures](#departures-open-the-passage)).
- **Power cuts and restarts.** If the server comes back after the boat has been still for longer than the tolerance, the passage is closed at its last movement. A short restart carries on with the same passage.
- **Under way or stopped** comes from `navigation.state` when signalk-autostate provides it. Otherwise Chiplog averages speed over ground over 3 minutes: under way above 1 knot, stopped below half a knot. This keeps a boat swinging at anchor from starting passages.

A passage that was split in two — a stop just longer than the tolerance, for instance — can be merged back from the logbook webapp.

### Track and distance

While under way, a track point is recorded every 15 seconds, plus extra points on a turn of 15° or more or a speed change of 1 knot, so tacks show on the map without bloating straight lines. The distance is the length of the track.

### Engine or sail

Each passage is split into engine and sail periods covering the time under way. Chiplog decides from, in order:

1. `propulsion.*.revolutions` — any engine turning means engine;
2. `propulsion.*.state` (`started` / `stopped`);
3. `navigation.state` (`motoring` / `sailing`);
4. the configured default, **sail**.

A wrong period can be corrected in the webapp. A correction to the period in progress holds until the engine data actually changes.

### Instrument readings

Readings are taken at departure, **every hour on the hour** during the passage (configurable), at arrival, and with each manoeuvre logged live, so a reef appears with the wind that called for it. Each reading holds whatever is available among position, speed and course over ground, heading, speed through water, true and apparent wind, depth, barometer, air and water temperature, trip log and engine hours. A sensor that has gone silent is left blank rather than repeating an old value.

### Automatic events

Added to the timeline without anyone touching anything:

- **Alarms** — any Signal K notification reaching `alarm` or `emergency` (man overboard, engine alarm, anchor watch…), and when it clears.
- **Autopilot** — engaged, disengaged, mode changes.
- **Wind** — true wind, averaged over 2 minutes, rising above 20 and 30 knots and falling back below them (configurable).
- **Barometer** — a fall of 4 hPa or more over 3 hours (configurable).

An alarm at anchor between two passages goes to the passage that ended there, as long as the boat is within 1 nautical mile of that arrival.

### Place names

Departures and arrivals are named automatically:

1. **Known places first.** Within 200 m (configurable) of a place already named, that name is used.
2. **Otherwise online**, from OpenStreetMap's Nominatim service. Until it answers — at sea, out of reach of a network — the place shows its coordinates (e.g. `46.1466N 1.1686W`) as a provisional name, and the lookup is retried later.
3. **Corrections are remembered.** Renaming a departure or arrival in the webapp also renames that place for every later passage starting or ending nearby. Past passages keep the name they recorded.

## The logbook webapp

Open **Chiplog** from the Signal K webapps, or `/signalk-chiplog/`. Reading needs no more than read-only access.

- **Status bar** — under way under sail or engine, stopped, or waiting for data, with a link to the passage in progress. A warning shows when detection works from speed alone because signalk-autostate is missing.
- **Logbook** — passages grouped by day, newest first, with times, departure and arrival, distance, duration and an engine/sail bar. A passage across midnight appears on both days. Provisional place names are shown as such.
- **Passage page** — summary, map of the track (OpenStreetMap with OpenSeaMap seamarks, which can be hidden), the engine and sail periods, and the log: every reading and event in order, including handwritten notes. A passage in progress refreshes every minute.
- **Corrections** (read/write access):
  - rename the departure or arrival;
  - switch an engine period to sail or back;
  - close a passage in progress, e.g. to confirm an arrival;
  - merge with the previous or next passage;
  - delete a passage (admin).
- **Export** — download the whole logbook or a date range as JSON, CSV or GPX, and write the abandon-ship copy to the USB drive now (admin).

**Helm entry** in the top bar opens the tablet entry app.

## The tablet entry app

Open `/signalk-chiplog/entry/` on the tablet, or follow **Helm entry** from the logbook. For an app-like, full-screen launcher, use the browser's **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: menu → Add to Home screen / Install app).

### Logging a manoeuvre

Tap the manoeuvre: tack, gybe, reef in, shake out reef, sail change, anchor down, anchor up, moor, cast off, watch change. One tap logs it with the time, the position and an instrument reading.

- **Sail change** asks which sail went up: mainsail, genoa, jib, staysail, spinnaker, gennaker, code 0, storm jib, or any name you type.
- A banner then confirms it for 10 seconds, with two big buttons:
  - **Undo**, for a mistaken tap;
  - **Add a comment**, e.g. "25 kn, second reef".

### Departures open the passage

With no passage open, **Cast off** and **Anchor up** are highlighted. Tapping one opens the passage at that moment, and the header shows "Ready to leave since…" until the boat moves. Chiplog then carries on with that same passage. If the boat never leaves, it closes like any long stop; **Undo** right after the tap removes it altogether.

Other entries made with no passage open go to the last passage if the boat is still within 1 nm of where it ended — a note once moored belongs to the passage that brought you there. Anywhere else, the app asks you to cast off first.

### Notes and handwriting

- **Note** — type and tap **Log it**.
- **Handwriting** — write or draw on the pad with a stylus or a finger, optionally add a comment, and tap **Log it**. Pen pressure sets the line width. **Undo stroke** and **Clear** fix mistakes. Once a stylus has touched the pad, fingers are ignored, so a palm resting on the screen does not draw.

Handwritten notes appear as drawn in the logbook's timeline.

### Latest entries

Below, the latest entries of the current passage (or of the last one) are listed with their time. Each can take a comment, and your own entries can be deleted; a note's text can be edited.

### Night mode

**Night** switches to red on black, to keep night vision. The choice is remembered on the tablet.

### When the Wi-Fi drops

Keep logging. The header shows **Not connected** and how many entries are waiting. Each entry is kept on the tablet with the time it was made, and sent in order as soon as the server answers again, with the position the track recorded at that time. An entry sent just before the connection dropped is never logged twice.

If the server refuses a waiting entry when it comes back — typically nothing to attach it to — it is shown in red in the latest entries, to discard.

**Starting the app with no connection** needs HTTPS (see [Troubleshooting](#the-tablet-app-does-not-start-without-a-connection)). Over plain HTTP the app still keeps entries through a dropout, as long as it was loaded beforehand.

### With Signal K security enabled

Logging needs read/write access. The first time, the app shows **This tablet needs access**:

1. Tap **Request access for this tablet**.
2. In the Signal K admin, open **Security → Access Requests**, and approve **Chiplog tablet** with **read/write** permission. Choose a token expiry of **NEVER** so the tablet is not locked out at sea.
3. Within a few seconds, the tablet is in. It keeps its token.

To revoke it, delete the device under **Security → Devices**: the tablet asks for access again. **Sign in instead** uses a regular Signal K user account.

## Configuration

In the Signal K admin, **Apps & Plugins → Configuration → Chiplog**.

| Setting                                            | Default                               | What it does                                                                                            |
| -------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Stop duration that ends a passage                  | 30 min                                | Shorter stops stay within the same passage.                                                             |
| Under-way speed without navigation.state           | 1 kn                                  | Used only without signalk-autostate: under way above it, stopped below half of it.                      |
| Propulsion assumed without engine data             | sail                                  | When nothing says whether the engine is running. Set to engine on a motorboat.                          |
| Instrument snapshot interval                       | 60 min                                | Readings on this clock boundary during a passage.                                                       |
| Track point interval                               | 15 s                                  | A track point at least this often while moving.                                                         |
| Place matching radius                              | 200 m                                 | A departure or arrival this close to a known place takes its name.                                      |
| Name departures and arrivals with online geocoding | on                                    | Turn off to never send positions online; places are then named after their coordinates until corrected. |
| Geocoding service                                  | `https://nominatim.openstreetmap.org` | Any Nominatim-compatible service, e.g. a self-hosted one.                                               |
| USB export directory                               | —                                     | Where the abandon-ship copy is written, e.g. `/media/usb`. Empty turns the USB copy off.                |
| Automatic USB copy interval                        | 15 min                                | How often the USB copy is brought up to date. 0 turns the periodic copy off.                            |
| Copy to the USB drive at each arrival              | on                                    | Brings the USB copy up to date as soon as a passage ends.                                               |
| Wind speed thresholds                              | 20, 30 kn                             | Logged when the 2-minute average true wind crosses them.                                                |
| Barometric drop warning                            | 4 hPa / 3 h                           | 0 turns it off.                                                                                         |

## Signal K data used

None of these is required except position and speed over ground; each feature uses what the boat has.

| Purpose                   | Signal K paths                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passages, track, distance | `navigation.position`, `navigation.speedOverGround`, `navigation.courseOverGroundTrue`, `navigation.state`                                                                                                                                                                                                                              |
| Engine or sail            | `propulsion.*.revolutions`, `propulsion.*.state`, `navigation.state`                                                                                                                                                                                                                                                                    |
| Readings                  | `navigation.headingTrue` (or `headingMagnetic` + `magneticVariation`), `navigation.speedThroughWater`, `environment.wind.*`, `environment.depth.belowSurface` (or `belowTransducer`), `environment.outside.pressure`, `environment.outside.temperature`, `environment.water.temperature`, `navigation.trip.log`, `propulsion.*.runTime` |
| Events                    | `notifications.*`, `steering.autopilot.state`, `.mode`, `.engaged`, `.target`, `environment.wind.speedTrue`, `environment.outside.pressure`                                                                                                                                                                                             |

## Backups and abandon ship

- **Download** — Export page → JSON (the complete record, including tracks and handwriting), CSV (logbook lines in nautical units, for a spreadsheet) or GPX (tracks).
- **USB drive** — leave a USB drive plugged into the server and set the USB export directory. Chiplog then keeps a copy on it by itself: every 15 minutes and as soon as a passage ends (both configurable). **Write to the USB drive now** on the Export page makes a copy immediately. The copy fills a `chiplog/` folder on the drive with one JSON, CSV and GPX file per passage, named so that sorting by name sorts by date — e.g. `2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne.csv` (times in UTC; a passage in progress ends in `underway`).
  - Each export writes only passages that are new or changed since the last one, and removes the files of passages deleted, merged or renamed. Other files in the folder are left alone.
  - Each file is flushed to the drive before it appears, so pulling the drive out never leaves a half-written file.
  - The Export page shows the schedule, the last copy, the next one, and the last failure if any.
- **The database** — `chiplog.sqlite` in the plugin's data folder can be copied while the plugin is stopped.

## Privacy and online services

- **Place names.** With geocoding on, the position of each departure and arrival that matches no known place is sent to the geocoding service — OpenStreetMap's public Nominatim by default. Nothing else is sent, and nothing at all when it is off.
- **Maps.** The logbook webapp loads map tiles from OpenStreetMap and OpenSeaMap while the device viewing it is online. Offline, the track is still drawn, on a blank background.
- **Nothing else** leaves the boat. There is no account, analytics or cloud service.

Map data and place names © OpenStreetMap contributors (ODbL); seamarks © OpenSeaMap.

## Troubleshooting

### "Chiplog is not running"

The plugin is disabled or failed to start. Enable it under **Apps & Plugins → Configuration**, and check **Server → Server Logs** if it does not start.

### "Detected from speed alone"

Chiplog works, but departures and arrivals are decided from speed only. The message says why:

- **"install signalk-autostate"** — nothing publishes `navigation.state`. Install and enable signalk-autostate.
- **"until signalk-autostate makes its first decision"** — normal for a minute or two after the server starts.
- **"has not been updated since…"** — the source named stopped publishing. signalk-autostate republishes every 10 minutes while it receives position and speed: check that the GPS data reaches the server, and that the plugin is enabled.
- **"is “default” (from nmea0183.AI)"** — another device publishes a navigational status Chiplog does not use, typically the boat's own AIS transponder, and signalk-autostate's value is not there to take over. Check that signalk-autostate is enabled; Chiplog prefers its value over any other source.

### Passages are not opening

Check that `navigation.position` and `navigation.speedOverGround` are updating under **Data → Browser** in the Signal K admin. Without current data, Chiplog neither opens nor closes passages, and the status shows **Waiting for data**.

### "Your Signal K account is not allowed to do this"

Security is on and you are not signed in, or your account is read-only. Corrections need read/write access; deleting passages and writing to the USB drive need an admin.

### The tablet says the server does not accept device access requests

Turn on **Allow New Device Registration** under **Security → Settings** in the Signal K admin, or use **Sign in instead**.

### "No passage to log this in"

No passage is open and the boat is not near the last arrival. Tap **Cast off** or **Anchor up** first.

### The tablet app does not start without a connection

Browsers only allow an app to start offline and to be installed over HTTPS. Turn on SSL under **Server → Settings** in the Signal K admin, restart, and open the app with `https://` on the SSL port. Over plain HTTP, the app still keeps entries through Wi-Fi dropouts once it is loaded.

### "The last copy failed" on the Export page

The USB drive is not mounted at the configured directory, or cannot be written. The failure is also written once to the Signal K server log and shown in the plugin status. Plug the drive back in — and check it is mounted at the same place — and the next automatic copy catches up with everything that changed meanwhile.

### Wrong dates in the logbook

The server's clock is wrong — common on a Raspberry Pi without a real-time clock. Set it from GPS with `signalk-set-system-time`.

## Limitations

- **Not yet:** the PDF logbook facsimile (planned for V1.1), a places page, and editing manoeuvre shortcuts from the webapps.
- **Offline charts** are not provided.
- **One vessel per Signal K server**, and no per-crew-member authorship.

## Development

```bash
npm install          # also copies the browser libraries into public/vendor/
npm test
npm run lint
npm run demo:seed -- /tmp/chiplog-demo   # a demo logbook to try the webapps with
```

The functional specification is in [docs/SPEC.md](docs/SPEC.md), the data model in [docs/DATA_MODEL.md](docs/DATA_MODEL.md), and the REST API in [docs/API.md](docs/API.md). [CLAUDE.md](CLAUDE.md) describes the code layout and conventions.

## License

MIT — see [LICENSE](LICENSE). Changes are listed in [CHANGELOG.md](CHANGELOG.md).
