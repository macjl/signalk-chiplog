import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { worldScale, worldX, worldY } from '../public/js/animation/mercator.mjs';
import {
  buildLegs,
  blendAngle,
  buildStoryboard,
  HOLD_UNITS,
  INTRO_UNITS,
  OUTRO_UNITS,
  OVERNIGHT_HOLD_UNITS,
  overviewFrame,
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

  const legStart = board.segments.find(
    (segment) => segment.kind === 'leg' && segment.legIndex === 0
  ).startUnits;

  it('starts at the first departure with nothing covered', () => {
    for (const units of [0, legStart]) {
      const state = stateAt(board, units);
      assert.equal(state.legIndex, 0);
      assert.equal(state.distance, 0);
      assert.equal(state.timeMs, legs[0].timeline.startMs);
    }
    assert.equal(stateAt(board, legStart).phase, 'leg');
    assert.equal(stateAt(board, legStart).boatVisible, true);
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

  it('flies the camera between the two framings, the boat gone while it does', () => {
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

  it('shows the boat again at the next departure once the camera has flown', () => {
    const move = board.segments.find((segment) => segment.kind === 'transition');
    assert.equal(stateAt(board, move.startUnits - 1e-6).boatVisible, true);
    assert.equal(stateAt(board, move.startUnits + 1e-6).boatVisible, false);
    assert.equal(stateAt(board, move.endUnits + 1e-6).boatVisible, true);
    assert.equal(stateAt(board, move.endUnits + 1e-6).phase, 'leg');
  });

  it('keeps the camera on the boat while sailing, at that passage zoom', () => {
    const state = stateAt(board, legStart + 1);
    assert.equal(state.camera.centre.lat, state.lat);
    assert.equal(state.camera.centre.lon, state.lon);
    assert.equal(state.camera.zoom, legs[0].frame.zoom);
  });

  it('runs the clock forward within a leg', () => {
    const early = stateAt(board, legStart + 0.5);
    const late = stateAt(board, legStart + 1.5);
    assert.ok(late.timeMs > early.timeMs);
    assert.ok(late.timeMs <= legs[0].timeline.endMs);
  });

  it('clamps outside the film rather than running off it', () => {
    assert.deepEqual(stateAt(board, -10), stateAt(board, 0));
    assert.deepEqual(stateAt(board, board.totalUnits + 10), stateAt(board, board.totalUnits));
  });
});

// A range wide enough that framing all of it is well beyond the working scale of
// one passage.
function wideBoard() {
  const legs = buildLegs(
    [
      passage(1, DAY, 2, { lat: 46.15, lon: -1.15 }),
      passage(2, DAY + 30 * HOUR, 2, { lat: 47.6, lon: -3.1 })
    ],
    FRAME
  );
  return { legs, board: buildStoryboard(legs, FRAME) };
}

describe('the opening and closing camera moves', () => {
  const { legs, board } = wideBoard();
  const intro = board.segments[0];
  const outro = board.segments[board.segments.length - 1];

  it('open with an intro of two seconds, and close with an outro of two', () => {
    assert.equal(intro.kind, 'intro');
    assert.equal(intro.units, INTRO_UNITS);
    assert.equal(INTRO_UNITS, 2);
    assert.equal(outro.kind, 'outro');
    assert.equal(outro.units, OUTRO_UNITS);
    assert.equal(OUTRO_UNITS, 2);
    assert.equal(board.segments[1].kind, 'leg');
    assert.equal(outro.endUnits, board.totalUnits);
  });

  it('start on the whole navigation: every leg is inside the frame', () => {
    const state = stateAt(board, 0);
    assert.equal(state.phase, 'intro');
    assert.deepEqual(state.camera, board.overview);
    const scale = worldScale(state.camera.zoom);
    for (const leg of legs) {
      for (const corner of [
        [leg.bounds.minLat, leg.bounds.minLon],
        [leg.bounds.maxLat, leg.bounds.maxLon]
      ]) {
        const dx = Math.abs(worldX(corner[1]) - worldX(state.camera.centre.lon)) * scale;
        const dy = Math.abs(worldY(corner[0]) - worldY(state.camera.centre.lat)) * scale;
        assert.ok(dx <= FRAME.width / 2 && dy <= FRAME.height / 2, 'a leg is out of the frame');
      }
    }
  });

  it('is wider than the passage framing it comes down to', () => {
    assert.ok(board.overview.zoom < legs[0].frame.zoom);
  });

  it('come down onto the first position, at the zoom the leg is sailed at', () => {
    const end = stateAt(board, intro.endUnits);
    assert.equal(end.camera.zoom, legs[0].frame.zoom);
    assert.ok(Math.abs(end.camera.centre.lat - legs[0].timeline.first.lat) < 1e-9);
    assert.ok(Math.abs(end.camera.centre.lon - legs[0].timeline.first.lon) < 1e-9);
    // No jump into the leg: the same framing a frame later.
    const sailing = stateAt(board, intro.endUnits + 1e-6);
    assert.equal(sailing.phase, 'leg');
    assert.ok(Math.abs(sailing.camera.zoom - end.camera.zoom) < 1e-9);
    assert.ok(Math.abs(sailing.camera.centre.lat - end.camera.centre.lat) < 1e-6);
  });

  it('do not show the boat, which appears where the sailing begins', () => {
    for (const fraction of [0, 0.5, 0.999]) {
      const state = stateAt(board, intro.startUnits + fraction * INTRO_UNITS);
      assert.equal(state.phase, 'intro');
      assert.equal(state.boatVisible, false, `visible at ${fraction} of the intro`);
    }
    assert.equal(stateAt(board, intro.endUnits + 1e-6).boatVisible, true);
    for (const fraction of [0, 0.5, 1]) {
      const state = stateAt(board, outro.startUnits + fraction * OUTRO_UNITS);
      assert.equal(state.phase, 'outro');
      assert.equal(state.boatVisible, false, `visible at ${fraction} of the outro`);
    }
    // And the beat of rest just before it still has it.
    assert.equal(stateAt(board, outro.startUnits - 1e-6).boatVisible, true);
  });

  it('start with nothing sailed, and the clock at the start', () => {
    for (const fraction of [0, 0.5, 1]) {
      const state = stateAt(board, intro.startUnits + fraction * INTRO_UNITS);
      assert.equal(state.distance, 0);
      assert.equal(state.timeMs, legs[0].timeline.startMs);
      assert.equal(state.lat, legs[0].timeline.first.lat);
    }
  });

  it('zoom in evenly, and keep the first position in view all the way down', () => {
    const departure = legs[0].timeline.first;
    let previousZoom = -Infinity;
    let previousOffset = Infinity;
    for (let step = 0; step <= 40; step += 1) {
      const state = stateAt(board, intro.startUnits + (step / 40) * INTRO_UNITS);
      assert.ok(state.camera.zoom >= previousZoom - 1e-9, 'zoom went back out');
      previousZoom = state.camera.zoom;
      // Where the departure lands, in pixels from the middle of the frame: it
      // homes in on the middle and never wanders off.
      const scale = worldScale(state.camera.zoom);
      const offset = Math.hypot(
        (worldX(departure.lon) - worldX(state.camera.centre.lon)) * scale,
        (worldY(departure.lat) - worldY(state.camera.centre.lat)) * scale
      );
      assert.ok(offset <= previousOffset + 1e-6, `it moved away at step ${step}`);
      previousOffset = offset;
    }
    assert.ok(previousOffset < 1e-3);
  });

  it('close by pulling back from the last position to the whole navigation', () => {
    const start = stateAt(board, outro.startUnits);
    const lastLeg = legs[legs.length - 1];
    assert.equal(start.camera.zoom, lastLeg.frame.zoom);
    assert.ok(Math.abs(start.camera.centre.lat - lastLeg.timeline.last.lat) < 1e-9);
    const end = stateAt(board, board.totalUnits);
    assert.equal(end.phase, 'outro');
    assert.deepEqual(end.camera, board.overview);
    // The clock and the distance say everything is done.
    assert.equal(end.timeMs, lastLeg.timeline.endMs);
    assert.ok(Math.abs(end.distance - board.totalDistance) < 1e-9);
    let previous = Infinity;
    for (let step = 0; step <= 40; step += 1) {
      const state = stateAt(board, outro.startUnits + (step / 40) * OUTRO_UNITS);
      assert.ok(state.camera.zoom <= previous + 1e-9, 'zoom went back in');
      previous = state.camera.zoom;
    }
  });

  it('are skipped when the passage is already framed as wide as the whole navigation', () => {
    const single = buildStoryboard(buildLegs([passage(1, DAY, 2)], FRAME), FRAME);
    assert.ok(single.segments.every((segment) => segment.kind !== 'intro'));
    assert.ok(single.segments.every((segment) => segment.kind !== 'outro'));
    assert.equal(stateAt(single, 0).phase, 'leg');
  });

  it('take the short way round the world across the antimeridian', () => {
    const legs = buildLegs(
      [
        passage(1, DAY, 2, { lat: -17, lon: 179.4 }),
        passage(2, DAY + 30 * HOUR, 2, { lat: -18, lon: -179.6 })
      ],
      FRAME
    );
    const frame = overviewFrame(legs, FRAME);
    assert.ok(
      Math.abs(frame.centre.lon) > 175 || frame.centre.lon > 175 || frame.centre.lon < -175
    );
  });
});

describe('resting between legs', () => {
  it('is a beat, not a pause: well under a second at x1', () => {
    assert.ok(HOLD_UNITS < 0.5);
    assert.ok(OVERNIGHT_HOLD_UNITS < 1);
    assert.ok(OVERNIGHT_HOLD_UNITS >= HOLD_UNITS);
  });
});

describe('blending headings', () => {
  it('goes the short way round the circle', () => {
    const half = blendAngle(0.1, 2 * Math.PI - 0.1, 0.5);
    assert.ok(Math.min(half, 2 * Math.PI - half) < 1e-9, `${half}`);
    assert.ok(Math.abs(blendAngle(0, 1, 0.25) - 0.25) < 1e-9);
  });

  it('keeps either end at its own value', () => {
    assert.ok(Math.abs(blendAngle(1, 2, 0) - 1) < 1e-9);
    assert.ok(Math.abs(blendAngle(1, 2, 1) - 2) < 1e-9);
  });

  it('makes do with whichever heading is known', () => {
    assert.equal(blendAngle(null, 2, 0.5), 2);
    assert.equal(blendAngle(1, undefined, 0.5), 1);
    assert.equal(blendAngle(null, null, 0.5), null);
  });
});

// The second passage leaves where the first arrived: the boat stays put.
function sameHarbourBoard() {
  const first = passage(1, DAY, 2, { lat: 46.15, lon: -1.15 });
  const arrival = first.points[first.points.length - 1];
  const second = passage(2, DAY + 30 * HOUR, 3, { lat: arrival.lat, lon: arrival.lon });
  const legs = buildLegs([first, second], FRAME);
  return { legs, board: buildStoryboard(legs, FRAME) };
}

describe('a stop where the boat leaves from where it arrived', () => {
  const { legs, board } = sameHarbourBoard();
  const hold = board.segments.find((segment) => segment.kind === 'hold');

  it('has no camera move: the rest carries straight on to the next leg', () => {
    assert.equal(board.segments.filter((segment) => segment.kind === 'transition').length, 0);
    assert.equal(hold.nextIndex, 1);
    assert.equal(hold.units, OVERNIGHT_HOLD_UNITS);
  });

  it('never takes the boat out of the frame between the two legs', () => {
    const from = board.segments.find((segment) => segment.kind === 'leg').startUnits;
    const to = board.segments.filter((segment) => segment.kind === 'leg').at(-1).endUnits;
    for (let units = from; units <= to; units += 0.05) {
      assert.equal(stateAt(board, units).boatVisible, true, `hidden at ${units}`);
    }
  });

  it('carries the boat and the camera across to the next leg’s start, turning it', () => {
    const departure = legs[1].timeline.sample(legs[1].timeline.startMs);
    const arrival = legs[0].timeline.sample(legs[0].timeline.endMs);
    const start = stateAt(board, hold.startUnits);
    const end = stateAt(board, hold.endUnits);
    assert.ok(Math.abs(start.lat - arrival.lat) < 1e-9);
    assert.ok(Math.abs(end.lat - departure.lat) < 1e-9);
    assert.ok(Math.abs(end.lon - departure.lon) < 1e-9);
    assert.ok(Math.abs(start.heading - arrival.heading) < 1e-9);
    assert.ok(Math.abs(end.heading - departure.heading) < 1e-9);
    // The boat is at the middle of the frame, on the camera's own target.
    for (const state of [start, stateAt(board, hold.startUnits + hold.units / 2), end]) {
      assert.equal(state.lat, state.camera.centre.lat);
      assert.equal(state.lon, state.camera.centre.lon);
    }
  });

  it('eases the zoom to the next leg’s, so the leg starts without a jump', () => {
    const end = stateAt(board, hold.endUnits);
    assert.equal(end.camera.zoom, legs[1].frame.zoom);
    const sailing = stateAt(board, hold.endUnits + 1e-6);
    assert.equal(sailing.phase, 'leg');
    assert.ok(Math.abs(sailing.camera.zoom - end.camera.zoom) < 1e-9);
    assert.ok(Math.abs(sailing.camera.centre.lat - end.camera.centre.lat) < 1e-6);
    assert.ok(Math.abs(sailing.camera.centre.lon - end.camera.centre.lon) < 1e-6);
  });

  it('is not sailing while it does: the clock and the trip meter stand still', () => {
    const middle = stateAt(board, hold.startUnits + hold.units / 2);
    assert.equal(middle.phase, 'hold');
    assert.equal(middle.timeMs, legs[0].timeline.endMs);
    assert.ok(Math.abs(middle.distance - legs[0].timeline.totalDistance) < 1e-9);
  });

  it('still flies, and hides the boat, between places more than a mile apart', () => {
    const far = buildStoryboard(
      buildLegs(
        [
          passage(1, DAY, 2, { lat: 46.15, lon: -1.15 }),
          passage(2, DAY + 30 * HOUR, 2, { lat: 46.4, lon: -1.15 })
        ],
        FRAME
      ),
      FRAME
    );
    assert.equal(far.segments.filter((segment) => segment.kind === 'transition').length, 1);
  });
});
