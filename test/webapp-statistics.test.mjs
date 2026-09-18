// Local days depend on the time zone; pin one that has daylight saving.
process.env.TZ = 'Europe/Paris';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activePreset,
  countryName,
  flagEmoji,
  presetRange,
  rangeQuery
} from '../public/js/statistics.mjs';

// A Thursday, in the middle of the month and the year.
const TODAY = new Date(2026, 8, 18);

describe('statistics period shortcuts', () => {
  it('leave both dates empty for all time', () => {
    assert.deepEqual(presetRange('all', TODAY), { from: '', to: '' });
  });

  it('cover this month and last month whole', () => {
    assert.deepEqual(presetRange('thisMonth', TODAY), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(presetRange('lastMonth', TODAY), { from: '2026-08-01', to: '2026-08-31' });
  });

  it('cover this year and last year whole', () => {
    assert.deepEqual(presetRange('thisYear', TODAY), { from: '2026-01-01', to: '2026-12-31' });
    assert.deepEqual(presetRange('lastYear', TODAY), { from: '2025-01-01', to: '2025-12-31' });
  });

  it('count twelve months back from today, today included', () => {
    assert.deepEqual(presetRange('last12Months', TODAY), { from: '2025-09-19', to: '2026-09-18' });
  });

  it('roll over the year boundary', () => {
    const january = new Date(2026, 0, 10);
    assert.deepEqual(presetRange('lastMonth', january), { from: '2025-12-01', to: '2025-12-31' });
    assert.deepEqual(presetRange('last12Months', january), {
      from: '2025-01-11',
      to: '2026-01-10'
    });
  });

  it('know February in a leap year', () => {
    const march = new Date(2028, 2, 5);
    assert.deepEqual(presetRange('lastMonth', march), { from: '2028-02-01', to: '2028-02-29' });
  });

  it('say which one the current dates are, if any', () => {
    assert.equal(activePreset('', '', TODAY), 'all');
    assert.equal(activePreset('2026-01-01', '2026-12-31', TODAY), 'thisYear');
    assert.equal(activePreset('2026-09-01', '2026-09-30', TODAY), 'thisMonth');
    assert.equal(activePreset('2026-09-02', '2026-09-30', TODAY), null);
  });
});

describe('statistics range as an API query', () => {
  it('turns local days into instants, the end being the next midnight', () => {
    const params = new URLSearchParams(rangeQuery('2026-09-01', '2026-09-30'));

    // Midnight in Paris is 22:00 UTC in September, while summer time lasts.
    assert.equal(params.get('from'), '2026-08-31T22:00:00.000Z');
    assert.equal(params.get('to'), '2026-09-30T22:00:00.000Z');
  });

  it('leaves out an open end', () => {
    assert.equal(rangeQuery('', ''), '');
    assert.deepEqual([...new URLSearchParams(rangeQuery('2026-09-01', '')).keys()], ['from']);
    assert.deepEqual([...new URLSearchParams(rangeQuery('', '2026-09-30')).keys()], ['to']);
  });
});

describe('countries', () => {
  it('draw a flag from the ISO code', () => {
    assert.equal(flagEmoji('FR'), '🇫🇷');
    assert.equal(flagEmoji('GB'), '🇬🇧');
  });

  it('draw no flag for something that is not a code', () => {
    assert.equal(flagEmoji(''), '');
    assert.equal(flagEmoji('fr'), '');
    assert.equal(flagEmoji('FRA'), '');
  });

  it('are named in the language of the page', () => {
    assert.equal(countryName('ES', 'en'), 'Spain');
    assert.equal(countryName('ES', 'fr'), 'Espagne');
  });

  it('fall back to the code for one the runtime does not know', () => {
    assert.equal(countryName('!!', 'en'), '!!');
  });
});
