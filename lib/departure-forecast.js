const { withTransaction } = require('./database');

// What the tide and weather forecasters share: fetch, once per passage, a
// forecast near the departure position for the 24 h from departure, and keep
// it in a table of its own -- one row per entry, `points` as JSON
// [{ time, ... }] (SPEC §4.5.2, §4.5.3).

const IDLE_MS = 60 * 1000;
// Offline is the normal state at sea; retry patiently rather than hammering.
const FIRST_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
// A fetch this long after departure would no longer be "near departure" --
// the forecast window has mostly gone by, so give up rather than keep trying.
const MAX_FETCH_AGE_MS = 3 * 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

function iso(ms) {
  return new Date(ms).toISOString();
}

// The entry most recently departed that has no forecast yet -- fetched or
// found to have none, either way recorded as a row, so this never re-selects
// it. Bounded to recent departures: a fetch long after departure would mean
// requesting a window mostly in the past, which the forecast API does not
// have, and repeatedly retrying an entry the boat was offline for the whole
// relevant window of would never succeed anyway.
function nextPending(db, table, now) {
  return db
    .prepare(
      `SELECT id, start_time, start_lat AS lat, start_lon AS lon FROM log_entries
       WHERE start_lat IS NOT NULL AND start_lon IS NOT NULL
         AND start_time >= ?
         AND id NOT IN (SELECT entry_id FROM ${table})
       ORDER BY id DESC LIMIT 1`
    )
    .get(iso(now - MAX_FETCH_AGE_MS));
}

function save(db, table, entryId, position, now, points) {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO ${table} (entry_id, lat, lon, fetched_at, points)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO NOTHING`
    ).run(entryId, position.lat, position.lon, iso(now), JSON.stringify(points));
  });
}

// Open-Meteo answers hourly times as "2026-09-17T08:00", in UTC as asked.
function utcTime(time) {
  return `${time}:00.000Z`;
}

// A GET to an Open-Meteo-style service. Rate limiting or server trouble is
// worth retrying later (throws); any other refusal -- an unrecognised
// parameter, say -- is a final answer of "nothing usable" (null).
async function getJson(fetch, url, { userAgent, signal, label }) {
  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  });
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`${label} answered HTTP ${response.status}`);
  }
  if (!response.ok) {
    return null;
  }
  return response.json();
}

// `fetchPoints(position, signal)` returns every point the service has (the
// window is cut here), throws to be retried, or returns [] for no data.
function createDepartureForecaster({ db, table, isEnabled, fetchPoints }) {
  const stopping = new AbortController();
  // Consecutive failures for `failingEntryId`: the retry delay grows with
  // them, and starts afresh for another passage -- a new one should not
  // inherit the long delay an earlier, abandoned one had reached.
  let failures = 0;
  let failingEntryId = null;

  return {
    async resolveNext() {
      if (!isEnabled()) {
        return { outcome: 'disabled', retryInMs: IDLE_MS };
      }
      const now = Date.now();
      const pending = nextPending(db, table, now);
      if (!pending) {
        failures = 0;
        return { outcome: 'idle', retryInMs: IDLE_MS };
      }
      if (pending.id !== failingEntryId) {
        failures = 0;
        failingEntryId = pending.id;
      }

      const departure = Date.parse(pending.start_time);
      const position = { lat: pending.lat, lon: pending.lon };

      let all;
      try {
        all = await fetchPoints(position, stopping.signal);
      } catch (error) {
        if (stopping.signal.aborted) {
          return { outcome: 'stopped' };
        }
        failures += 1;
        return {
          outcome: 'failed',
          error,
          retryInMs: Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
        };
      }
      if (stopping.signal.aborted) {
        return { outcome: 'stopped' };
      }
      failures = 0;

      const points = all.filter((point) => {
        const time = Date.parse(point.time);
        return time >= departure && time < departure + WINDOW_MS;
      });
      save(db, table, pending.id, position, now, points);
      return { outcome: points.length > 0 ? 'fetched' : 'no_data', retryInMs: 0 };
    },

    stop() {
      stopping.abort();
    }
  };
}

function readForecast(db, table, entryId) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE entry_id = ?`).get(entryId);
  if (!row) {
    return null;
  }
  const points = JSON.parse(row.points);
  if (points.length === 0) {
    return null;
  }
  return {
    position: { lat: row.lat, lon: row.lon },
    fetchedAt: row.fetched_at,
    points
  };
}

module.exports = { createDepartureForecaster, readForecast, getJson, utcTime };
