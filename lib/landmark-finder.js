const { cellBounds, nextPendingArea, saveArea } = require('./landmarks');

// Fills the gazetteer of amers (SPEC §4.13) from OpenStreetMap, one area at a
// time, on the same pattern as place names and the forecasts: `resolveNext()`
// does at most one request and says when the next is due. Offline is the
// normal state at sea, so a failure is retried patiently; an area already
// fetched is never asked for again.

const LANDMARK_DEFAULTS = {
  landmarksEnabled: true,
  overpassUrl: 'https://overpass-api.de/api/interpreter'
};

const METRES_PER_NM = 1852;

// Overpass is a shared, often busy service: ask it for one area at a time and
// leave room between requests.
const QUERY_TIMEOUT_S = 60;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const NEXT_FETCH_MS = 10 * 1000;
const IDLE_MS = 5 * 60 * 1000;
const FIRST_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;

// What counts as an amer, in OpenStreetMap's tags. Deliberately narrow: the
// lateral and cardinal marks of a channel are named "6 c" or "L1" on the
// chart, which says nothing in a logbook, so only the features a position is
// traditionally read against are kept.
const SEAMARK_TYPES = [
  'light_major',
  'light_minor',
  'light_vessel',
  'landmark',
  'harbour',
  'beacon_isolated_danger',
  'beacon_safe_water'
];

function kindOf(tags) {
  const seamark = tags['seamark:type'];
  if (tags.man_made === 'lighthouse' || seamark === 'light_major' || seamark === 'light_vessel') {
    return 'lighthouse';
  }
  if (seamark === 'light_minor') {
    return 'light';
  }
  if (tags.natural === 'cape') {
    return 'cape';
  }
  if (seamark === 'landmark') {
    return 'landmark';
  }
  if (seamark === 'beacon_isolated_danger' || seamark === 'beacon_safe_water') {
    return 'beacon';
  }
  if (seamark === 'harbour' || tags.leisure === 'marina') {
    return 'harbour';
  }
  return null;
}

// A sectored light carries one range per sector ("seamark:light:2:range"); the
// greatest is how far the light is seen at all.
function lightRangeOf(tags) {
  const ranges = Object.entries(tags)
    .filter(([key]) => /^seamark:light(:\d+)?:range$/.test(key))
    .map(([, value]) => Number.parseFloat(value))
    .filter((range) => Number.isFinite(range) && range > 0);
  return ranges.length === 0 ? null : Math.max(...ranges) * METRES_PER_NM;
}

// The name the crew would use: OpenStreetMap's own ("Phare du Cap-Ferret")
// rather than the chart's abbreviation in `seamark:name` ("Cap Ferret").
// A feature with neither is not an amer anyone can be told about.
function landmarkFrom(element) {
  const tags = element.tags ?? {};
  const name = (tags.name ?? tags['seamark:name'] ?? '').trim();
  const kind = kindOf(tags);
  // Ways and relations -- a lighthouse drawn as a building, a harbour as an
  // area -- are asked for with their centre.
  const position = element.type === 'node' ? element : element.center;
  if (name === '' || !kind || !position) {
    return null;
  }
  return {
    osmType: element.type,
    osmId: element.id,
    name,
    kind,
    lat: position.lat,
    lon: position.lon,
    lightRange: lightRangeOf(tags)
  };
}

function parseElements(elements = []) {
  return elements.map(landmarkFrom).filter(Boolean);
}

function overpassQuery({ south, west, north, east }) {
  const box = `(${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)})`;
  return [
    `[out:json][timeout:${QUERY_TIMEOUT_S}];`,
    '(',
    `  nwr["man_made"="lighthouse"]${box};`,
    `  nwr["seamark:type"~"^(${SEAMARK_TYPES.join('|')})$"]${box};`,
    `  nwr["natural"="cape"]${box};`,
    `  nwr["leisure"="marina"]${box};`,
    ');',
    'out tags center;'
  ].join('\n');
}

function createLandmarkFinder({ db, settings, userAgent, fetch = globalThis.fetch }) {
  const stopping = new AbortController();
  let failures = 0;

  // Overpass reports a busy dispatcher or a query timeout in the body, with
  // HTTP 200 -- as an HTML page, or as a "remark" beside empty elements. Both
  // mean "ask again later", not "there is nothing there".
  async function lookup(cell) {
    const response = await fetch(settings.overpassUrl, {
      method: 'POST',
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ data: overpassQuery(cellBounds(cell)) }).toString(),
      signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    });
    if (response.status === 429 || response.status === 504 || response.status >= 500) {
      throw new Error(`Overpass answered HTTP ${response.status}`);
    }
    if (!response.ok) {
      return null;
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('Overpass answered something other than JSON');
    }
    if (typeof result?.remark === 'string' && /error|timeout/i.test(result.remark)) {
      throw new Error(`Overpass reported: ${result.remark}`);
    }
    return Array.isArray(result?.elements) ? result.elements : [];
  }

  return {
    async resolveNext() {
      if (!settings.landmarksEnabled) {
        return { outcome: 'disabled', retryInMs: IDLE_MS };
      }
      const pending = nextPendingArea(db);
      if (!pending) {
        failures = 0;
        return { outcome: 'idle', retryInMs: IDLE_MS };
      }

      let elements;
      try {
        elements = await lookup(pending.cell);
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

      // A refusal Overpass will not answer differently (a rejected query) is
      // final for this area: record it as covered rather than blocking every
      // other one behind it.
      const landmarks = elements === null ? [] : parseElements(elements);
      saveArea(db, pending.cell, landmarks, new Date().toISOString());
      return {
        outcome: elements === null ? 'refused' : 'fetched',
        count: landmarks.length,
        areasLeft: pending.remaining - 1,
        // Whatever is left to cover waits for the next slot: Overpass is not a
        // service to run through as fast as it will answer.
        retryInMs: NEXT_FETCH_MS
      };
    },

    stop() {
      stopping.abort();
    }
  };
}

module.exports = {
  createLandmarkFinder,
  kindOf,
  landmarkFrom,
  lightRangeOf,
  overpassQuery,
  parseElements,
  LANDMARK_DEFAULTS
};
