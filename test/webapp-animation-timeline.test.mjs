import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTimeline,
  haversineMetres,
  interpolateAngle
} from '../public/js/animation/timeline.mjs';

const BASE = Date.UTC(2026, 8, 14, 8, 0, 0);
const ms = (seconds) => BASE + seconds * 1000;
const at = (seconds) => new Date(ms(seconds)).toISOString();

// Deliberately uneven spacing: two points 15 s apart, one 5 s later, then a
// five-minute gap. That is what a real track looks like, and what an
// index-driven animation would get wrong.
const POINTS = [
  { time: at(0), lat: 46.15, lon: -1.15, sog: 3, cog: 1.5, tws: 8, heading: 1.4, awa: 0.5 },
  { time: at(15), lat: 46.16, lon: -1.16, sog: 4, cog: 1.6, tws: 9, heading: 1.5, awa: 0.6 },
  { time: at(20), lat: 46.17, lon: -1.17, sog: 5, cog: 1.7, tws: null, heading: 1.6, awa: 0.7 },
  { time: at(320), lat: 46.2, lon: -1.2, sog: 6, cog: 1.8, tws: 10, heading: 1.7, awa: 0.8 },
  { time: at(335), lat: 46.21, lon: -1.21, sog: 7, cog: 1.9, tws: 11, heading: 1.8, awa: 0.9 }
];

describe('animation distance', () => {
  // The bubble counts the distance up from the track; the entry carries the
  // server's own total. They must be the same number.
  it('matches the distance the server records', async () => {
    const { distanceBetween } = await import('../lib/places.js');
    const pairs = [
      [
        { lat: 46.15, lon: -1.15 },
        { lat: 46.16, lon: -1.16 }
      ],
      [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 1 }
      ],
      [
        { lat: -33.9, lon: 151.2 },
        { lat: -34.1, lon: 150.9 }
      ]
    ];
    for (const [a, b] of pairs) {
      assert.ok(
        Math.abs(haversineMetres(a, b) - distanceBetween(a, b)) < 1e-9,
        `${JSON.stringify(a)} to ${JSON.stringify(b)}`
      );
    }
  });

  it('measures a degree of latitude at about 111 km', () => {
    const metres = haversineMetres({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    assert.ok(Math.abs(metres - 111195) < 1200, `${metres} m`);
  });
});

describe('angle interpolation', () => {
  it('takes the short way round', () => {
    const from = (350 * Math.PI) / 180;
    const to = (10 * Math.PI) / 180;
    const middle = interpolateAngle(from, to, 0.5);
    // 0°, give or take a full turn — and emphatically not 180°.
    const wrapped = ((middle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    assert.ok(Math.min(wrapped, 2 * Math.PI - wrapped) < 1e-9, `${wrapped} rad`);
  });

  it('crosses the back of a signed wind angle rather than the bow', () => {
    const middle = interpolateAngle(-3, 3, 0.5);
    assert.ok(Math.abs(Math.abs(middle) - Math.PI) < 1e-9, `${middle} rad`);
  });
});

describe('animation timeline', () => {
  const timeline = createTimeline(POINTS);

  it('spans the track', () => {
    assert.equal(timeline.count, 5);
    assert.equal(timeline.startMs, Date.parse(at(0)));
    assert.equal(timeline.endMs, Date.parse(at(335)));
    assert.equal(timeline.durationMs, 335_000);
  });

  it('totals the distance leg by leg', () => {
    let expected = 0;
    for (let i = 1; i < POINTS.length; i += 1) {
      expected += haversineMetres(POINTS[i - 1], POINTS[i]);
    }
    assert.ok(Math.abs(timeline.totalDistance - expected) < 1e-9);
  });

  it('reproduces the ends exactly', () => {
    const start = timeline.sample(timeline.startMs);
    assert.equal(start.lat, 46.15);
    assert.equal(start.lon, -1.15);
    assert.equal(start.distance, 0);
    assert.equal(start.sog, 3);

    const end = timeline.sample(timeline.endMs);
    assert.equal(end.lat, 46.21);
    assert.equal(end.distance, timeline.totalDistance);
    assert.equal(end.sog, 7);
  });

  it('interpolates halfway between two points', () => {
    const middle = timeline.sample(ms(7.5));
    assert.ok(Math.abs(middle.lat - 46.155) < 1e-12);
    assert.ok(Math.abs(middle.lon - -1.155) < 1e-12);
    assert.ok(Math.abs(middle.sog - 3.5) < 1e-12);
    const span = haversineMetres(POINTS[0], POINTS[1]);
    assert.ok(Math.abs(middle.distance - span / 2) < 1e-9);
  });

  it('carries a missing reading over from the side that has one', () => {
    // tws is null on the point at 20 s, present either side of it.
    const before = timeline.sample(ms(17));
    const after = timeline.sample(ms(100));
    assert.equal(before.tws, 9);
    assert.equal(after.tws, 10);
    assert.ok(!Number.isNaN(before.tws));
  });

  it('hands back null, never NaN, when no side has the reading', () => {
    const blind = createTimeline([
      { time: at(0), lat: 46, lon: -1, sog: null, stw: null },
      { time: at(10), lat: 46.01, lon: -1.01, sog: null, stw: null }
    ]);
    const point = blind.sample(ms(5));
    assert.equal(point.sog, null);
    assert.equal(point.stw, null);
  });

  it('clamps outside the track instead of running off the end', () => {
    const before = timeline.sample(timeline.startMs - 1e9);
    const after = timeline.sample(timeline.endMs + 1e9);
    assert.equal(before.timeMs, timeline.startMs);
    assert.equal(after.timeMs, timeline.endMs);
    assert.ok(Number.isFinite(before.lat) && Number.isFinite(after.lat));
  });

  // The cursor is an optimisation; if it ever leaked state, scrubbing would
  // give a different answer from playing.
  it('answers the same however the track was walked', () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const times = Array.from({ length: 300 }, () =>
      Math.round(timeline.startMs + random() * timeline.durationMs)
    );

    const forward = createTimeline(POINTS);
    [...times].sort((a, b) => a - b).forEach((instant) => forward.sample(instant));
    const backward = createTimeline(POINTS);
    [...times].sort((a, b) => b - a).forEach((instant) => backward.sample(instant));

    for (const instant of times) {
      const fresh = createTimeline(POINTS).sample(instant);
      assert.deepEqual(forward.sample(instant), fresh, `after a forward walk, at ${instant}`);
      assert.deepEqual(backward.sample(instant), fresh, `after a backward walk, at ${instant}`);
    }
  });

  it('finds the same interval a plain scan would', () => {
    for (let i = 0; i < POINTS.length - 1; i += 1) {
      const midpoint = (Date.parse(POINTS[i].time) + Date.parse(POINTS[i + 1].time)) / 2;
      assert.equal(timeline.indexAt(midpoint), i, `interval ${i}`);
    }
  });

  it('keeps the distance flat while the boat sits still', () => {
    // The demo logbook has a twenty-minute stop at identical coordinates.
    const moored = createTimeline([
      { time: at(0), lat: 46.15, lon: -1.15, sog: 0 },
      { time: at(600), lat: 46.15, lon: -1.15, sog: 0 },
      { time: at(1200), lat: 46.15, lon: -1.15, sog: 0 }
    ]);
    assert.equal(moored.totalDistance, 0);
    assert.equal(moored.sample(ms(300)).distance, 0);
  });
});

describe('animation timeline edge cases', () => {
  it('has nothing to show for an empty track', () => {
    const empty = createTimeline([]);
    assert.equal(empty.count, 0);
    assert.equal(empty.durationMs, 0);
    assert.equal(empty.sample(0), null);
    assert.equal(createTimeline(undefined).count, 0);
  });

  it('stands still on a one-point track', () => {
    const single = createTimeline([{ time: at(0), lat: 46, lon: -1, sog: 2 }]);
    assert.equal(single.count, 1);
    assert.equal(single.durationMs, 0);
    const point = single.sample(ms(999));
    assert.equal(point.lat, 46);
    assert.equal(point.sog, 2);
  });

  it('drops points without a time or without a position', () => {
    const messy = createTimeline([
      { time: at(0), lat: 46, lon: -1 },
      { time: null, lat: 46.1, lon: -1.1 },
      { time: at(30), lat: null, lon: -1.2 },
      { time: at(60), lat: 46.4, lon: -1.4 }
    ]);
    assert.equal(messy.count, 2);
    assert.equal(messy.durationMs, 60_000);
  });

  it('drops a point that goes back in time, keeping the ones that follow', () => {
    const jumbled = createTimeline([
      { time: at(0), lat: 46, lon: -1 },
      { time: at(60), lat: 46.1, lon: -1.1 },
      { time: at(30), lat: 46.2, lon: -1.2 },
      { time: at(90), lat: 46.3, lon: -1.3 }
    ]);
    assert.equal(jumbled.count, 3);
    assert.equal(jumbled.durationMs, 90_000);
  });

  it('does not divide by zero on two points at the same instant', () => {
    const tied = createTimeline([
      { time: at(0), lat: 46, lon: -1, sog: 3 },
      { time: at(0), lat: 46.1, lon: -1.1, sog: 5 },
      { time: at(10), lat: 46.2, lon: -1.2, sog: 7 }
    ]);
    const point = tied.sample(ms(0));
    assert.ok(Number.isFinite(point.lat));
    assert.ok(Number.isFinite(point.distance));
  });

  it('keeps a track crossing the antimeridian in one piece', () => {
    const seam = createTimeline([
      { time: at(0), lat: 0, lon: 179.9 },
      { time: at(60), lat: 0, lon: -179.9 }
    ]);
    // A quarter of a degree of travel, not most of the way round the world.
    assert.ok(seam.totalDistance < 30_000, `${seam.totalDistance} m`);
    assert.ok(Math.abs(seam.sample(ms(30)).lon - 180) < 1e-9);
  });

  it('changes its signature only when the track does', () => {
    const same = createTimeline([...POINTS]);
    assert.equal(same.signature, createTimeline(POINTS).signature);
    const grown = createTimeline([...POINTS, { time: at(400), lat: 46.22, lon: -1.22, sog: 7 }]);
    assert.notEqual(grown.signature, same.signature);
  });
});
