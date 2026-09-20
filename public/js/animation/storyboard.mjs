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

import { fitZoom, passageZoom, trackBounds, ZOOM_STEP } from './camera.mjs';
import { unwrapLongitude, worldX, worldY } from './mercator.mjs';
import { createTimeline } from './timeline.mjs';

const MS_PER_HOUR = 3_600_000;

// How long the boat rests on its arrival before the camera moves on: a beat, not
// a pause — at x1 an hour of sailing is a second, so a longer rest is a boat
// standing still for no reason.
export const HOLD_UNITS = 0.3;

// A little longer when the crew stopped for the night: the pause should read as one.
export const OVERNIGHT_HOLD_UNITS = 0.5;
export const OVERNIGHT_GAP_MS = 8 * MS_PER_HOUR;

// The camera move from one leg's framing to the next.
export const TRANSITION_UNITS = 0.8;

// Two positions this close are the same place: a boat that leaves where it arrived
// has nowhere to travel to (SPEC §4.6 uses the same mile for "at the same place").
export const SAME_PLACE_METRES = 1852;

// Great-circle distance in metres, haversine — the same formula the timeline uses.
function metresBetween(a, b) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The camera move that opens the film — from the whole of the navigation down to
// the first position — and the one that closes it, back out to the whole again.
export const INTRO_UNITS = 2;
export const OUTRO_UNITS = 2;

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

const DEFAULT_FRAME = { width: 1920, height: 1080 };

// The framing that takes in every leg at once, or null when there is nothing to
// take in. Legs were each unwrapped from their own first point, so the bounds of
// one may sit a whole turn of longitude away from another's: bring them to the
// side of the first before joining them.
export function overviewFrame(legs, frame = DEFAULT_FRAME) {
  if (legs.length === 0) {
    return null;
  }
  const anchor = legs[0].bounds.centreLon;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const { bounds } of legs) {
    const shift = unwrapLongitude(anchor, bounds.centreLon) - bounds.centreLon;
    minLat = Math.min(minLat, bounds.minLat);
    maxLat = Math.max(maxLat, bounds.maxLat);
    minLon = Math.min(minLon, bounds.minLon + shift);
    maxLon = Math.max(maxLon, bounds.maxLon + shift);
  }
  const bounds = {
    minLat,
    maxLat,
    minLon,
    maxLon,
    centreLat: (minLat + maxLat) / 2,
    centreLon: (minLon + maxLon) / 2
  };
  return {
    zoom: fitZoom(bounds, { width: frame.width, height: frame.height }),
    centre: { lat: bounds.centreLat, lon: bounds.centreLon }
  };
}

// `frame` is the frame's size in pixels, which the overview's zoom depends on.
export function buildStoryboard(legs, frame = DEFAULT_FRAME) {
  const segments = [];
  let units = 0;
  const push = (segment) => {
    const length = segment.units;
    segments.push({ ...segment, startUnits: units, endUnits: units + length });
    units += length;
  };

  const overview = overviewFrame(legs, frame);
  // The camera only pulls back when there is something to pull back to: a passage
  // already framed as wide as the whole navigation would be a pause.
  const opens = overview && overview.zoom <= legs[0].frame.zoom - ZOOM_STEP;
  const last = legs[legs.length - 1];
  const closes = overview && overview.zoom <= last.frame.zoom - ZOOM_STEP;

  if (opens) {
    push({ kind: 'intro', legIndex: 0, units: INTRO_UNITS });
  }
  legs.forEach((leg, index) => {
    push({ kind: 'leg', legIndex: index, units: leg.timeline.durationMs / MS_PER_HOUR });
    const next = legs[index + 1];
    if (next) {
      const gap = next.timeline.startMs - leg.timeline.endMs;
      if (metresBetween(leg.timeline.last, next.timeline.first) <= SAME_PLACE_METRES) {
        // Leaving where it arrived: there is nowhere to fly to, so no move — the one
        // beat of rest carries the boat and the camera across to the next leg's
        // own framing, and the boat never leaves the frame.
        push({ kind: 'hold', legIndex: index, nextIndex: index + 1, units: holdUnitsFor(gap) });
      } else {
        push({ kind: 'hold', legIndex: index, units: holdUnitsFor(gap) });
        push({
          kind: 'transition',
          legIndex: index,
          nextIndex: index + 1,
          units: TRANSITION_UNITS
        });
      }
    } else {
      push({ kind: 'hold', legIndex: index, units: HOLD_UNITS });
    }
  });
  if (closes) {
    push({ kind: 'outro', legIndex: legs.length - 1, units: OUTRO_UNITS });
  }

  return { legs, segments, totalUnits: units, totalDistance: distanceOf(legs), overview };
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

// Two headings blended the short way round the circle. Either may be missing, in
// which case the other stands; both missing, there is none.
export function blendAngle(from, to, fraction) {
  const known = (angle) => angle !== null && angle !== undefined && Number.isFinite(angle);
  if (!known(from)) {
    return known(to) ? to : null;
  }
  if (!known(to)) {
    return from;
  }
  const difference = ((((to - from) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return (((from + difference * fraction) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

// A camera flying from one framing to another, `fraction` of the way, eased.
//
// Zoom is what the eye follows, so it is what moves evenly; the centre is then
// carried along so that the place being zoomed towards (or away from) stays put on
// screen as it would under a pinch, rather than sliding across the frame — the
// centre's share of the journey is the share of the distance across the map that
// the change of scale has covered. The longitudes are brought to the same side of
// the world first, so the move takes the short way.
function flyCamera(from, to, fraction) {
  const eased = smoothstep(fraction);
  const zoom = from.zoom + (to.zoom - from.zoom) * eased;
  const towards = to.zoom - from.zoom;
  // Map distance is in world units per scale: 2^-zoom.
  const share =
    Math.abs(towards) < 1e-9
      ? eased
      : (2 ** -from.zoom - 2 ** -zoom) / (2 ** -from.zoom - 2 ** -to.zoom);
  const targetLon = unwrapLongitude(from.centre.lon, to.centre.lon);
  return {
    zoom,
    centre: {
      lat: from.centre.lat + (to.centre.lat - from.centre.lat) * share,
      lon: from.centre.lon + (targetLon - from.centre.lon) * share
    }
  };
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

  if (segment.kind === 'intro') {
    // Nothing has been sailed yet: the whole navigation, and then the way down to
    // where it begins.
    const departure = leg.timeline.sample(leg.timeline.startMs);
    return {
      ...departure,
      phase: 'intro',
      legIndex: 0,
      legFraction: 0,
      // A camera coming down from far above: at that scale the boat would be a
      // dot, and it appears where the sailing begins.
      boatVisible: false,
      distance: 0,
      camera: flyCamera(
        storyboard.overview,
        { centre: { lat: departure.lat, lon: departure.lon }, zoom: leg.frame.zoom },
        fraction
      )
    };
  }

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

  if (segment.kind === 'outro') {
    // Everything has been sailed: back out to the whole of it.
    return {
      ...resting,
      phase: 'outro',
      // The sailing is over and the camera is drawing back from it.
      boatVisible: false,
      camera: flyCamera(
        { centre: { lat: arrival.lat, lon: arrival.lon }, zoom: leg.frame.zoom },
        storyboard.overview,
        fraction
      )
    };
  }

  const next = segment.nextIndex === undefined ? null : legs[segment.nextIndex];

  if (segment.kind === 'hold' && !next) {
    return {
      ...resting,
      phase: 'hold',
      boatVisible: true,
      camera: { centre: { lat: arrival.lat, lon: arrival.lon }, zoom: leg.frame.zoom }
    };
  }

  const departure = next.timeline.sample(next.timeline.startMs);
  const eased = smoothstep(fraction);
  // The two legs were unwrapped from their own first point, so they can sit a
  // whole turn apart; keep the move on the short side of the seam.
  const targetLon = unwrapLongitude(arrival.lon, departure.lon);
  const centre = {
    lat: arrival.lat + (departure.lat - arrival.lat) * eased,
    lon: arrival.lon + (targetLon - arrival.lon) * eased
  };
  const camera = {
    centre,
    zoom: leg.frame.zoom + (next.frame.zoom - leg.frame.zoom) * eased
  };

  if (segment.kind === 'hold') {
    // The boat leaves where it arrived, so it stays: it goes with the camera over
    // the few yards to where the next leg begins, turning to its heading, while
    // the zoom eases to that leg's own. It is not sailing — the clock and the trip
    // meter stand still.
    return {
      ...resting,
      phase: 'hold',
      boatVisible: true,
      carried: true,
      lat: centre.lat,
      lon: centre.lon,
      heading: blendAngle(
        arrival.heading ?? arrival.cog,
        departure.heading ?? departure.cog,
        eased
      ),
      nextLegIndex: segment.nextIndex,
      transitionFraction: fraction,
      camera
    };
  }

  return {
    ...resting,
    phase: 'transition',
    // The boat is somewhere else by the time the camera gets there, and skating
    // it across the chart would be a lie: it goes, and reappears at the next
    // departure.
    boatVisible: false,
    nextLegIndex: segment.nextIndex,
    transitionFraction: fraction,
    camera
  };
}
