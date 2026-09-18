import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  advance,
  frameCount,
  frameTimeSeconds,
  MAX_FRAMES,
  MAX_REAL_STEP_MS,
  SPEEDS,
  unitsAtFrame,
  videoDurationSeconds
} from '../public/js/animation/schedule.mjs';
import {
  bitrateFor,
  DEFAULT_FORMAT_ID,
  formatById,
  isMp4ExportSupported,
  VIDEO_FORMATS
} from '../public/js/animation/formats.mjs';
import { MESSAGES } from '../public/js/i18n.mjs';

describe('animation cadence', () => {
  it('plays an hour of sailing in a second, and scales with the multiplier', () => {
    assert.equal(videoDurationSeconds(6, 1), 6);
    assert.equal(videoDurationSeconds(6, 0.5), 12);
    assert.equal(videoDurationSeconds(6, 2), 3);
    assert.equal(videoDurationSeconds(6, 4), 1.5);
  });

  it('offers the four multipliers, x1 among them', () => {
    assert.deepEqual(SPEEDS, [0.5, 1, 2, 4]);
  });

  it('counts the frames a film needs', () => {
    assert.equal(frameCount(6, 1), 180);
    assert.equal(frameCount(6, 2), 90);
    assert.equal(frameCount(9.5, 0.5), 570);
  });

  it('never renders fewer than two frames, nor more than the cap', () => {
    assert.equal(frameCount(0, 1), 2);
    assert.equal(frameCount(0.001, 4), 2);
    assert.equal(frameCount(100000, 1), MAX_FRAMES);
  });

  it('spreads frames from the first instant to the last', () => {
    const frames = frameCount(6, 1);
    assert.equal(unitsAtFrame(0, 6, frames), 0);
    assert.equal(unitsAtFrame(frames - 1, 6, frames), 6);
    let previous = -1;
    for (let index = 0; index < frames; index += 1) {
      const units = unitsAtFrame(index, 6, frames);
      assert.ok(units > previous, `frame ${index} did not move on`);
      previous = units;
    }
  });

  it('spaces them evenly', () => {
    const frames = frameCount(6, 1);
    const step = unitsAtFrame(1, 6, frames) - unitsAtFrame(0, 6, frames);
    for (let index = 1; index < frames; index += 1) {
      const gap = unitsAtFrame(index, 6, frames) - unitsAtFrame(index - 1, 6, frames);
      assert.ok(Math.abs(gap - step) < 1e-6, `frame ${index}`);
    }
  });

  // Accumulating 1/30 drifts; counting from the index does not.
  it('timestamps frames without drifting', () => {
    assert.equal(frameTimeSeconds(0), 0);
    assert.equal(frameTimeSeconds(30), 1);
    assert.equal(frameTimeSeconds(180), 6);
    assert.equal(frameTimeSeconds(5400), 180);
  });

  it('advances playback by the wall clock', () => {
    assert.ok(Math.abs(advance(0, 16, 1, 10).units - 0.016) < 1e-12);
    assert.ok(Math.abs(advance(0, 16, 4, 10).units - 0.064) < 1e-12);
    assert.ok(Math.abs(advance(0, 16, 0.5, 10).units - 0.008) < 1e-12);
  });

  // Without the clamp, coming back to a backgrounded tab would skip hours.
  it('clamps a long stall instead of jumping the film', () => {
    const stalled = advance(0, 5000, 1, 100);
    assert.ok(Math.abs(stalled.units - MAX_REAL_STEP_MS / 1000) < 1e-12);
    assert.equal(stalled.ended, false);
  });

  it('stops exactly at the end', () => {
    const over = advance(9.99, 1000, 4, 10);
    assert.equal(over.units, 10);
    assert.equal(over.ended, true);
    assert.equal(advance(5, 16, 1, 10).ended, false);
  });
});

describe('animation video formats', () => {
  it('offers the five shapes that were asked for', () => {
    assert.deepEqual(
      VIDEO_FORMATS.map((format) => format.id),
      ['mobile', 'portrait', 'square', 'landscape', 'widescreen']
    );
  });

  it('matches the aspect ratio each one is named for', () => {
    const expected = {
      mobile: 9 / 16,
      portrait: 3 / 4,
      square: 1,
      landscape: 4 / 3,
      widescreen: 16 / 9
    };
    for (const format of VIDEO_FORMATS) {
      const ratio = format.width / format.height;
      assert.ok(Math.abs(ratio - expected[format.id]) < 0.001, `${format.id} is ${ratio}`);
    }
  });

  it('keeps every dimension even, as H.264 needs', () => {
    for (const { id, width, height } of VIDEO_FORMATS) {
      assert.equal(width % 2, 0, `${id} width`);
      assert.equal(height % 2, 0, `${id} height`);
      assert.ok(Math.max(width, height) <= 1920, `${id} is larger than 1080p`);
      assert.equal(Math.min(width, height), 1080, `${id} should be 1080 on its short side`);
    }
  });

  it('names every format in both dictionaries', () => {
    for (const { id, labelKey } of VIDEO_FORMATS) {
      assert.ok(labelKey in MESSAGES.en, `${id}: ${labelKey} is missing from English`);
      assert.ok(labelKey in MESSAGES.fr, `${id}: ${labelKey} is missing from French`);
    }
  });

  it('finds a format by id, and falls back rather than breaking', () => {
    assert.equal(formatById('square').width, 1080);
    assert.equal(formatById(DEFAULT_FORMAT_ID).id, DEFAULT_FORMAT_ID);
    assert.equal(formatById('nonsense'), VIDEO_FORMATS[0]);
  });

  it('picks a bitrate that grows with the picture', () => {
    const wide = bitrateFor(1920, 1080);
    assert.ok(wide > 7.5e6 && wide < 8.5e6, `${wide} bits per second`);
    assert.ok(bitrateFor(1080, 1080) < wide);
    assert.equal(bitrateFor(160, 90), 2e6);
    assert.equal(bitrateFor(7680, 4320), 12e6);
  });
});

describe('video export support', () => {
  it('is absent without the WebCodecs globals', () => {
    assert.equal(isMp4ExportSupported({}), false);
    assert.equal(isMp4ExportSupported({ VideoEncoder: function () {} }), false);
  });

  it('is present with all three of them', () => {
    const browser = {
      VideoEncoder: function () {},
      VideoFrame: function () {},
      OffscreenCanvas: function () {}
    };
    assert.equal(isMp4ExportSupported(browser), true);
  });
});
