// Cadence: how the film advances when it is played, and where each frame of an
// export falls. Playback follows the wall clock so a dropped frame does not
// slow the animation down; an export ignores clocks entirely, so the file comes
// out the same however fast the machine and the network are.
//
// No vendor imports, no DOM: plain Node can test this.

export const FPS = 30;

// One hour of sailing per second of video at x1 (SPEC §4.12); the storyboard
// already counts in those seconds, so a multiplier just divides them.
export const SPEEDS = [0.5, 1, 2, 4];
export const DEFAULT_SPEED = 1;

// Three minutes of video. A guard on memory more than on patience: the whole
// MP4 is held in memory until it is saved.
export const MAX_FRAMES = 5400;

// A backgrounded tab, or a burst of tile decoding, can leave several seconds
// between two animation frames. Without this the film would jump hours.
export const MAX_REAL_STEP_MS = 250;

export function videoDurationSeconds(totalUnits, speed) {
  return totalUnits / speed;
}

export function frameCount(totalUnits, speed, fps = FPS) {
  const frames = Math.round(videoDurationSeconds(totalUnits, speed) * fps);
  return Math.max(2, Math.min(MAX_FRAMES, frames));
}

// Frame 0 is the very start and the last frame the very end, so a film never
// stops a frame short of the arrival.
export function unitsAtFrame(index, totalUnits, frames) {
  return frames <= 1 ? 0 : (totalUnits * index) / (frames - 1);
}

// Counted from the index rather than accumulated: adding 1/30 up a few thousand
// times drifts by milliseconds, and the timestamps are what the container
// records.
export function frameTimeSeconds(index, fps = FPS) {
  return index / fps;
}

export function advance(units, realDeltaMs, speed, totalUnits) {
  const step = (Math.min(realDeltaMs, MAX_REAL_STEP_MS) / 1000) * speed;
  const next = units + step;
  return next >= totalUnits ? { units: totalUnits, ended: true } : { units: next, ended: false };
}
