// Several passages strung into one animation.
//
// The animation covers a date range, so it is a sequence of legs — one per
// passage — separated by the time the boat spent in port. That time is *not*
// played: three days at a pontoon would be three days of a motionless boat.
// Instead each leg is followed by a short rest on its arrival and an eased
// camera move into the next leg's own framing (SPEC §4.12).
//
// Everything is measured in units, where one unit is one second of video at
// x1 — an hour of sailing. The speed multiplier is applied when playing, not
// here, so changing it mid-playback moves nothing.
//
// No vendor imports, no DOM: plain Node can test this.

import { passageZoom, trackBounds } from './camera.mjs';
import { unwrapLongitude, worldX, worldY } from './mercator.mjs';
import { createTimeline } from './timeline.mjs';

const MS_PER_HOUR = 3_600_000;

// How long the boat rests on its arrival before the camera moves on.
export const HOLD_UNITS = 1.2;

// Longer when the crew stopped for the night: the pause should read as one.
export const OVERNIGHT_HOLD_UNITS = 2.5;
export const OVERNIGHT_GAP_MS = 8 * MS_PER_HOUR;

// The camera move from one leg's framing to the next.
export const TRANSITION_UNITS = 0.8;

function holdUnitsFor(gapMs) {
  return gapMs >= OVERNIGHT_GAP_MS ? OVERNIGHT_HOLD_UNITS : HOLD_UNITS;
}

// Slow at both ends, so the camera does not jerk into or out of its move.
function smoothstep(fraction) {
  return fraction * fraction * (3 - 2 * fraction);
}

// `passages` is `[{ entry, points }]` in any order, `points` being what
// `trackPoints()` returns. A passage with nothing to animate — no track, a
// single point, no elapsed time — is left out rather than flashed past.
export function buildLegs(passages, { width, height }) {
  const legs = [];
  let distanceOffset = 0;
  const usable = (passages ?? [])
    .map(({ entry, points }) => ({ entry, timeline: createTimeline(points) }))
    .filter(({ timeline }) => timeline.count > 1 && timeline.durationMs > 0)
    .sort((a, b) => a.timeline.startMs - b.timeline.startMs);

  for (const { entry, timeline } of usable) {
    const positions = [];
    // Projected once, here, rather than for every point of every frame: a
    // world fraction is the same at any zoom.
    const worldXs = new Float64Array(timeline.count);
    const worldYs = new Float64Array(timeline.count);
    for (let i = 0; i < timeline.count; i += 1) {
      const lat = timeline.latitudes[i];
      const lon = timeline.longitudes[i];
      positions.push({ lat, lon });
      worldXs[i] = worldX(lon);
      worldYs[i] = worldY(lat);
    }
    const bounds = trackBounds(positions);
    legs.push({
      entry,
      timeline,
      bounds,
      worldXs,
      worldYs,
      // Its own zoom, so a long crossing is framed whole and a short hop stays
      // at a readable scale.
      frame: {
        zoom: passageZoom(bounds, { width, height }),
        centre: { lat: bounds.centreLat, lon: bounds.centreLon }
      },
      distanceOffset
    });
    distanceOffset += timeline.totalDistance;
  }
  return legs;
}

export function buildStoryboard(legs) {
  const segments = [];
  let units = 0;
  const push = (segment) => {
    const length = segment.units;
    segments.push({ ...segment, startUnits: units, endUnits: units + length });
    units += length;
  };

  legs.forEach((leg, index) => {
    push({ kind: 'leg', legIndex: index, units: leg.timeline.durationMs / MS_PER_HOUR });
    const next = legs[index + 1];
    if (next) {
      const gap = next.timeline.startMs - leg.timeline.endMs;
      push({ kind: 'hold', legIndex: index, units: holdUnitsFor(gap) });
      push({ kind: 'transition', legIndex: index, nextIndex: index + 1, units: TRANSITION_UNITS });
    } else {
      push({ kind: 'hold', legIndex: index, units: HOLD_UNITS });
    }
  });

  return { legs, segments, totalUnits: units, totalDistance: distanceOf(legs) };
}

function distanceOf(legs) {
  const last = legs[legs.length - 1];
  return last ? last.distanceOffset + last.timeline.totalDistance : 0;
}

function segmentAt(segments, units) {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (segments[mid].startUnits <= units) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return segments[low];
}

// Where the boat is, what the camera is looking at, and how far the animation
// has come, at a given instant of the film.
export function stateAt(storyboard, units) {
  const { legs, segments, totalUnits } = storyboard;
  if (segments.length === 0) {
    return null;
  }
  const at = Math.max(0, Math.min(totalUnits, units));
  const segment = segmentAt(segments, at);
  const span = segment.endUnits - segment.startUnits;
  const fraction = span > 0 ? (at - segment.startUnits) / span : 0;
  const leg = legs[segment.legIndex];

  if (segment.kind === 'leg') {
    const point = leg.timeline.sample(leg.timeline.startMs + fraction * leg.timeline.durationMs);
    return {
      ...point,
      phase: 'leg',
      legIndex: segment.legIndex,
      legFraction: fraction,
      boatVisible: true,
      // After the spread: the point carries the distance covered within its own
      // leg, and what the bubble shows is the distance since the film began.
      distance: leg.distanceOffset + point.distance,
      camera: { centre: { lat: point.lat, lon: point.lon }, zoom: leg.frame.zoom }
    };
  }

  // Both a rest and a camera move happen after the leg has been sailed, so the
  // clock and the trip meter stand still: no sailing is going on.
  const arrival = leg.timeline.sample(leg.timeline.endMs);
  const resting = {
    ...arrival,
    legIndex: segment.legIndex,
    legFraction: 1,
    distance: leg.distanceOffset + leg.timeline.totalDistance
  };

  if (segment.kind === 'hold') {
    return {
      ...resting,
      phase: 'hold',
      boatVisible: true,
      camera: { centre: { lat: arrival.lat, lon: arrival.lon }, zoom: leg.frame.zoom }
    };
  }

  const next = legs[segment.nextIndex];
  const departure = next.timeline.sample(next.timeline.startMs);
  const eased = smoothstep(fraction);
  // The two legs were unwrapped from their own first point, so they can sit a
  // whole turn apart; keep the move on the short side of the seam.
  const targetLon = unwrapLongitude(arrival.lon, departure.lon);
  return {
    ...resting,
    phase: 'transition',
    // The camera is travelling, not the boat: showing it skating across the
    // chart would be a lie.
    boatVisible: false,
    nextLegIndex: segment.nextIndex,
    camera: {
      centre: {
        lat: arrival.lat + (departure.lat - arrival.lat) * eased,
        lon: arrival.lon + (targetLon - arrival.lon) * eased
      },
      zoom: leg.frame.zoom + (next.frame.zoom - leg.frame.zoom) * eased
    }
  };
}
