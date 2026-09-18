import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPlayer } from '../public/js/animation/player.mjs';
import { MAX_REAL_STEP_MS } from '../public/js/animation/schedule.mjs';

// A frame loop driven by hand, so a test can step through the film.
function fakeFrames() {
  let pending = null;
  let clock = 0;
  const cancelled = [];
  let nextHandle = 1;
  return {
    cancelled,
    raf(callback) {
      pending = callback;
      return nextHandle++;
    },
    cancel(handle) {
      cancelled.push(handle);
      pending = null;
    },
    // Let `ms` of wall-clock time go by and deliver one frame.
    step(ms = 16) {
      clock += ms;
      const callback = pending;
      pending = null;
      callback?.(clock);
    },
    get waiting() {
      return pending !== null;
    }
  };
}

function build(totalUnits = 10, extra = {}) {
  const frames = fakeFrames();
  const painted = [];
  const states = [];
  const player = createPlayer({
    totalUnits,
    onFrame: (units) => painted.push(units),
    onStateChange: (state) => states.push(state),
    raf: frames.raf,
    cancel: frames.cancel,
    ...extra
  });
  return { frames, painted, states, player };
}

describe('animation player', () => {
  it('starts stopped at the beginning', () => {
    const { player } = build();
    assert.deepEqual(player.state(), {
      units: 0,
      playing: false,
      ended: false,
      speed: 1,
      totalUnits: 10
    });
  });

  it('advances by the wall clock while playing', () => {
    const { frames, painted, player } = build();
    player.play();
    for (let i = 0; i < 10; i += 1) {
      frames.step(16);
    }
    assert.equal(painted.length, 10);
    // The first frame has no previous timestamp, so nine steps of 16 ms count.
    assert.ok(Math.abs(player.state().units - 9 * 0.016) < 1e-9, `${player.state().units}`);
  });

  it('runs four times as far at x4', () => {
    const { frames, player } = build();
    player.setSpeed(4);
    player.play();
    frames.step(16);
    frames.step(16);
    assert.ok(Math.abs(player.state().units - 0.064) < 1e-9);
  });

  it('stops where it was when paused, and asks for no more frames', () => {
    const { frames, player } = build();
    player.play();
    frames.step(16);
    frames.step(16);
    const { units } = player.state();
    player.pause();
    assert.equal(player.state().playing, false);
    assert.equal(frames.waiting, false, 'a paused player should not be waiting on a frame');
    frames.step(1000);
    assert.equal(player.state().units, units);
  });

  it('cancels the frame it was waiting for', () => {
    const { frames, player } = build();
    player.play();
    frames.step(16);
    player.pause();
    assert.equal(frames.cancelled.length, 1);
  });

  it('repaints when scrubbed, even while paused', () => {
    const { painted, player } = build();
    player.seek(4);
    assert.equal(player.state().units, 4);
    assert.deepEqual(painted, [4]);
  });

  it('clamps a scrub to the film', () => {
    const { player } = build();
    player.seek(-5);
    assert.equal(player.state().units, 0);
    player.seek(999);
    assert.equal(player.state().units, 10);
  });

  it('stops dead on the last frame', () => {
    const { frames, player, states } = build(0.05);
    player.play();
    frames.step(16);
    frames.step(100);
    const state = player.state();
    assert.equal(state.units, 0.05);
    assert.equal(state.playing, false);
    assert.equal(state.ended, true);
    assert.equal(frames.waiting, false);
    assert.equal(states.filter((each) => each.ended).length, 1, 'should announce the end once');
  });

  it('starts again from the top when played after the end', () => {
    const { frames, player } = build(0.05);
    player.play();
    frames.step(16);
    frames.step(100);
    player.play();
    assert.equal(player.state().units, 0);
    assert.equal(player.state().ended, false);
    assert.equal(player.state().playing, true);
  });

  // Changing speed mid-playback must not move the slider under the reader.
  it('does not move the film when the speed changes', () => {
    const { frames, player } = build();
    player.play();
    frames.step(16);
    frames.step(16);
    const before = player.state().units;
    player.setSpeed(4);
    assert.equal(player.state().units, before);
    assert.equal(player.state().speed, 4);
  });

  it('clamps a stall instead of jumping the film', () => {
    const { frames, player } = build(100);
    player.play();
    frames.step(16);
    frames.step(5000);
    assert.ok(Math.abs(player.state().units - MAX_REAL_STEP_MS / 1000) < 1e-9);
  });

  it('picks the clock up again after the tab comes back', () => {
    const { frames, player } = build(100);
    player.play();
    frames.step(16);
    player.resetClock();
    const before = player.state().units;
    frames.step(3000);
    assert.equal(player.state().units, before, 'the frame after a reset should cost nothing');
  });

  it('toggles between playing and paused', () => {
    const { player } = build();
    player.toggle();
    assert.equal(player.state().playing, true);
    player.toggle();
    assert.equal(player.state().playing, false);
  });

  it('goes quiet once destroyed', () => {
    const { frames, painted, player } = build();
    player.play();
    frames.step(16);
    const count = painted.length;
    player.destroy();
    assert.equal(frames.cancelled.length, 1);
    frames.step(16);
    assert.equal(painted.length, count);
  });
});
