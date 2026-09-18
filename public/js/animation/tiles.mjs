// Map tiles for the animation, fetched and cached by hand.
//
// The animation draws onto a canvas, so tiles cannot simply be <img> elements
// in the DOM. Going through `fetch` then `createImageBitmap(blob)` also gives a
// bitmap with no origin at all, which no canvas can be tainted by — stronger
// than relying on the tile servers' CORS headers, and what makes the export
// possible.
//
// `fetchImpl` and `decode` are injectable, so plain Node can test this without
// a network or a browser.

export const TILE_LAYERS = [
  { id: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 },
  { id: 'seamarks', url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', maxZoom: 18 }
];

// Signal K serves its pages with `Referrer-Policy: no-referrer`, and the
// OpenStreetMap tile servers answer a request without a Referer with an
// "Access blocked" tile. Send the origin only, as browsers do by default — the
// same fix, and the same reason, as in components/TrackMap.mjs.
export const TILE_REFERRER_POLICY = 'strict-origin-when-cross-origin';

// An ImageBitmap holds memory the garbage collector is in no hurry to reclaim,
// so the cache is bounded and evicts by closing.
export const CACHE_LIMIT = 800;

// The OpenStreetMap tile usage policy asks for restraint; four at a time across
// two hosts is well inside what a reader panning the Leaflet map already does.
export const MAX_CONCURRENT = 4;

// Statuses that mean the layer genuinely has no tile there — a missing seamark
// tile is perfectly normal — and which are therefore remembered for good.
// Everything else (429 when the server is busy, any 5xx) is temporary: treating
// those as final would leave permanent holes in the map that no amount of
// scrubbing back would fill.
const NO_SUCH_TILE = new Set([400, 401, 403, 404, 410]);

// How long a tile is left alone after the network dropped it, and after the
// server asked us to slow down.
const NETWORK_RETRY_MS = 30_000;
const BUSY_RETRY_MS = 3000;
const OFFLINE_AFTER_FAILURES = 5;

export function tileUrl(template, { z, x, y }) {
  const count = 2 ** z;
  const wrapped = ((x % count) + count) % count;
  return template.replace('{z}', z).replace('{x}', wrapped).replace('{y}', y);
}

export function tileKey(layerId, { z, x, y }) {
  return `${layerId}/${z}/${x}/${y}`;
}

export function createTileCache(options = {}) {
  const {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    decode = (blob) => globalThis.createImageBitmap(blob),
    limit = CACHE_LIMIT,
    maxConcurrent = MAX_CONCURRENT,
    now = () => Date.now()
  } = options;

  // Insertion order is eviction order, and re-reading a tile moves it to the
  // back: a plain Map is already an LRU.
  const bitmaps = new Map();
  const failures = new Map();
  const inFlight = new Map();
  const queue = [];
  let active = 0;
  let consecutiveNetworkFailures = 0;

  const cache = {
    stats: { requested: 0, loaded: 0, failed: 0, evicted: 0 },
    offline: false
  };

  function remember(key, bitmap) {
    bitmaps.set(key, bitmap);
    while (bitmaps.size > limit) {
      const [oldest, evicted] = bitmaps.entries().next().value;
      bitmaps.delete(oldest);
      evicted?.close?.();
      cache.stats.evicted += 1;
    }
  }

  function pump() {
    while (active < maxConcurrent && queue.length > 0) {
      queue.shift()();
    }
  }

  function schedule(run) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        active += 1;
        run()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
  }

  async function download(layer, tile, key, signal) {
    try {
      const response = await fetchImpl(tileUrl(layer.url, tile), {
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: TILE_REFERRER_POLICY,
        signal
      });
      if (!response.ok) {
        failures.set(key, NO_SUCH_TILE.has(response.status) ? Infinity : now() + BUSY_RETRY_MS);
        cache.stats.failed += 1;
        consecutiveNetworkFailures = 0;
        cache.offline = false;
        return;
      }
      remember(key, await decode(await response.blob()));
      cache.stats.loaded += 1;
      consecutiveNetworkFailures = 0;
      cache.offline = false;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }
      failures.set(key, now() + NETWORK_RETRY_MS);
      cache.stats.failed += 1;
      consecutiveNetworkFailures += 1;
      if (consecutiveNetworkFailures >= OFFLINE_AFTER_FAILURES) {
        cache.offline = true;
      }
    } finally {
      inFlight.delete(key);
    }
  }

  function fetchTile(layer, tile, signal) {
    const key = tileKey(layer.id, tile);
    if (bitmaps.has(key)) {
      // Touch it, so the ones in view are the last to go.
      const bitmap = bitmaps.get(key);
      bitmaps.delete(key);
      bitmaps.set(key, bitmap);
      return null;
    }
    const failedUntil = failures.get(key);
    if (failedUntil !== undefined && failedUntil > now()) {
      return null;
    }
    failures.delete(key);
    if (inFlight.has(key)) {
      return inFlight.get(key);
    }
    cache.stats.requested += 1;
    const promise = schedule(() => download(layer, tile, key, signal));
    inFlight.set(key, promise);
    return promise;
  }

  // How many tiles are still on their way: the preview repaints while this is
  // above zero, so a map fills in rather than staying half drawn.
  Object.defineProperty(cache, 'pending', { get: () => active + queue.length });

  // What is already there, for drawing. Never waits: a frame paints the sea
  // where a tile has not arrived, exactly as a slippy map does.
  cache.peek = (layerId, tile) => {
    const key = tileKey(layerId, tile);
    const bitmap = bitmaps.get(key);
    if (bitmap === undefined) {
      return null;
    }
    bitmaps.delete(key);
    bitmaps.set(key, bitmap);
    return bitmap;
  };

  // Start fetching, without waiting — what the on-screen preview uses.
  cache.request = (layer, tiles, signal) => {
    for (const tile of tiles) {
      fetchTile(layer, tile, signal);
    }
  };

  // Wait for them all — what both the export and a scrubbed preview frame use,
  // so the picture is complete before it is drawn and the film comes out the
  // same however slow the connection was.
  cache.load = async (layer, tiles, onProgress, signal) => {
    let done = 0;
    const total = tiles.length;
    const report = () => onProgress?.({ done, total });
    report();
    const results = await Promise.allSettled(
      tiles.map(async (tile) => {
        await fetchTile(layer, tile, signal);
        done += 1;
        report();
      })
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
  };

  cache.clear = () => {
    for (const bitmap of bitmaps.values()) {
      bitmap?.close?.();
    }
    bitmaps.clear();
    failures.clear();
  };

  return cache;
}
