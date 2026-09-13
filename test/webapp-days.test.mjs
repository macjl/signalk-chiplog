// Local days depend on the time zone; pin one that has daylight saving.
process.env.TZ = 'Europe/Paris';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayKey, groupByDay } from '../public/js/days.mjs';

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
