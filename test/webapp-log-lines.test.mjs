import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFormatter } from '../public/js/format.mjs';
import { createTranslator } from '../public/js/i18n.mjs';
import { buildRows, describeEvent, engineHours, engineName } from '../public/js/log-lines.mjs';

const t = createTranslator('en');
const format = createFormatter({ locale: 'en', units: { knots: 'kn', nauticalMiles: 'nm' } });
const KNOT = 1852 / 3600;
const describe_ = (event, labels) => describeEvent(event, { t, format, manoeuvreLabels: labels });

describe('logbook lines', () => {
  it('describes manoeuvres, with the sail and the custom label', () => {
    assert.deepEqual(
      describe_({
        type: 'manoeuvre',
        subtype: 'sail_change',
        payload: { sail: 'genoa' },
        comment: 'Wind easing'
      }),
      {
        label: 'Sail change',
        detail: '(sail: Genoa)',
        comment: 'Wind easing',
        strokes: null,
        alarm: false
      }
    );
    assert.equal(
      describe_({ type: 'manoeuvre', subtype: 'spi_up' }, { spi_up: 'Hoist spi' }).label,
      'Hoist spi'
    );
    assert.equal(describe_({ type: 'manoeuvre', subtype: 'unknown_key' }).label, 'unknown_key');
  });

  it('describes notes, handwriting and alarms', () => {
    assert.deepEqual(describe_({ type: 'text_annotation', comment: 'Dolphins' }), {
      label: null,
      detail: 'Dolphins',
      comment: null,
      strokes: null,
      alarm: false
    });
    const strokes = [{ points: [{ x: 0, y: 0, t: 0 }] }];
    assert.equal(
      describe_({ type: 'handwritten_annotation', payload: { strokes } }).strokes,
      strokes
    );
    const raised = describe_({
      type: 'sk_alarm',
      subtype: 'notifications.mob',
      comment: 'MOB',
      payload: { state: 'emergency', message: 'MOB' }
    });
    assert.deepEqual([raised.label, raised.alarm, raised.comment], ['Alarm: MOB', true, null]);
    const annotated = describe_({
      type: 'sk_alarm',
      comment: 'Pierre recovered',
      payload: { state: 'normal', message: 'MOB' }
    });
    assert.equal(annotated.comment, 'Pierre recovered');
    const cleared = describe_({
      type: 'sk_alarm',
      subtype: 'notifications.mob',
      payload: { state: 'normal' }
    });
    assert.deepEqual([cleared.detail, cleared.alarm], ['Alarm cleared: notifications.mob', false]);
  });

  it('describes autopilot, weather and corrections', () => {
    assert.equal(
      describe_({
        type: 'autopilot',
        subtype: 'engaged',
        payload: { mode: 'compass', target: Math.PI / 2 }
      }).detail,
      'Autopilot engaged (compass 090°)'
    );
    assert.equal(
      describe_({ type: 'autopilot', subtype: 'disengaged' }).detail,
      'Autopilot disengaged'
    );
    assert.equal(
      describe_({
        type: 'weather_threshold',
        subtype: 'wind_above',
        payload: { threshold: 20 * KNOT, windSpeed: 22 * KNOT }
      }).detail,
      'Wind above 20.0 kn (average 22.0 kn)'
    );
    assert.equal(
      describe_({
        type: 'manual_correction',
        subtype: 'propulsion',
        payload: { before: { type: 'engine' }, after: { type: 'sail' } }
      }).detail,
      'Corrected: engine → sail'
    );
  });

  it('gives each engine its counter at departure and arrival and the hours run', () => {
    const hours = (value) => value * 3600;
    assert.deepEqual(
      engineHours([
        { engineRuntimes: null },
        { engineRuntimes: { port: hours(812), starboard: hours(798) } },
        { engineRuntimes: { port: hours(813.5) } },
        { engineRuntimes: { port: hours(814), starboard: hours(799.5) } }
      ]),
      [
        { engine: 'port', start: hours(812), end: hours(814), run: hours(2) },
        { engine: 'starboard', start: hours(798), end: hours(799.5), run: hours(1.5) }
      ]
    );
    assert.deepEqual(engineHours([{ engineRuntimes: null }, {}]), []);
    assert.equal(engineName('starboard', createTranslator('fr')), 'tribord');
    assert.equal(engineName('2', t), '2');
  });

  it('puts a snapshot taken for an event on the event line', () => {
    const rows = buildRows(
      [{ id: 1, time: '2026-09-13T10:00:00.000Z', type: 'manoeuvre', subtype: 'tack' }],
      [
        { id: 7, time: '2026-09-13T10:00:00.000Z', reason: 'event', sog: 3 },
        { id: 8, time: '2026-09-13T09:00:00.000Z', reason: 'periodic', sog: 2 }
      ]
    );
    assert.deepEqual(
      rows.map((row) => [row.key, row.readings?.id ?? null]),
      [
        ['reading-8', 8],
        ['event-1', 7]
      ]
    );
  });
});
