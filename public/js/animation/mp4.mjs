// Encoding the animation to an MP4, in the browser and nowhere else.
//
// This is the only module that reaches into vendor/, and it is imported lazily
// — a reader who never exports never downloads the encoder. Mediabunny covers
// both halves of the job: WebCodecs on one side, the MP4 container on the
// other, with `source.add()` applying the encoder's own backpressure.

import {
  BufferTarget,
  CanvasSource,
  canEncodeVideo,
  Mp4OutputFormat,
  Output
} from '../../vendor/mediabunny.min.mjs';
import { bitrateFor } from './formats.mjs';
import { FPS, frameTimeSeconds } from './schedule.mjs';

// A keyframe every couple of seconds: enough to scrub, cheap enough not to
// bloat a short clip.
const KEYFRAME_INTERVAL_SECONDS = 2;

// How often the page is given back to the browser, so the progress bar moves
// and the cancel button can be pressed.
const YIELD_EVERY = 5;

export async function canEncodeThisVideo(width, height) {
  try {
    return await canEncodeVideo('avc', { width, height });
  } catch {
    return false;
  }
}

// `drawFrame(index)` paints frame `index` onto the canvas it was given. It is
// called exactly `frames` times, in order, and may await its map tiles: the
// film is then the same however slow the connection was — a real render, not a
// screen recording.
export async function encodeAnimation(options) {
  const { width, height, frames, drawFrame, fps = FPS, signal, onProgress } = options;

  const canvas = new OffscreenCanvas(width, height);
  // No transparency: the map fills the frame, and an opaque context is faster.
  const context = canvas.getContext('2d', { alpha: false });

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget()
  });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: bitrateFor(width, height, fps),
    keyFrameInterval: KEYFRAME_INTERVAL_SECONDS
  });
  output.addVideoTrack(source, { frameRate: fps });

  await output.start();
  try {
    for (let index = 0; index < frames; index += 1) {
      signal?.throwIfAborted();
      await drawFrame(index, context);
      // Resolves once the encoder is ready for more: this is the backpressure,
      // and why nothing here counts an encode queue.
      await source.add(frameTimeSeconds(index, fps), 1 / fps);
      if (index % YIELD_EVERY === 0) {
        onProgress?.({ phase: 'frames', done: index + 1, total: frames });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  } catch (error) {
    await output.cancel();
    throw error;
  }

  onProgress?.({ phase: 'frames', done: frames, total: frames });
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
