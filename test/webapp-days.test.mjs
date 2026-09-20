// Local days depend on the time zone; pin one that has daylight saving.
process.env.TZ = 'Europe/Paris';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { animationHash, dayKey, groupByDay, parseAnimationHash } from '../public/js/days.mjs';

const entry = (id, startTime, endTime, distance = 1000) => ({ id, startTime, endTime, distance });
const summary = (days) =>
  days.map((day) => [
    day.key,
    day.items.map((item) => [item.entry.id, item.continuesFromPreviousDay, item.continuesNextDay])
  ]);

describe('grouping passages by day', () => {
  it('uses local days, newest first', () => {
    const days = groupByDay([
      entry(1, '2026-09-12T08:00:00.000Z', '2026-09-12T12:00:00.000Z'),
      // 23:30 UTC is already the next day in Paris.
      entry(2, '2026-09-12T23:30:00.000Z', '2026-09-12T23:50:00.000Z'),
      entry(3, '2026-09-12T14:00:00.000Z', '2026-09-12T16:00:00.000Z')
    ]);

    assert.deepEqual(summary(days), [
      ['2026-09-13', [[2, false, false]]],
      [
        '2026-09-12',
        [
          [3, false, false],
          [1, false, false]
        ]
      ]
    ]);
  });

  it('shows a passage across midnight on each day it touches', () => {
    const days = groupByDay([
      entry(1, '2026-09-12T18:00:00.000Z', '2026-09-14T06:00:00.000Z', 250000)
    ]);

    assert.deepEqual(summary(days), [
      ['2026-09-14', [[1, true, false]]],
      ['2026-09-13', [[1, true, true]]],
      ['2026-09-12', [[1, false, true]]]
    ]);
    assert.deepEqual(
      days.map((day) => day.distance),
      [0, 0, 250000],
      'the distance counts on the day it started'
    );
  });

  it('does not put a passage ending exactly at midnight on the next day', () => {
    // 22:00 UTC is midnight in Paris in September.
    const days = groupByDay([entry(1, '2026-09-12T18:00:00.000Z', '2026-09-12T22:00:00.000Z')]);
    assert.deepEqual(summary(days), [['2026-09-12', [[1, false, false]]]]);
  });

  it('runs a passage in progress up to now', () => {
    const now = Date.parse('2026-09-14T10:00:00.000Z');
    const days = groupByDay([entry(1, '2026-09-13T20:00:00.000Z', null)], now);

    assert.deepEqual(summary(days), [
      ['2026-09-14', [[1, true, false]]],
      ['2026-09-13', [[1, false, true]]]
    ]);
  });

  it('keeps calendar days across the change to winter time', () => {
    // Clocks go back in Paris on 25 October 2026: that day lasts 25 hours.
    const days = groupByDay([entry(1, '2026-10-24T20:00:00.000Z', '2026-10-26T20:00:00.000Z')]);
    assert.deepEqual(
      days.map((day) => day.key),
      ['2026-10-26', '2026-10-25', '2026-10-24']
    );
  });

  it('formats day keys from local dates', () => {
    assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  });
});

describe('the animation page’s range in the address', () => {
  it('writes both ends, either one, or nothing', () => {
    assert.equal(
      animationHash('2026-09-01', '2026-09-14'),
      '#/animation?from=2026-09-01&to=2026-09-14'
    );
    assert.equal(animationHash('2026-09-01', ''), '#/animation?from=2026-09-01');
    assert.equal(animationHash('', '2026-09-14'), '#/animation?to=2026-09-14');
    assert.equal(animationHash('', ''), '#/animation');
    assert.equal(animationHash(undefined, null), '#/animation');
  });

  it('reads back what it wrote, so a reload keeps the dates', () => {
    for (const [from, to] of [
      ['2026-09-01', '2026-09-14'],
      ['2026-09-01', ''],
      ['', '2026-09-14'],
      ['', '']
    ]) {
      assert.deepEqual(parseAnimationHash(animationHash(from, to)), { from, to });
    }
  });

  it('is not the animation route for any other hash', () => {
    assert.equal(parseAnimationHash('#/statistics'), null);
    assert.equal(parseAnimationHash('#/animations'), null);
    assert.equal(parseAnimationHash(''), null);
  });

  it('leaves out anything that is not a calendar day, rather than trusting a hand-edited link', () => {
    assert.deepEqual(parseAnimationHash('#/animation?from=yesterday&to=2026-09-14'), {
      from: '',
      to: '2026-09-14'
    });
    assert.deepEqual(parseAnimationHash('#/animation?from=2026-9-1&to=<script>'), {
      from: '',
      to: ''
    });
    assert.deepEqual(parseAnimationHash('#/animation?other=1'), { from: '', to: '' });
  });
});
