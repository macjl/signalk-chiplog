// Local days depend on the time zone; pin one that has daylight saving.
process.env.TZ = 'Europe/Paris';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  completeRange,
  monthGrid,
  monthOf,
  monthTitle,
  shiftMonth,
  weekdayLabels
} from '../public/js/calendar.mjs';

describe('calendar month grid', () => {
  it('starts on Monday, with the neighbouring months left blank', () => {
    // 1 September 2026 is a Tuesday.
    const grid = monthGrid(2026, 8);

    assert.equal(grid.length, 42);
    assert.equal(grid[0], null);
    assert.equal(grid[1], '2026-09-01');
    assert.equal(grid[30], '2026-09-30');
    assert.equal(grid[31], null);
    assert.equal(grid.filter(Boolean).length, 30);
  });

  it('starts a month that begins on a Monday in the first cell', () => {
    // 1 June 2026 is a Monday.
    assert.equal(monthGrid(2026, 5)[0], '2026-06-01');
  });

  it('has the days of a leap February, and of a month across a clock change', () => {
    assert.equal(monthGrid(2028, 1).filter(Boolean).length, 29);
    // Summer time starts on 29 March 2026: no day is lost or doubled.
    const march = monthGrid(2026, 2).filter(Boolean);
    assert.equal(march.length, 31);
    assert.equal(new Set(march).size, 31);
  });

  it('fits a month that needs six weeks', () => {
    // 1 March 2026 is a Sunday: six rows are needed to reach the 31st.
    const grid = monthGrid(2026, 2);
    assert.equal(grid[6], '2026-03-01');
    assert.equal(grid[36], '2026-03-31');
  });
});

describe('calendar navigation', () => {
  it('moves by months and by years, carrying over the year', () => {
    assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 8 }, -12), { year: 2025, month: 8 });
  });

  it('shows the month of a day', () => {
    assert.deepEqual(monthOf('2026-09-18'), { year: 2026, month: 8 });
  });

  it('names weekdays from Monday and months in the language', () => {
    assert.match(weekdayLabels('fr')[0], /^lun/);
    assert.match(weekdayLabels('en')[0], /^Mon/);
    assert.equal(weekdayLabels('en').length, 7);
    assert.equal(monthTitle('en', { year: 2026, month: 8 }), 'September 2026');
    assert.equal(monthTitle('fr', { year: 2026, month: 8 }), 'septembre 2026');
  });
});

describe('picking a range', () => {
  it('takes the two days in the order they are clicked', () => {
    assert.deepEqual(completeRange('2026-09-01', '2026-09-18'), {
      from: '2026-09-01',
      to: '2026-09-18'
    });
  });

  it('puts the earlier day first when the second click is before the first', () => {
    assert.deepEqual(completeRange('2026-09-18', '2026-09-01'), {
      from: '2026-09-01',
      to: '2026-09-18'
    });
  });

  it('makes a single day of two clicks on the same one', () => {
    assert.deepEqual(completeRange('2026-09-18', '2026-09-18'), {
      from: '2026-09-18',
      to: '2026-09-18'
    });
  });
});
