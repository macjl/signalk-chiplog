// The boat's heading and wind readings, smoothed for the film.
//
// A track is sampled every few seconds and its headings jitter with the swell and
// the helm. Played at an hour of sailing per second that jitter is a shiver: the
// boat flicks left and right a dozen times a second. What the eye wants is the
// general direction of the passage — but a boat that still turns, at once, when
// the track does: a tack, a headland rounded, a harbour entered. Small changes
// must not show; large ones must.
//
// So the smoothing is not a plain average. Each reading is averaged with the
// others over a stretch of the leg around the instant — but only with those that
// point roughly the same way as the boat does *now* (a short average says where
// that is). Jitter of a few degrees is all alike and is averaged away; the far
// side of a tack is nothing like it and is left out, so the boat is not dragged
// through the wind, or halfway round a headland, by what it has not reached yet.
//
// Both windows are lengths of *film*, not of playback: a fixed number of film
// units is a fixed number of frames whatever the speed. They are read from the
// timeline, never from a previous frame, so an export is the same as the preview.
// No vendor imports, no DOM: plain Node can test this.

import { worldX, worldY } from './mercator.mjs';
import { blendAngle } from './storyboard.mjs';

const MS_PER_HOUR = 3_600_000;

// One unit of film is an hour of sailing. The wide average is a bell curve of this
// width (one standard deviation), so it takes in about an hour of sailing either
// way: some hundred frames at x1.
export const SMOOTHING_UNITS = 0.45;
export const SMOOTHING_SIGMA_MS = SMOOTHING_UNITS * MS_PER_HOUR;

// The short average that says where the boat points now, and so which readings
// belong with it: three minutes of sailing, a frame or two at x1. It is also how
// long a turn takes to show, which is what makes a tack read as one.
export const REFERENCE_UNITS = 0.05;
export const REFERENCE_SIGMA_MS = REFERENCE_UNITS * MS_PER_HOUR;

// How far from the boat's present direction a reading may be and still count: the
// width of a bell curve of weights, in radians. Well under a tack or a turn round
// a headland, well over the wobble of a helm.
export const SAME_WAY = 25 * (Math.PI / 180);

const SETTLING_PASSES = 4;
const SPREAD = 2;

// As often as the default track is sampled.
const SAMPLE_STEP_MS = 15_000;

const DEGREES = Math.PI / 180;

function bearingBetween(from, to) {
  const dx = (worldX(to.lon) - worldX(from.lon)) * Math.cos(((from.lat + to.lat) / 2) * DEGREES);
  const dy = worldY(to.lat) - worldY(from.lat);
  return dx === 0 && dy === 0 ? null : Math.atan2(dx, -dy);
}

function normalise(angle) {
  return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function bell(offset) {
  return Math.exp(-0.5 * offset * offset);
}

// The mean direction of `entries` ({ angle, weight }), on the circle, so a boat
// swinging either side of north does not average to south.
function circularMean(entries) {
  let x = 0;
  let y = 0;
  for (const { angle, weight } of entries) {
    x += Math.sin(angle) * weight;
    y += Math.cos(angle) * weight;
  }
  return x === 0 && y === 0 ? null : Math.atan2(x, y);
}

function angularDifference(a, b) {
  return ((((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

// The wide average of `entries`, counting only what points the way the boat does
// and fading with how far it points from that. The short average only *starts* the
// search: its own jitter would otherwise leak into the answer through the weights,
// so the average is taken again around its own result, and settles on the
// direction most of the leg was actually sailing.
function averageAlong(entries, reference) {
  let centre = reference;
  if (centre === null) {
    return null;
  }
  for (let pass = 0; pass < SETTLING_PASSES; pass += 1) {
    const near = entries.map(({ angle, weight }) => ({
      angle,
      weight: weight * bell(angularDifference(angle, centre) / SAME_WAY)
    }));
    // Everything so far off that its weight vanished: the boat has just turned
    // away from all of it, and the direction it had is the answer.
    centre = circularMean(near) ?? centre;
  }
  return centre;
}

// Every reading of the leg around `timeMs`, as often as the track is sampled, so
// that the average has as many independent readings to draw on as there are: an
// average of a few dozen would still shiver by a few degrees.
function gather(timeline, timeMs, sigmaMs) {
  const half = SPREAD * sigmaMs;
  const count = Math.max(2, Math.round((2 * half) / SAMPLE_STEP_MS));
  const samples = [];
  for (let i = 0; i <= count; i += 1) {
    const offsetMs = -half + (i / count) * 2 * half;
    // Beyond either end of the leg the nearest reading stands in, which keeps the
    // start and the finish from being dragged towards nothing.
    samples.push({ offsetMs, point: timeline.sample(timeMs + offsetMs) });
  }
  return samples;
}

// One angular reading (heading, wind angle) smoothed around the instant.
function smoothedAngle(samples, sigmaMs, read) {
  const wide = [];
  const short = [];
  for (const { offsetMs, point } of samples) {
    const angle = read(point);
    if (!Number.isFinite(angle)) {
      continue;
    }
    wide.push({ angle, weight: bell(offsetMs / sigmaMs) });
    if (Math.abs(offsetMs) <= SPREAD * REFERENCE_SIGMA_MS) {
      short.push({ angle, weight: bell(offsetMs / REFERENCE_SIGMA_MS) });
    }
  }
  return averageAlong(wide, circularMean(short));
}

function smoothedValue(samples, sigmaMs, read) {
  let sum = 0;
  let total = 0;
  for (const { offsetMs, point } of samples) {
    const value = read(point);
    if (Number.isFinite(value)) {
      const weight = bell(offsetMs / sigmaMs);
      sum += value * weight;
      total += weight;
    }
  }
  return total > 0 ? sum / total : null;
}

// Where the boat points, where the wind is and how fast it goes, smoothed as
// described above. A reading the track lacks is left out, and comes back `null`
// if it is lacking throughout.
export function smoothedMotion(timeline, timeMs, options = {}) {
  const { sigmaMs = SMOOTHING_SIGMA_MS } = options;
  const samples = gather(timeline, timeMs, sigmaMs);

  let heading = smoothedAngle(samples, sigmaMs, (point) => point.heading ?? point.cog);
  if (heading === null) {
    // No heading anywhere near: take it from where the boat went.
    heading = bearingBetween(
      timeline.sample(timeMs - REFERENCE_SIGMA_MS),
      timeline.sample(timeMs + REFERENCE_SIGMA_MS)
    );
  }

  return {
    heading: heading === null ? null : normalise(heading),
    awa: smoothedAngle(samples, sigmaMs, (point) => point.awa),
    tws: smoothedValue(samples, sigmaMs, (point) => point.tws),
    sog: smoothedValue(samples, sigmaMs, (point) => point.sog)
  };
}

function smoothstep(fraction) {
  return fraction * fraction * (3 - 2 * fraction);
}

// The smoothed motion for a frame's state. While the boat is carried from the end
// of one leg to the start of the next, where it has no track under it, so it turns from the way it was pointing
// on its arrival to the way it will point on its departure, the wind and speed
// changing over with it.
export function motionForState(state, legs) {
  const leg = legs[state.legIndex];
  if (!state.carried) {
    return smoothedMotion(leg.timeline, state.timeMs);
  }
  const next = legs[state.nextLegIndex];
  const from = smoothedMotion(leg.timeline, leg.timeline.endMs);
  const to = smoothedMotion(next.timeline, next.timeline.startMs);
  const eased = smoothstep(state.transitionFraction ?? 0);
  const between = (a, b) => (a === null ? b : b === null ? a : a + (b - a) * eased);
  return {
    heading: blendAngle(from.heading, to.heading, eased),
    // The sails are set for one wind or the other; blending a starboard wind into a
    // port one would sweep them through amidships.
    awa: eased < 0.5 ? from.awa : to.awa,
    tws: between(from.tws, to.tws),
    sog: between(from.sog, to.sog)
  };
}
