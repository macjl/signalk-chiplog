// Playback: play, pause, scrub, change speed. It owns where the film is up to
// and nothing else — no drawing, no DOM. The frame loop is injected, so plain
// Node can drive it tick by tick.

import { advance, DEFAULT_SPEED } from './schedule.mjs';

export function createPlayer(options) {
  const {
    totalUnits,
    speed = DEFAULT_SPEED,
    onFrame,
    onStateChange,
    raf = globalThis.requestAnimationFrame,
    cancel = globalThis.cancelAnimationFrame
  } = options;

  let units = 0;
  let playing = false;
  let ended = false;
  let rate = speed;
  let handle = null;
  let last = null;

  const state = () => ({ units, playing, ended, speed: rate, totalUnits });
  const announce = () => onStateChange?.(state());
  const paint = () => onFrame?.(units, state());

  function tick(timestamp) {
    if (!playing) {
      return;
    }
    const delta = last === null ? 0 : timestamp - last;
    last = timestamp;
    const next = advance(units, delta, rate, totalUnits);
    units = next.units;
    paint();
    if (next.ended) {
      playing = false;
      ended = true;
      handle = null;
      announce();
      return;
    }
    handle = raf(tick);
  }

  function start() {
    last = null;
    handle = raf(tick);
  }

  const player = {
    state,

    play() {
      if (playing) {
        return;
      }
      // Pressing play on a finished film starts it again rather than sitting
      // on the last frame.
      if (ended || units >= totalUnits) {
        units = 0;
        ended = false;
      }
      playing = true;
      announce();
      start();
    },

    pause() {
      if (!playing) {
        return;
      }
      playing = false;
      if (handle !== null) {
        cancel?.(handle);
        handle = null;
      }
      announce();
    },

    toggle() {
      if (playing) {
        player.pause();
      } else {
        player.play();
      }
    },

    seek(to) {
      units = Math.max(0, Math.min(totalUnits, to));
      ended = false;
      paint();
      announce();
    },

    // Changing speed must not move the film: the storyboard is measured in
    // units, and only how fast they are consumed changes.
    setSpeed(next) {
      rate = next;
      announce();
    },

    // A tab that was in the background hands back a timestamp from before it
    // went away; without this the first frame after would jump.
    resetClock() {
      last = null;
    },

    destroy() {
      playing = false;
      if (handle !== null) {
        cancel?.(handle);
        handle = null;
      }
    }
  };

  return player;
}
