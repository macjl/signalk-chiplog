const { withTransaction } = require('./database');

const TIDE_DEFAULTS = {
  tidesEnabled: true,
  tideUrl: 'https://marine-api.open-meteo.com/v1/marine'
};

// Open-Meteo's sea_level_height_msl is referenced to mean sea level, not the
// chart datum (lowest astronomical tide) nautical tide tables use -- there is
// no parameter to ask it for another datum. The gap between the two can be
// several metres and is not something to derive from a day of readings, so
// this is recorded rather than left implicit: a height here is relative sea
// level, not a substitute for a charted "hauteur d'eau".
const DATUM = 'msl';

const REQUEST_TIMEOUT_MS = 10 * 1000;
const IDLE_MS = 60 * 1000;
// Offline is the normal state at sea; retry patiently rather than hammering.
const FIRST_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
// A fetch this long after departure would no longer be "near departure" --
// the forecast window has mostly gone by, so give up rather than keep trying.
const MAX_FETCH_AGE_MS = 3 * 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

function iso(ms) {
  return new Date(ms).toISOString();
}

// The entry most recently departed that has no forecast yet -- fetched or
// found to have none, either way recorded as a row, so this never re-selects
// it. Bounded to recent departures: a fetch long after departure would mean
// requesting a window mostly in the past, which the forecast API does not
// have, and repeatedly retrying an entry the boat was offline for the whole
// relevant window of would never succeed anyway.
function nextPending(db, now) {
  return db
    .prepare(
      `SELECT id, start_time, start_lat AS lat, start_lon AS lon FROM log_entries
       WHERE start_lat IS NOT NULL AND start_lon IS NOT NULL
         AND start_time >= ?
         AND id NOT IN (SELECT entry_id FROM tide_forecasts)
       ORDER BY id DESC LIMIT 1`
    )
    .get(iso(now - MAX_FETCH_AGE_MS));
}

function save(db, entryId, position, now, points) {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tide_forecasts (entry_id, lat, lon, fetched_at, points)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO NOTHING`
    ).run(entryId, position.lat, position.lon, iso(now), JSON.stringify(points));
  });
}

function createTideForecaster({ db, settings, userAgent, fetch = globalThis.fetch }) {
  const stopping = new AbortController();
  let failures = 0;

  async function fetchHeights(position) {
    const endpoint = new URL(settings.tideUrl);
    endpoint.searchParams.set('latitude', String(position.lat));
    endpoint.searchParams.set('longitude', String(position.lon));
    endpoint.searchParams.set('hourly', 'sea_level_height_msl');
    endpoint.searchParams.set('timezone', 'UTC');
    endpoint.searchParams.set('past_days', '1');
    endpoint.searchParams.set('forecast_days', '2');

    const response = await fetch(endpoint, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    });
    // Rate limiting or server trouble is worth retrying later; anything else
    // (an unrecognised parameter, say) is a final answer of "nothing usable".
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Tide service answered HTTP ${response.status}`);
    }
    if (!response.ok) {
      return [];
    }
    const result = await response.json();
    const times = result.hourly?.time ?? [];
    const heights = result.hourly?.sea_level_height_msl ?? [];
    return times
      .map((time, index) => ({ time: `${time}:00.000Z`, height: heights[index] }))
      .filter((point) => typeof point.height === 'number' && Number.isFinite(point.height));
  }

  return {
    async resolveNext() {
      if (!settings.tidesEnabled) {
        return { outcome: 'disabled', retryInMs: IDLE_MS };
      }
      const now = Date.now();
      const pending = nextPending(db, now);
      if (!pending) {
        return { outcome: 'idle', retryInMs: IDLE_MS };
      }

      const departure = Date.parse(pending.start_time);
      const position = { lat: pending.lat, lon: pending.lon };

      let all;
      try {
        all = await fetchHeights(position);
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
      save(db, pending.id, position, now, points);
      return { outcome: points.length > 0 ? 'fetched' : 'no_data', retryInMs: 0 };
    },

    stop() {
      stopping.abort();
    }
  };
}

function getTideForecast(db, entryId) {
  const row = db.prepare('SELECT * FROM tide_forecasts WHERE entry_id = ?').get(entryId);
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
    datum: DATUM,
    points
  };
}

module.exports = { createTideForecaster, getTideForecast, TIDE_DEFAULTS };
