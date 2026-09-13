import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFormatter } from '../public/js/format.mjs';

const KNOT = 1852 / 3600;
const english = createFormatter({ locale: 'en', units: { knots: 'kn', nauticalMiles: 'nm' } });
const french = createFormatter({ locale: 'fr', units: { knots: 'nd', nauticalMiles: 'M' } });

describe('display formatting', () => {
  it('converts speed and distance to nautical units in the locale', () => {
    assert.equal(english.speed(6.2 * KNOT), '6.2 kn');
    assert.equal(french.speed(6.2 * KNOT), '6,2 nd');
    assert.equal(english.distance(68500), '37.0 nm');
    assert.equal(french.distance(1852 * 12.25), '12,3 M');
  });

  it('shows bearings on three digits and apparent angles signed', () => {
    assert.equal(english.bearing(Math.PI / 2), '090°');
    assert.equal(english.bearing(2 * Math.PI - 0.001), '000°');
    assert.equal(english.angle(-Math.PI / 4), '-45°');
    assert.equal(english.angle(Math.PI / 3), '+60°');
  });

  it('converts pressure, temperature and depth', () => {
    assert.equal(english.pressure(101325), '1,013 hPa');
    assert.equal(french.temperature(291.15), '18,0 °C');
    assert.equal(english.depth(12.34), '12.3 m');
  });

  it('writes durations in hours and minutes', () => {
    assert.equal(english.duration(45 * 60), '45 min');
    assert.equal(english.duration(3 * 3600 + 5 * 60), '3 h 05');
  });

  it('writes positions in degrees and decimal minutes', () => {
    assert.equal(english.position({ lat: 46.1466, lon: -1.1686 }), '46°08.80′N 001°10.12′W');
    assert.equal(english.position({ lat: -16.99999, lon: 179.5 }), '17°00.00′S 179°30.00′E');
  });

  it('leaves missing readings blank', () => {
    for (const format of [
      'speed',
      'distance',
      'bearing',
      'angle',
      'depth',
      'pressure',
      'duration'
    ]) {
      assert.equal(english[format](null), '', format);
    }
    assert.equal(english.position(null), '');
  });
});
