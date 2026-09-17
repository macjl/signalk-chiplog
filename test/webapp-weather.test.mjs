import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFormatter } from '../public/js/format.mjs';
import { createTranslator } from '../public/js/i18n.mjs';
import {
  beaufort,
  compassPoint,
  COMPASS_POINTS,
  describeStep,
  forecastSteps,
  weatherKind
} from '../public/js/weather.mjs';

const at = (hour) => new Date(Date.UTC(2026, 8, 13, hour)).toISOString();
const KNOT = 1852 / 3600;
const degrees = (value) => (value * Math.PI) / 180;

describe('weather forecast steps', () => {
  it('keeps one row every 3 hours, with the worst of each step', () => {
    const points = Array.from({ length: 7 }, (_, hour) => ({
      time: at(8 + hour),
      windSpeed: hour,
      windGust: hour === 1 ? 20 : hour + 2,
      precipitation: hour < 3 ? 0.001 : null,
      weatherCode: hour === 2 ? 95 : 3
    }));

    const steps = forecastSteps(points, 3);

    assert.deepEqual(
      steps.map((step) => step.time),
      [at(8), at(11), at(14)]
    );
    assert.equal(steps[0].windSpeed, 0, 'readings of the first hour');
    assert.equal(steps[0].windGust, 20);
    assert.ok(Math.abs(steps[0].precipitation - 0.003) < 1e-12);
    assert.equal(steps[0].weatherCode, 95);
    assert.equal(steps[1].precipitation, null);
    assert.equal(steps[1].windGust, 7);
    assert.equal(steps[2].windGust, 8);
  });

  it('counts steps from the first hour even with hours missing', () => {
    const steps = forecastSteps([{ time: at(8) }, { time: at(12) }, { time: at(13) }], 3);
    assert.deepEqual(
      steps.map((step) => step.time),
      [at(8), at(12)]
    );
    assert.equal(steps[0].windGust, null);
    assert.equal(steps[0].weatherCode, null);
  });

  it('is empty without points', () => {
    assert.deepEqual(forecastSteps([]), []);
  });
});

describe('weather reading helpers', () => {
  it('groups WMO codes as a bulletin does', () => {
    assert.equal(weatherKind(0), 'clear');
    assert.equal(weatherKind(48), 'fog');
    assert.equal(weatherKind(63), 'rain');
    assert.equal(weatherKind(81), 'rainShowers');
    assert.equal(weatherKind(99), 'thunderstorm');
    assert.equal(weatherKind(42), 'unknown');
    assert.equal(weatherKind(null), null);
  });

  it('converts wind speed to the Beaufort scale', () => {
    assert.equal(beaufort(0), 0);
    assert.equal(beaufort(3 * KNOT), 1);
    assert.equal(beaufort(14 * KNOT), 4);
    assert.equal(beaufort(16.9 * KNOT), 5);
    assert.equal(beaufort(30 * KNOT), 7);
    assert.equal(beaufort(34 * KNOT), 8);
    assert.equal(beaufort(70 * KNOT), 12);
    assert.equal(beaufort(null), null);
  });

  it('names the nearest of 16 compass points', () => {
    assert.equal(compassPoint(0), 'N');
    assert.equal(compassPoint(degrees(225)), 'SW');
    assert.equal(compassPoint(degrees(350)), 'N');
    assert.equal(compassPoint(degrees(-90)), 'W');
    assert.equal(compassPoint(degrees(292.5)), 'WNW');
    assert.equal(compassPoint(undefined), null);
  });

  it('has every compass point in both languages', () => {
    for (const language of ['en', 'fr']) {
      const t = createTranslator(language);
      for (const point of COMPASS_POINTS) {
        assert.ok(t.has(`compass.${point}`), `${language} ${point}`);
      }
    }
    assert.equal(createTranslator('fr')('compass.WSW'), 'OSO');
  });
});

describe('a forecast step as a line of text', () => {
  const t = createTranslator('fr');
  const format = createFormatter({
    locale: 'fr',
    units: { knots: 'nd', nauticalMiles: 'M' },
    timeZone: 'Europe/Paris'
  });

  it('says everything the forecast has', () => {
    const line = describeStep(
      {
        time: at(8),
        weatherCode: 80,
        windSpeed: 14 * KNOT,
        windDirection: degrees(225),
        windGust: 22 * KNOT,
        precipitation: 0.0012,
        waveHeight: 1.2,
        wavePeriod: 7,
        waveDirection: degrees(270),
        swellHeight: 0.8,
        swellPeriod: 11,
        swellDirection: degrees(280),
        pressure: 101500,
        visibility: 24000,
        airTemperature: 291.15,
        seaTemperature: 289.15,
        currentSpeed: 0.5,
        currentDirection: degrees(45)
      },
      { t, format }
    );

    assert.equal(
      line,
      '10:00 Averses, vent SO 14,0 nd F4 (rafales 22,0 nd), pluie 1,2 mm, vagues 1,2 m 7 s O, ' +
        'houle 0,8 m 11 s O, 1 015 hPa, visibilité 13,0 M, air 18,0 °C, eau 16,0 °C, ' +
        'courant 1,0 nd vers NE'
    );
  });

  it('leaves out what it lacks, and can carry the date', () => {
    assert.equal(
      describeStep(
        { time: at(8), windSpeed: 5, precipitation: 0, currentSpeed: 0.2 },
        { t, format, withDate: true }
      ),
      '13 sept. 10:00 vent 9,7 nd F3, courant 0,4 nd'
    );
  });
});
