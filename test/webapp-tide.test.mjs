import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { smoothPath, tideExtremes } from '../public/js/tide.mjs';

const at = (hour) => `2026-09-13T${String(hour).padStart(2, '0')}:00:00.000Z`;

describe('tide extremes', () => {
  it('finds each high and low in a semi-diurnal curve', () => {
    const heights = [1, 2, 3, 4, 3, 2, 1, 0, -1, -2, -1, 0, 1];
    const points = heights.map((height, hour) => ({ time: at(hour), height }));

    const extremes = tideExtremes(points);

    assert.deepEqual(
      extremes.map((e) => [e.type, e.time, e.height]),
      [
        ['high', at(3), 4],
        ['low', at(9), -2]
      ]
    );
  });

  it('finds nothing in a monotonic run', () => {
    const points = [0, 1, 2, 3].map((height, hour) => ({ time: at(hour), height }));
    assert.deepEqual(tideExtremes(points), []);
  });

  it('needs at least three points to have an interior one', () => {
    assert.deepEqual(tideExtremes([]), []);
    assert.deepEqual(tideExtremes([{ time: at(0), height: 1 }]), []);
    assert.deepEqual(
      tideExtremes([
        { time: at(0), height: 1 },
        { time: at(1), height: 2 }
      ]),
      []
    );
  });

  it('misses an extreme exactly at either end of the window', () => {
    // Peaks right at the start and end, with nothing to compare against there.
    const heights = [4, 3, 2, 1, 2, 3, 4];
    const points = heights.map((height, hour) => ({ time: at(hour), height }));
    assert.deepEqual(
      tideExtremes(points).map((e) => e.time),
      [at(3)]
    );
  });
});

describe('smooth path', () => {
  it('draws a plain move for a single point', () => {
    assert.equal(smoothPath([{ x: 1, y: 2 }]), 'M 1 2');
  });

  it('draws a line for two points', () => {
    assert.equal(
      smoothPath([
        { x: 0, y: 0 },
        { x: 10, y: 5 }
      ]),
      'M 0 0 L 10 5'
    );
  });

  it('draws a quadratic segment per interior point, ending exactly at the last point', () => {
    const coords = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
      { x: 30, y: 10 }
    ];

    const d = smoothPath(coords);

    assert.match(d, /^M 0 0/);
    assert.equal((d.match(/Q/g) ?? []).length, 2);
    assert.match(d, /30 10$/, 'ends exactly at the last point');
  });

  it('is empty with no points', () => {
    assert.equal(smoothPath([]), '');
  });
});
