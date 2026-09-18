import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildLegs,
  buildStoryboard,
  HOLD_UNITS,
  OVERNIGHT_HOLD_UNITS,
  stateAt,
  TRANSITION_UNITS
} from '../public/js/animation/storyboard.mjs';

const FRAME = { width: 1920, height: 1080 };
const HOUR = 3_600_000;

// A passage of `hours` hours, sampled every ten minutes, starting at `startMs`
// and heading north-east from `from`.
function passage(id, startMs, hours, from = { lat: 46.15, lon: -1.15 }, step = 0.02) {
  const count = hours * 6 + 1;
  const points = Array.from({ length: count }, (unused, i) => ({
    time: new Date(startMs + (i * hours * HOUR) / (count - 1)).toISOString(),
    lat: from.lat + i * step,
    lon: from.lon + i * step,
    sog: 3,
    cog: 0.8,
    heading: 0.8
  }));
  return {
    entry: { id, startTime: points[0].time, endTime: points[count - 1].time },
    points
  };
}

const DAY = Date.UTC(2026, 8, 14, 6, 0, 0);

describe('animation legs', () => {
  it('orders passages chronologically, however they arrived', () => {
    // The API hands them back newest first.
    const legs = buildLegs(
      [passage(3, DAY + 48 * HOUR, 2), passage(1, DAY, 2), passage(2, DAY + 24 * HOUR, 2)],
      FRAME
    );
    assert.deepEqual(
      legs.map((leg) => leg.entry.id),
      [1, 2, 3]
    );
  });

  it('leaves out a passage with nothing to animate', () => {
    const noTrack = { entry: { id: 9 }, points: [] };
    const onePoint = {
      entry: { id: 8 },
      points: [{ time: new Date(DAY).toISOString(), lat: 46, lon: -1 }]
    };
    const legs = buildLegs([passage(1, DAY, 2), noTrack, onePoint], FRAME);
    assert.equal(legs.length, 1);
    assert.equal(legs[0].entry.id, 1);
  });

  it('carries the distance forward from one leg to the next', () => {
    const legs = buildLegs([passage(1, DAY, 2), passage(2, DAY + 24 * HOUR, 2)], FRAME);
    assert.equal(legs[0].distanceOffset, 0);
    assert.ok(Math.abs(legs[1].distanceOffset - legs[0].timeline.totalDistance) < 1e-9);
  });

  it('gives each passage a zoom of its own', () => {
    const legs = buildLegs(
      [
        passage(1, DAY, 6, { lat: 46.15, lon: -1.15 }, 0.05),
        // A short hop the same day, a fraction of the size.
        passage(2, DAY + 12 * HOUR, 1, { lat: 46.15, lon: -1.15 }, 0.001)
      ],
      FRAME
    );
    assert.ok(legs[0].frame.zoom < legs[1].frame.zoom, 'the long passage should be framed wider');
  });

  it('has no legs at all when nothing in the range has a track', () => {
    assert.deepEqual(buildLegs([], FRAME), []);
    assert.deepEqual(buildLegs(undefined, FRAME), []);
  });
});

describe('animation storyboard', () => {
  it('plays an hour of sailing in a second', () => {
    const board = buildStoryboard(buildLegs([passage(1, DAY, 6)], FRAME));
    const sailing = board.segments.find((segment) => segment.kind === 'leg');
    assert.ok(Math.abs(sailing.units - 6) < 1e-9);
  });

  it('rests on the arrival, then moves the camera on', () => {
    const board = buildStoryboard(
      buildLegs([passage(1, DAY, 2), passage(2, DAY + 4 * HOUR, 2)], FRAME)
    );
    assert.deepEqual(
      board.segments.map((segment) => segment.kind),
      ['leg', 'hold', 'transition', 'leg', 'hold']
    );
    assert.ok(
      Math.abs(board.totalUnits - (2 + HOLD_UNITS + TRANSITION_UNITS + 2 + HOLD_UNITS)) < 1e-9
    );
  });

  it('rests longer when the crew stopped for the night', () => {
    const board = buildStoryboard(
      buildLegs([passage(1, DAY, 2), passage(2, DAY + 30 * HOUR, 2)], FRAME)
    );
    const hold = board.segments.find((segment) => segment.kind === 'hold');
    assert.equal(hold.units, OVERNIGHT_HOLD_UNITS);
  });

  // The whole point of a date-range animation: the days in port cost nothing.
  it('skips the time spent in port', () => {
    const together = buildStoryboard(
      buildLegs([passage(1, DAY, 2), passage(2, DAY + 2 * HOUR + 600_000, 2)], FRAME)
    );
    const apart = buildStoryboard(
      buildLegs([passage(1, DAY, 2), passage(2, DAY + 20 * 24 * HOUR, 2)], FRAME)
    );
    // Twenty days apart, yet only the longer rest separates them.
    assert.ok(apart.totalUnits - together.totalUnits < 2);
    assert.ok(apart.totalUnits < 10, `${apart.totalUnits} units for twenty days is far too long`);
  });

  it('has a single leg and no transition on its own', () => {
    const board = buildStoryboard(buildLegs([passage(1, DAY, 3)], FRAME));
    assert.equal(board.segments.filter((segment) => segment.kind === 'transition').length, 0);
    assert.ok(Math.abs(board.totalUnits - (3 + HOLD_UNITS)) < 1e-9);
  });

  it('is empty when there is nothing to play', () => {
    const board = buildStoryboard([]);
    assert.equal(board.totalUnits, 0);
    assert.equal(stateAt(board, 0), null);
  });
});

describe('animation state', () => {
  const legs = buildLegs([passage(1, DAY, 2), passage(2, DAY + 30 * HOUR, 3)], FRAME);
  const board = buildStoryboard(legs);

  it('starts at the first departure with nothing covered', () => {
    const state = stateAt(board, 0);
    assert.equal(state.phase, 'leg');
    assert.equal(state.legIndex, 0);
    assert.equal(state.distance, 0);
    assert.equal(state.timeMs, legs[0].timeline.startMs);
    assert.equal(state.boatVisible, true);
  });

  it('ends at the last arrival with everything covered', () => {
    const state = stateAt(board, board.totalUnits);
    assert.equal(state.legIndex, 1);
    assert.equal(state.timeMs, legs[1].timeline.endMs);
    assert.ok(Math.abs(state.distance - board.totalDistance) < 1e-9);
  });

  it('counts the distance up across the legs, never down', () => {
    let previous = -1;
    for (let units = 0; units <= board.totalUnits; units += 0.05) {
      const state = stateAt(board, units);
      assert.ok(state.distance >= previous - 1e-9, `distance fell back at ${units}`);
      previous = state.distance;
    }
  });

  it('holds the clock and the boat still while resting', () => {
    const hold = board.segments.find((segment) => segment.kind === 'hold');
    const early = stateAt(board, hold.startUnits + 0.1);
    const late = stateAt(board, hold.endUnits - 0.1);
    assert.equal(early.phase, 'hold');
    assert.equal(early.timeMs, legs[0].timeline.endMs);
    assert.equal(early.timeMs, late.timeMs);
    assert.equal(early.lat, late.lat);
    assert.equal(early.boatVisible, true);
  });

  it('flies the camera between the two framings, without the boat', () => {
    const move = board.segments.find((segment) => segment.kind === 'transition');
    const middle = stateAt(board, (move.startUnits + move.endUnits) / 2);
    assert.equal(middle.phase, 'transition');
    assert.equal(middle.boatVisible, false);
    const [from, to] = [legs[0].frame.zoom, legs[1].frame.zoom];
    assert.ok(
      middle.camera.zoom > Math.min(from, to) && middle.camera.zoom < Math.max(from, to),
      `zoom ${middle.camera.zoom} is not between ${from} and ${to}`
    );
    // Halfway along, it is halfway there.
    const arrival = legs[0].timeline.last;
    const departure = legs[1].timeline.first;
    assert.ok(Math.abs(middle.camera.centre.lat - (arrival.lat + departure.lat) / 2) < 1e-9);
  });

  it('keeps the camera on the boat while sailing, at that passage zoom', () => {
    const state = stateAt(board, 1);
    assert.equal(state.camera.centre.lat, state.lat);
    assert.equal(state.camera.centre.lon, state.lon);
    assert.equal(state.camera.zoom, legs[0].frame.zoom);
  });

  it('runs the clock forward within a leg', () => {
    const early = stateAt(board, 0.5);
    const late = stateAt(board, 1.5);
    assert.ok(late.timeMs > early.timeMs);
    assert.ok(late.timeMs <= legs[0].timeline.endMs);
  });

  it('clamps outside the film rather than running off it', () => {
    assert.deepEqual(stateAt(board, -10), stateAt(board, 0));
    assert.deepEqual(stateAt(board, board.totalUnits + 10), stateAt(board, board.totalUnits));
  });
});
