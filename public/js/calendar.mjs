// Pure helpers for the range picker's calendar: the grid of a month, moving
// between months, and how two clicks make a range. Nothing here touches the
// DOM, so tests run them under Node. Days are local `YYYY-MM-DD` keys, the
// same as a date input gives and `days.mjs` takes.

import { dayKey } from './days.mjs';

const WEEK_DAYS = 7;
// Always six rows, so the calendar does not change height from month to month.
const GRID_CELLS = 6 * WEEK_DAYS;

// The days of a month laid out Monday first, the days of the neighbouring
// months left as `null`.
export function monthGrid(year, month) {
  const leading = (new Date(year, month, 1).getDay() + 6) % WEEK_DAYS;
  return Array.from({ length: GRID_CELLS }, (_, index) => {
    const date = new Date(year, month, 1 - leading + index);
    return date.getMonth() === new Date(year, month, 1).getMonth() ? dayKey(date) : null;
  });
}

// The month `delta` months on, carrying over the year.
export function shiftMonth({ year, month }, delta) {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function monthOf(key) {
  const [year, month] = key.split('-').map(Number);
  return { year, month: month - 1 };
}

// Two clicks, in whichever order: the earlier day starts the range.
export function completeRange(anchor, day) {
  return anchor <= day ? { from: anchor, to: day } : { from: day, to: anchor };
}

export function weekdayLabels(locale) {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  // 1 January 2024 is a Monday.
  return Array.from({ length: WEEK_DAYS }, (_, index) =>
    format.format(new Date(2024, 0, 1 + index))
  );
}

export function monthTitle(locale, { year, month }) {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(year, month, 1)
  );
}
