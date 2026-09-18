// Pure helpers for the statistics page: the period shortcuts and how a country
// is shown. Nothing here touches the DOM, so tests run them under Node.

import { dayKey, rangeBoundary } from './days.mjs';

export const RANGE_PRESETS = [
  'all',
  'thisMonth',
  'lastMonth',
  'last12Months',
  'thisYear',
  'lastYear'
];

// The calendar days a shortcut stands for, as the `YYYY-MM-DD` values of a date
// input, both ends included. "All" is an open range: two empty inputs.
export function presetRange(preset, today = new Date()) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const day = (y, m, d) => dayKey(new Date(y, m, d));

  switch (preset) {
    case 'thisMonth':
      return { from: day(year, month, 1), to: day(year, month + 1, 0) };
    case 'lastMonth':
      return { from: day(year, month - 1, 1), to: day(year, month, 0) };
    // A full year back from today, today included.
    case 'last12Months':
      return { from: day(year - 1, month, today.getDate() + 1), to: dayKey(today) };
    case 'thisYear':
      return { from: day(year, 0, 1), to: day(year, 11, 31) };
    case 'lastYear':
      return { from: day(year - 1, 0, 1), to: day(year - 1, 11, 31) };
    default:
      return { from: '', to: '' };
  }
}

// The shortcut whose days are exactly these, if any -- to show which one is on.
export function activePreset(from, to, today = new Date()) {
  return (
    RANGE_PRESETS.find((preset) => {
      const range = presetRange(preset, today);
      return range.from === from && range.to === to;
    }) ?? null
  );
}

// What the API takes for a range picked as calendar days: `to` is exclusive, so
// the last day goes up to the following midnight (local time, like the log).
export function rangeQuery(from, to) {
  const params = new URLSearchParams();
  if (from) {
    params.set('from', rangeBoundary(from).toISOString());
  }
  if (to) {
    params.set('to', rangeBoundary(to, 1).toISOString());
  }
  return params.toString();
}

// A flag is the two regional-indicator letters of the ISO code; a platform with
// no flag emoji (Windows) draws the letters, which the name beside it explains.
export function flagEmoji(code) {
  return /^[A-Z]{2}$/.test(code)
    ? String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
    : '';
}

export function countryName(code, language) {
  try {
    return new Intl.DisplayNames([language], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
