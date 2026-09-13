const { withTransaction } = require('./database');
const { findNearestPlace } = require('./places');

const GEOCODING_DEFAULTS = {
  geocodingEnabled: true,
  geocodingUrl: 'https://nominatim.openstreetmap.org'
};

const REQUEST_TIMEOUT_MS = 10 * 1000;
// Nominatim's usage policy allows at most one request per second.
const NEXT_LOOKUP_MS = 2 * 1000;
const IDLE_MS = 60 * 1000;
// Offline is the normal state at sea; retry patiently rather than hammering.
const FIRST_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;

const HARBOUR_TYPES = new Set(['marina', 'harbour', 'port']);
const SETTLEMENT_KEYS = [
  'city',
  'town',
  'village',
  'hamlet',
  'isolated_dwelling',
  'locality',
  'island',
  'municipality'
];
const DISTRICT_KEYS = ['quarter', 'suburb', 'neighbourhood', 'city_district'];

function coordinatesName({ lat, lon }) {
  const latitude = `${Math.abs(lat).toFixed(4)}${lat >= 0 ? 'N' : 'S'}`;
  const longitude = `${Math.abs(lon).toFixed(4)}${lon >= 0 ? 'E' : 'W'}`;
  return `${latitude} ${longitude}`;
}

// Name for a departure or arrival as it happens: a known place, or failing
// that a name from coordinates left pending until geocoding answers.
function initialPlaceName(db, position, radius) {
  if (!position) {
    return { id: null, name: null, pending: 0 };
  }
  const place = findNearestPlace(db, position, radius);
  return place
    ? { id: place.id, name: place.name, pending: 0 }
    : { id: null, name: coordinatesName(position), pending: 1 };
}

// Near a marina Nominatim tends to answer with the quay's road, and at sea with
// a bare administrative boundary: neither is a logbook place name. The
// settlement, with its district when there is one, is.
function pickName(result) {
  if (result.name && HARBOUR_TYPES.has(result.type)) {
    return result.name;
  }
  const address = result.address ?? {};
  const settlement = SETTLEMENT_KEYS.map((key) => address[key]).find(Boolean);
  if (!settlement) {
    return null;
  }
  const district = DISTRICT_KEYS.map((key) => address[key]).find(Boolean);
  return district && district !== settlement ? `${settlement} (${district})` : settlement;
}

function createPlaceNamer({ db, settings, userAgent, fetch = globalThis.fetch }) {
  const stopping = new AbortController();
  let failures = 0;

  function nextPending() {
    return db
      .prepare(
        `SELECT id, 'start' AS side, start_lat AS lat, start_lon AS lon FROM log_entries
         WHERE start_place_pending = 1 AND start_lat IS NOT NULL
         UNION ALL
         SELECT id, 'end' AS side, end_lat AS lat, end_lon AS lon FROM log_entries
         WHERE end_place_pending = 1 AND end_lat IS NOT NULL
         ORDER BY id DESC, side DESC
         LIMIT 1`
      )
      .get();
  }

  // Only a name still pending for the position that was looked up is replaced:
  // a name typed, or a position corrected, while the lookup was out stays.
  function settle({ id, side, lat, lon }, place) {
    const prefix = side === 'start' ? 'start' : 'end';
    const stillAsLookedUp = `id = ? AND ${prefix}_place_pending = 1 AND ${prefix}_lat = ? AND ${prefix}_lon = ?`;
    if (place) {
      db.prepare(
        `UPDATE log_entries
         SET ${prefix}_place_name = ?, ${prefix}_place_id = ?, ${prefix}_place_pending = 0
         WHERE ${stillAsLookedUp}`
      ).run(place.name, place.id, id, lat, lon);
    } else {
      db.prepare(`UPDATE log_entries SET ${prefix}_place_pending = 0 WHERE ${stillAsLookedUp}`).run(
        id,
        lat,
        lon
      );
    }
  }

  // The places table is the geocoding cache: the next departure or arrival
  // within the radius is named from it, with no request.
  function rememberGeocoded(name, { lat, lon }) {
    const now = new Date().toISOString();
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO places (name, lat, lon, source, created_at, updated_at)
         VALUES (?, ?, ?, 'geocoding', ?, ?)`
      )
      .run(name, lat, lon, now, now);
    return { id: Number(lastInsertRowid), name };
  }

  async function lookup({ lat, lon }) {
    const base = settings.geocodingUrl.endsWith('/')
      ? settings.geocodingUrl
      : `${settings.geocodingUrl}/`;
    const url = new URL('reverse', base);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('zoom', '17');
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    });
    // Rate limiting, server trouble or a refused client are worth retrying
    // later; anything else about this position is a final answer.
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new Error(`Geocoding service answered HTTP ${response.status}`);
    }
    if (!response.ok) {
      return null;
    }
    const result = await response.json();
    return result.error ? null : pickName(result);
  }

  return {
    async resolveNext() {
      if (!settings.geocodingEnabled) {
        return { outcome: 'disabled', retryInMs: IDLE_MS };
      }
      const pending = nextPending();
      if (!pending) {
        return { outcome: 'idle', retryInMs: IDLE_MS };
      }

      // A lookup for a nearby departure or arrival may already have named it.
      const known = findNearestPlace(db, pending, settings.placeMatchRadius);
      if (known) {
        settle(pending, known);
        return { outcome: 'known', retryInMs: 0 };
      }

      let name;
      try {
        name = await lookup(pending);
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

      if (!name) {
        settle(pending, null);
        return { outcome: 'no_result', retryInMs: NEXT_LOOKUP_MS };
      }
      withTransaction(db, () => {
        const place =
          findNearestPlace(db, pending, settings.placeMatchRadius) ??
          rememberGeocoded(name, pending);
        settle(pending, place);
      });
      return { outcome: 'resolved', name, retryInMs: NEXT_LOOKUP_MS };
    },

    stop() {
      stopping.abort();
    }
  };
}

module.exports = {
  coordinatesName,
  initialPlaceName,
  pickName,
  createPlaceNamer,
  GEOCODING_DEFAULTS
};
