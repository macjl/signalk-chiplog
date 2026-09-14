import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFormatter } from '../public/js/format.mjs';
import { createTranslator } from '../public/js/i18n.mjs';
import { fallbackMessage } from '../public/js/status.mjs';

const t = createTranslator('en');
const format = createFormatter({ locale: 'en', units: { knots: 'kn', nauticalMiles: 'nm' } });

describe('fallback message', () => {
  it('suggests signalk-autostate only when no navigation.state is published', () => {
    assert.match(fallbackMessage({ reason: 'absent' }, t, format), /install signalk-autostate/);
    assert.match(fallbackMessage(null, t, format), /install signalk-autostate/);
  });

  it('names the value and the source hiding it', () => {
    const message = fallbackMessage(
      { reason: 'unrecognised', source: 'nmea0183.AI', value: 'default', updatedAt: null },
      t,
      format
    );
    assert.match(message, /“default” \(from nmea0183\.AI\)/);
    assert.doesNotMatch(message, /install/);
  });

  it('says since when a state has not been refreshed, or that autostate is starting', () => {
    const stale = fallbackMessage(
      {
        reason: 'stale',
        source: 'signalk-autostate.XX',
        value: 'moored',
        updatedAt: '2026-09-13T08:00:00.000Z'
      },
      t,
      format
    );
    assert.match(stale, /signalk-autostate\.XX has not been updated since .+/);
    assert.match(fallbackMessage({ reason: 'pending' }, t, format), /first decision/);
  });
});
