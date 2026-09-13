# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language convention

All project artifacts — code, comments, documentation, commit messages — are written in **English**. Conversations with the repository owner are held in **French**.

## Commands

```bash
npm run lint          # eslint .
npm run lint:fix      # eslint . --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check .
```

No test framework is set up yet; `npm test` is a placeholder that exits 0.

A husky `pre-commit` hook runs `lint-staged`, which applies `eslint --fix` and `prettier --write` to staged files. Commits therefore reformat staged code automatically.

`docs/` is excluded from **both** ESLint and Prettier — never reformat the specification.

## Project state

This repository is at the **specification stage**. [docs/SPEC.md](docs/SPEC.md) is the authoritative design document; `index.js` is only a plugin skeleton (no behaviour implemented). Before implementing anything, read the spec — in particular §7, a table of settled decisions that supersedes any assumption drawn from the feature list.

When a design decision is made or changed in conversation, update `docs/SPEC.md` to match; the spec is meant to stay the single source of truth rather than drift behind the code.

## Signal K plugin contract

`index.js` exports `function (app)` returning a plugin object with `id`, `name`, `description`, `schema` (JSON Schema describing user-facing config rendered by the Signal K admin UI), `start(options)` and `stop()`. The `signalk-node-server-plugin` keyword in `package.json` is what makes the Signal K server discover the plugin — do not remove it.

## Planned architecture (per docs/SPEC.md)

Decisions already settled that shape implementation work:

- **Storage**: one SQLite database in the plugin's data folder, holding log entries, events, GPS track points, places, and annotations. GPX is generated on demand from track points, never stored as a file.
- **Two UI surfaces**: a standard Signal K webapp (consultation, configuration, export) and a separate installable PWA for tablet/stylus field entry.
- **`signalk-autostate` is an optional dependency**: when present, stopped/underway state comes from `navigation.state`; when absent, an internal SOG-threshold fallback takes over and the UI must signal degraded mode. Both paths need to work.
- **One vessel per Signal K instance** — no multi-vessel or multi-profile concepts in the data model.
- **Handwritten annotations are stored as vector strokes** (timestamped points with pressure), not raster. The feature ships in V2, but the data model reserves the format now so no migration is needed later.
- **Log entry granularity**: a start → underway → stop cycle, with a configurable stop-duration threshold tolerating short stops (lock waits, lunch anchorages) within a single entry.

## Code style

Prettier: single quotes, semicolons, `printWidth` 100, no trailing commas. ESLint uses flat config (`eslint.config.js`) with `js.configs.recommended`, CommonJS source type, Node globals, and `eslint-config-prettier` last so formatting rules never conflict. `no-unused-vars` is a warning and ignores function arguments — unused `options`/`app` parameters in Signal K callbacks are expected.
