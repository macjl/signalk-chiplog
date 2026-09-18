// One passage, indexed by time rather than by point.
//
// Track points are not evenly spaced (lib/track-recorder.js samples every
// `trackIntervalSeconds`, but only once the boat has moved 10 m, plus extra
// points on a course change), so stepping through them one per frame would run
// at a wildly uneven apparent speed. The animation therefore asks for a
// position at an arbitrary instant and gets an interpolated one.
//
// No vendor imports, no DOM: plain Node can test this.

import { unwrapLongitude } from './mercator.mjs';

// The same value and the same formula as `distanceBetween` in lib/places.js, so
// the distance the animation counts up converges on the entry's own.
export const EARTH_RADIUS_M = 6371008.8;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

export function haversineMetres(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The short way round the circle: 350° to 10° passes through 0°, not through
// 180°. Right for a signed apparent wind angle too.
export function interpolateAngle(from, to, fraction) {
  return from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * fraction;
}

function interpolate(from, to, fraction) {
  return from + (to - from) * fraction;
}

// A Float64Array cannot hold null, so a reading that was not current when the
// point was sampled is stored as NaN and handed back as null — which is what
// `format.speed` and its neighbours expect.
function blend(from, to, fraction, angular) {
  if (Number.isNaN(from)) {
    return Number.isNaN(to) ? null : to;
  }
  if (Number.isNaN(to)) {
    return from;
  }
  return angular ? interpolateAngle(from, to, fraction) : interpolate(from, to, fraction);
}

const READINGS = ['sog', 'cog', 'stw', 'tws', 'twd', 'awa', 'heading'];
const ANGULAR = new Set(['cog', 'twd', 'awa', 'heading']);

const EMPTY = {
  count: 0,
  startMs: 0,
  endMs: 0,
  durationMs: 0,
  totalDistance: 0,
  signature: 'empty',
  indexAt: () => 0,
  sample: () => null
};

export function createTimeline(points) {
  const usable = [];
  let previousMs = -Infinity;
  let previousLon = null;
  for (const point of points ?? []) {
    const ms = point.time ? Date.parse(point.time) : NaN;
    if (!Number.isFinite(ms) || ms < previousMs) {
      continue;
    }
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      continue;
    }
    const lon = previousLon === null ? point.lon : unwrapLongitude(previousLon, point.lon);
    usable.push({ ...point, ms, lon });
    previousMs = ms;
    previousLon = lon;
  }

  const count = usable.length;
  if (count === 0) {
    return EMPTY;
  }

  const timeMs = new Float64Array(count);
  const lat = new Float64Array(count);
  const lon = new Float64Array(count);
  const distance = new Float64Array(count);
  const readings = Object.fromEntries(READINGS.map((name) => [name, new Float64Array(count)]));

  for (let i = 0; i < count; i += 1) {
    const point = usable[i];
    timeMs[i] = point.ms;
    lat[i] = point.lat;
    lon[i] = point.lon;
    distance[i] = i === 0 ? 0 : distance[i - 1] + haversineMetres(usable[i - 1], point);
    for (const name of READINGS) {
      const value = point[name];
      readings[name][i] = value === null || value === undefined ? NaN : value;
    }
  }

  const startMs = timeMs[0];
  const endMs = timeMs[count - 1];
  const last = Math.max(0, count - 2);

  // A cursor, because playback walks forward a step at a time; a binary search
  // behind it, because the slider jumps. The cursor is only a shortcut: the
  // answer is a pure function of `ms` either way.
  let cursor = 0;
  function indexAt(ms) {
    if (ms <= startMs) {
      cursor = 0;
      return 0;
    }
    if (ms >= endMs) {
      cursor = last;
      return last;
    }
    if (ms >= timeMs[cursor] && ms < timeMs[cursor + 1]) {
      return cursor;
    }
    if (ms > timeMs[cursor]) {
      // One frame at x1 covers 120 s of sailing, about eight points at the
      // default spacing — beyond that the search below is cheaper.
      const reach = Math.min(last, cursor + 8);
      for (let i = cursor + 1; i <= reach; i += 1) {
        if (ms >= timeMs[i] && ms < timeMs[i + 1]) {
          cursor = i;
          return i;
        }
      }
    }
    let low = 0;
    let high = last;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (timeMs[mid] <= ms) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    cursor = low;
    return low;
  }

  function sample(ms) {
    const at = Math.max(startMs, Math.min(endMs, ms));
    const i = indexAt(at);
    const j = Math.min(i + 1, count - 1);
    const span = timeMs[j] - timeMs[i];
    const fraction = span > 0 ? (at - timeMs[i]) / span : 0;
    const result = {
      timeMs: at,
      lat: interpolate(lat[i], lat[j], fraction),
      lon: interpolate(lon[i], lon[j], fraction),
      distance: interpolate(distance[i], distance[j], fraction)
    };
    for (const name of READINGS) {
      const series = readings[name];
      result[name] = blend(series[i], series[j], fraction, ANGULAR.has(name));
    }
    return result;
  }

  return {
    count,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    totalDistance: distance[count - 1],
    first: { lat: lat[0], lon: lon[0] },
    last: { lat: lat[count - 1], lon: lon[count - 1] },
    latitudes: lat,
    longitudes: lon,
    // What a rebuild can be skipped on: a passage still under way is reloaded
    // every minute, and rebuilding would reset the playback under the reader.
    signature: `${count}:${startMs}:${endMs}`,
    indexAt,
    sample
  };
}
