# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language convention

All project artifacts — code, comments, documentation, commit messages — are written in **English**. Conversations with the repository owner are held in **French**.

## Commands

```bash
npm test                                           # node --test, every test/*.test.{js,mjs}
node --test test/entries.test.js                   # one file
node --test --test-name-pattern="merge" test/      # tests whose name matches
npm run lint          # eslint .
npm run lint:fix      # eslint . --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check .
node scripts/vendor.js  # refresh public/vendor/ (also run by `prepare` on npm install)
```

Tests use Node's built-in `node:test` — no framework dependency, matching the `node:sqlite` choice. `test/helpers.js` starts the plugin behind a real Express 4 app (the version signalk-server uses) with a router that mimics the server's `asPluginRouter`, recording the access level of each route. Tests seed data by writing SQL directly, since no API route creates entries.

A husky `pre-commit` hook runs `lint-staged`, which applies `eslint --fix` and `prettier --write` to staged files. Commits therefore reformat staged code automatically.

`docs/` is excluded from **both** ESLint and Prettier — never reformat the specification.

## Project state

The plugin's data side is in place: it opens and closes logbook entries from live Signal K data and records their track, distance, engine/sail segments, instrument snapshots and automatic events (alarms, autopilot, weather thresholds), names departures and arrivals (known places, then online geocoding), and serves it all through the REST API. The consultation webapp exists (below). Not yet built: the tablet entry PWA, the scheduled USB export, and the PDF export. The documents to read before implementing anything:

- [docs/SPEC.md](docs/SPEC.md) — functional spec. §7 is a table of settled decisions that supersedes any assumption drawn from the feature list.
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — schema conventions (SI units, ISO 8601 UTC, naming) and the reasoning behind the non-obvious tables. The authoritative DDL is in `lib/database.js`.
- [docs/API.md](docs/API.md) — the REST API contract, which the implementation and tests follow. Update it with any behaviour change.

## Code layout

`lib/api.js` is the only HTTP-aware module: it parses and validates requests (`lib/validation.js`), calls the resource modules, and maps errors to responses. The resource modules (`entries`, `events`, `places`, `propulsion`, `manoeuvre-types`, `track`, `export`) take a `db` and plain values, run SQL, return `camelCase` objects, and throw `ApiError` (`lib/errors.js`) for not-found and conflict cases. Unit conversion to nautical units happens only in `lib/formats.js`, for human-facing exports.

`lib/detection.js` is the passage state machine; SPEC §4.2 describes its behaviour. `index.js` runs its `tick()` every 15 seconds and reports the outcome as the plugin status. Within that tick and transaction, `lib/propulsion-detector.js` reconciles engine/sail segments and `lib/observation-recorder.js` takes instrument snapshots after the passage is updated, so segment boundaries reuse the departure, stop and resume times detection worked out — keep them in the same tick rather than giving propulsion its own timer. `test/boat.js` is the simulator both are tested with.

`lib/event-watcher.js` checks notifications, autopilot and weather every second, on its own timer — alarms can be brief — with its own freshness tracker. It keeps what it has already logged in memory but seeds that from the `events` table on first sight, which is what stops restarts from repeating or losing alarms; preserve that when changing it. `lib/track-recorder.js` samples position every second (SPEC §4.1) and only ever **writes** to the active entry once detection has it moving, holding points in memory until then; the two share nothing but the database, and detection's 20-minute dating window (`MAX_REFINEMENT_AGE_MS`) bounds how long the recorder holds points. The detector reads Signal K through `getSelfPath` and takes an injectable clock, so `test/detection.test.js` drives it tick by tick through simulated passages rather than real time. It keeps nothing about entries in memory — it rereads the active entry every tick — so API edits (close, merge) are seen immediately. What it does keep in memory (speed samples, freshness, the previous motion) is lost on restart by design; anything needed across a restart is persisted on the entry.

`lib/place-names.js` holds the only network access. Detection names places synchronously (known place, or coordinates marked pending); `index.js` runs the online lookups as a chain of `setTimeout`s, each `resolveNext()` saying when the next is due. Tests inject `fetch` and never reach the network — `test/helpers.js` also starts the plugin with `geocodingEnabled: false`; keep it that way.

`index.js` owns the plugin lifecycle and hands the API a `getContext()` that throws `503` when the database is closed. This matters because the server calls `registerWithRouter` once — before `start()`, even while the plugin is disabled — and never removes the routes.

`node:sqlite` has no transaction helper; use `withTransaction` from `lib/database.js` for any multi-statement write, and don't nest it.

When a design decision is made or changed in conversation, update `docs/SPEC.md` to match; the spec is meant to stay the single source of truth rather than drift behind the code.

## Signal K plugin contract

`index.js` exports `function (app)` returning a plugin object with `id`, `name`, `description`, `schema` (JSON Schema describing user-facing config rendered by the Signal K admin UI), `start(options)` and `stop()`. The `signalk-node-server-plugin` keyword in `package.json` is what makes the Signal K server discover the plugin — do not remove it.

## Planned architecture (per docs/SPEC.md)

Decisions already settled that shape implementation work:

- **Storage**: one SQLite database in the plugin's data folder, holding log entries, events, GPS track points, places, and annotations. GPX is generated on demand from track points, never stored as a file. Accessed via Node's built-in `node:sqlite` (hence `engines.node >= 22.13`) — deliberately not a native module, since those are painful to install on Raspberry Pi.
- **Two UI surfaces**: a standard Signal K webapp (consultation, configuration, export) and a separate installable PWA for tablet/stylus field entry.
- **`signalk-autostate` is an optional dependency**: when present, stopped/underway state comes from `navigation.state`; when absent, an internal SOG-threshold fallback takes over and the UI must signal degraded mode. Both paths need to work. autostate lags real movement by several minutes, which is why transitions are dated from raw speed whichever mode decided.
- **One vessel per Signal K instance** — no multi-vessel or multi-profile concepts in the data model.
- **Handwritten annotations are stored as vector strokes** (timestamped points with pressure), not raster. The feature ships in V2, but the data model reserves the format now so no migration is needed later.
- **Log entry granularity**: a start → underway → stop cycle, with a configurable stop-duration threshold tolerating short stops (lock waits, lunch anchorages) within a single entry.

## Database migrations

`lib/database.js` holds a `MIGRATIONS` array applied in order, with the array index tracked in SQLite's `user_version`. Migrations are **append-only**: once an entry has been released, editing or reordering it would leave existing boat installations on a schema that no longer matches the code. Add a new entry instead.

## Webapp

`public/` is the consultation webapp; the `signalk-webapp` keyword makes Signal K serve it at `/signalk-chiplog/`. It has **no build step**: native ES modules (`.mjs`, served as JavaScript) and Preact + htm from a single vendored file, `public/vendor/preact-htm.mjs`. Consequences to keep in mind:

- No bare imports (`import 'preact'`) and no import maps — only relative paths. Third-party browser code comes from `scripts/vendor.js`, which copies it out of `node_modules`; `public/vendor/` is git-ignored but published through the `files` field in `package.json`. Never load anything from a CDN: the boat is usually offline.
- Pure logic lives in modules that import nothing from `vendor/` (`format.mjs`, `days.mjs`, `i18n.mjs`), so `test/webapp-*.test.mjs` can import them under Node. Components are verified in a real browser against a real Signal K server, not with a DOM test framework.
- Every user-facing string goes in **both** dictionaries of `public/js/i18n.mjs`; a test fails on a missing key or a mismatched `{placeholder}`.
- User text is only ever rendered through htm, which escapes it. Leaflet renders string tooltips as HTML, so pass it DOM nodes for anything the crew typed (see `TrackMap.mjs`).
- Prettier leaves `html` templates alone in `public/` (`embeddedLanguageFormatting: off`): htm drops whitespace that contains a newline, so reflowing a template changes what is displayed. Build text such as `start – end` as one string.
- The API returns SI units; conversion for display happens only in `format.mjs`.

## Code style

Prettier: single quotes, semicolons, `printWidth` 100, no trailing commas. ESLint uses flat config (`eslint.config.js`) with `js.configs.recommended`, CommonJS source type, Node globals, and `eslint-config-prettier` last so formatting rules never conflict. `no-unused-vars` is a warning and ignores function arguments — unused `options`/`app` parameters in Signal K callbacks are expected.
