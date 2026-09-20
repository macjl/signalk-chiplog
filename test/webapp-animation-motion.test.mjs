import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SMOOTHING_SIGMA_MS, smoothedMotion } from '../public/js/animation/motion.mjs';
import { createTimeline } from '../public/js/animation/timeline.mjs';

const START = Date.UTC(2026, 8, 14, 6, 0, 0);
const STEP_MS = 15_000;

// A passage of `count` points, 15 s apart, going north-east.
function timelineOf(count, reading) {
  const points = Array.from({ length: count }, (unused, i) => ({
    time: new Date(START + i * STEP_MS).toISOString(),
    lat: 46.15 + i * 0.0002,
    lon: -1.15 + i * 0.0002,
    ...reading(i)
  }));
  return createTimeline(points);
}

// Hours of it, so the smoothing window fits well inside.
const LONG = 6 * 240 + 1;
const MIDDLE = START + Math.floor(LONG / 2) * STEP_MS;

// A jitter that is not a pattern the sampling could lock on to: -1 to 1, the same
// every run.
function noise(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function angularDistance(a, b) {
  return Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
}

describe('smoothed motion', () => {
  it('leaves a steady boat as it is', () => {
    const timeline = timelineOf(LONG, () => ({ heading: 0.8, awa: 0.6, tws: 7, sog: 3 }));
    const motion = smoothedMotion(timeline, MIDDLE);
    assert.ok(angularDistance(motion.heading, 0.8) < 1e-9);
    assert.ok(angularDistance(motion.awa, 0.6) < 1e-9);
    assert.ok(Math.abs(motion.tws - 7) < 1e-9);
    assert.ok(Math.abs(motion.sog - 3) < 1e-9);
  });

  it('takes the shiver out of a heading that wanders either side of its course', () => {
    const timeline = timelineOf(LONG, (i) => ({ heading: 1 + 0.45 * noise(i) }));
    // The raw heading is a quarter of a radian out, one way and then the other.
    let worstRaw = 0;
    for (let k = 0; k < 10; k += 1) {
      const ms = MIDDLE + k * 7000;
      worstRaw = Math.max(worstRaw, angularDistance(timeline.sample(ms).heading, 1));
      const smoothed = smoothedMotion(timeline, ms).heading;
      assert.ok(angularDistance(smoothed, 1) < 0.06, `frame ${k}: ${smoothed}`);
    }
    assert.ok(worstRaw > 0.2, 'the raw heading really does wander');
  });

  it('is steady from one frame to the next through that jitter', () => {
    const timeline = timelineOf(LONG, (i) => ({ heading: 1 + 0.45 * noise(i) }));
    let previous = smoothedMotion(timeline, MIDDLE).heading;
    let biggest = 0;
    // A frame at x1 is 2 minutes of sailing.
    for (let k = 1; k < 60; k += 1) {
      const heading = smoothedMotion(timeline, MIDDLE + k * 120_000).heading;
      biggest = Math.max(biggest, angularDistance(heading, previous));
      previous = heading;
    }
    assert.ok(biggest < 0.03, `biggest step ${biggest}`);
  });

  it('averages across north instead of pointing south', () => {
    const timeline = timelineOf(LONG, (i) => ({ heading: 0.4 * noise(i) }));
    const { heading } = smoothedMotion(timeline, MIDDLE);
    assert.ok(angularDistance(heading, 0) < 0.06, `heading ${heading}`);
  });

  it('follows a sharp turn — a tack — instead of averaging it away', () => {
    const turn = Math.floor(LONG / 2);
    const tacked = (i) => ({ heading: i < turn ? 0.8 : 5.5 });
    const timeline = timelineOf(LONG, tacked);
    const turnMs = START + turn * STEP_MS;
    // Before it, the old heading; a few minutes on, the new one — not something in
    // between, and never through the wind.
    assert.ok(angularDistance(smoothedMotion(timeline, turnMs - 8 * 60_000).heading, 0.8) < 0.05);
    assert.ok(angularDistance(smoothedMotion(timeline, turnMs + 8 * 60_000).heading, 5.5) < 0.05);
    // Every frame in between is a heading the boat could have had: between the two
    // by the short way round, with no overshoot.
    for (let ms = turnMs - 10 * 60_000; ms <= turnMs + 10 * 60_000; ms += 30_000) {
      const heading = smoothedMotion(timeline, ms).heading;
      const fromOld = angularDistance(heading, 0.8);
      const fromNew = angularDistance(heading, 5.5);
      assert.ok(
        fromOld + fromNew < angularDistance(0.8, 5.5) + 0.05,
        `heading ${heading} at ${(ms - turnMs) / 60_000} min`
      );
    }
  });

  it('follows a turn round a headland as the track makes it', () => {
    const ramp = (i) => {
      const minutes = (i * STEP_MS) / 60_000 - 170;
      return { heading: 0.5 + (Math.PI / 2) * Math.max(0, Math.min(1, minutes / 40)) };
    };
    const timeline = timelineOf(LONG, ramp);
    let worst = 0;
    for (let minutes = 150; minutes <= 230; minutes += 2) {
      const ms = START + minutes * 60_000;
      const raw = 0.5 + (Math.PI / 2) * Math.max(0, Math.min(1, (minutes - 170) / 40));
      worst = Math.max(worst, angularDistance(smoothedMotion(timeline, ms).heading, raw));
    }
    assert.ok(worst < 0.3, `worst gap to the track's own heading ${worst}`);
  });

  it('lets a slow wobble of a few degrees go', () => {
    const timeline = timelineOf(LONG, (i) => ({
      heading: 1 + 0.2 * Math.sin((i * STEP_MS) / 60_000 / 3)
    }));
    let widest = 0;
    for (let minutes = 150; minutes < 210; minutes += 3) {
      const heading = smoothedMotion(timeline, START + minutes * 60_000).heading;
      widest = Math.max(widest, angularDistance(heading, 1));
    }
    // The wobble is 0.2 rad either side; what is left of it is a fraction.
    assert.ok(widest < 0.07, `${widest} left of a 0.2 wobble`);
  });

  it('is a pure function of the instant', () => {
    const timeline = timelineOf(LONG, (i) => ({ heading: Math.sin(i / 30) }));
    assert.deepEqual(smoothedMotion(timeline, MIDDLE), smoothedMotion(timeline, MIDDLE));
  });

  it('does not lurch at the ends of the passage', () => {
    const timeline = timelineOf(LONG, () => ({ heading: 1.2 }));
    assert.ok(angularDistance(smoothedMotion(timeline, timeline.startMs).heading, 1.2) < 1e-9);
    assert.ok(angularDistance(smoothedMotion(timeline, timeline.endMs).heading, 1.2) < 1e-9);
  });

  it('falls back to the course, then to where the boat went', () => {
    const course = timelineOf(LONG, () => ({ cog: 0.9 }));
    assert.ok(angularDistance(smoothedMotion(course, MIDDLE).heading, 0.9) < 1e-9);
    const bare = timelineOf(LONG, () => ({}));
    const { heading } = smoothedMotion(bare, MIDDLE);
    // North-east on a Mercator map, give or take the projection.
    assert.ok(heading > 0.4 && heading < 1.2, `heading ${heading}`);
  });

  it('leaves out what the track lacks', () => {
    const timeline = timelineOf(LONG, () => ({ heading: 1 }));
    const motion = smoothedMotion(timeline, MIDDLE);
    assert.equal(motion.awa, null);
    assert.equal(motion.tws, null);
    assert.equal(motion.sog, null);
  });

  it('smooths the wind too, so the sails do not flap', () => {
    const timeline = timelineOf(LONG, (i) => ({
      heading: 1,
      awa: 0.8 + 0.4 * noise(i),
      tws: 7 + 3 * noise(i + 1000)
    }));
    const motion = smoothedMotion(timeline, MIDDLE);
    assert.ok(angularDistance(motion.awa, 0.8) < 0.08);
    assert.ok(Math.abs(motion.tws - 7) < 0.4);
  });

  it('smooths as much whatever the playback speed, since its window is film time', () => {
    // Half an hour of sailing is half a unit of film: at x4 a frame is 8 minutes,
    // so the window still spans several of them.
    const framesAtX4 = (2 * SMOOTHING_SIGMA_MS) / (8 * 60_000);
    assert.ok(framesAtX4 >= 6, `${framesAtX4} frames`);
  });
});

describe('smoothed wind', () => {
  it('flips with a tack instead of passing through the middle', () => {
    const turn = Math.floor(LONG / 2);
    const timeline = timelineOf(LONG, (i) => ({ heading: 1, awa: i < turn ? 0.7 : -0.7 }));
    const turnMs = START + turn * STEP_MS;
    assert.ok(angularDistance(smoothedMotion(timeline, turnMs - 8 * 60_000).awa, 0.7) < 0.05);
    assert.ok(angularDistance(smoothedMotion(timeline, turnMs + 8 * 60_000).awa, -0.7) < 0.05);
    // Never the amidships a plain average of the two would give.
    for (let ms = turnMs - 10 * 60_000; ms <= turnMs + 10 * 60_000; ms += 30_000) {
      assert.ok(
        Math.abs(smoothedMotion(timeline, ms).awa) > 0.3,
        `at ${(ms - turnMs) / 60_000} min`
      );
    }
  });
});
