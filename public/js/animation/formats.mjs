// The shapes a video can be exported in, and what to encode it at.
//
// No vendor imports, no DOM: plain Node can test this. The encoder itself
// lives in mp4.mjs, which is the only module that reaches into vendor/ — and
// which is imported lazily, so a reader who never exports never downloads it.

import { FPS } from './schedule.mjs';

// Every dimension is even, as H.264 chroma subsampling requires, and 1080 px
// on the short side: enough for a phone screen without making the encode
// needlessly long.
export const VIDEO_FORMATS = [
  { id: 'mobile', labelKey: 'animation.format9x16', width: 1080, height: 1920 },
  { id: 'portrait', labelKey: 'animation.format3x4', width: 1080, height: 1440 },
  { id: 'square', labelKey: 'animation.format1x1', width: 1080, height: 1080 },
  { id: 'landscape', labelKey: 'animation.format4x3', width: 1440, height: 1080 },
  { id: 'widescreen', labelKey: 'animation.format16x9', width: 1920, height: 1080 }
];

export const DEFAULT_FORMAT_ID = 'widescreen';

export function formatById(id) {
  return VIDEO_FORMATS.find((format) => format.id === id) ?? VIDEO_FORMATS[0];
}

// The whole frame translates every frame — a map sliding under a fixed boat
// compresses far worse than a static scene — so this is deliberately generous.
export const BITS_PER_PIXEL_PER_FRAME = 0.13;

export function bitrateFor(width, height, fps = FPS) {
  const bitrate = width * height * fps * BITS_PER_PIXEL_PER_FRAME;
  return Math.round(Math.max(2e6, Math.min(12e6, bitrate)));
}

// Whether this browser can encode video at all. The finer question — whether
// it can encode *this* size in H.264 — is left to the encoder, which asks
// Mediabunny; keeping it to these three globals is what lets this module stay
// free of vendor imports and testable under Node.
export function isMp4ExportSupported(scope = globalThis) {
  return (
    typeof scope.VideoEncoder === 'function' &&
    typeof scope.VideoFrame === 'function' &&
    typeof scope.OffscreenCanvas === 'function'
  );
}
