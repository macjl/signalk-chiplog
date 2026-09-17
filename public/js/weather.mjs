// Pure weather forecast helpers: no vendor imports, so plain Node -- and the
// PDF logbook -- can use them. Values are SI, as the API returns them.

const HOUR_MS = 60 * 60 * 1000;

// The hourly forecast cut into steps of `hours`, counted from its first point:
// each step shows its first hour's readings, with the strongest gust, the rain
// summed and the most significant sky over the whole step, so a squall between
// two rows is not lost.
export function forecastSteps(points, hours = 3) {
  if (points.length === 0) {
    return [];
  }
  const start = Date.parse(points[0].time);
  const steps = new Map();
  for (const point of points) {
    const index = Math.floor((Date.parse(point.time) - start) / (hours * HOUR_MS));
    if (!steps.has(index)) {
      steps.set(index, []);
    }
    steps.get(index).push(point);
  }
  return [...steps.values()].map((group) => {
    const values = (field) =>
      group.map((point) => point[field]).filter((value) => typeof value === 'number');
    const gusts = values('windGust');
    const rain = values('precipitation');
    const codes = values('weatherCode');
    return {
      ...group[0],
      windGust: gusts.length > 0 ? Math.max(...gusts) : null,
      precipitation: rain.length > 0 ? rain.reduce((sum, value) => sum + value, 0) : null,
      // WMO codes grow roughly with severity: clear, cloud, fog, drizzle,
      // rain, snow, showers, thunderstorm.
      weatherCode: codes.length > 0 ? Math.max(...codes) : null
    };
  });
}

// WMO weather interpretation codes, grouped as a sailor reads a bulletin.
const KINDS = [
  [[0], 'clear'],
  [[1], 'mainlyClear'],
  [[2], 'partlyCloudy'],
  [[3], 'overcast'],
  [[45, 48], 'fog'],
  [[51, 53, 55, 56, 57], 'drizzle'],
  [[61, 63, 65], 'rain'],
  [[66, 67], 'freezingRain'],
  [[71, 73, 75, 77], 'snow'],
  [[80, 81, 82], 'rainShowers'],
  [[85, 86], 'snowShowers'],
  [[95, 96, 99], 'thunderstorm']
];

export function weatherKind(code) {
  if (typeof code !== 'number') {
    return null;
  }
  return KINDS.find(([codes]) => codes.includes(code))?.[1] ?? 'unknown';
}

// Upper bounds of Beaufort forces 0 to 11, in m/s.
const BEAUFORT_LIMITS = [0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];

export function beaufort(mps) {
  if (typeof mps !== 'number' || Number.isNaN(mps)) {
    return null;
  }
  const force = BEAUFORT_LIMITS.findIndex((limit) => mps < limit);
  return force === -1 ? 12 : force;
}

export const COMPASS_POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW'
];

// The nearest of the 16 compass points, as an i18n key suffix (`compass.SW`).
export function compassPoint(radians) {
  if (typeof radians !== 'number' || Number.isNaN(radians)) {
    return null;
  }
  const turns = (((radians / (2 * Math.PI)) % 1) + 1) % 1;
  return COMPASS_POINTS[Math.round(turns * 16) % 16];
}

// Degrees for a CSS rotation, or null.
export function toDegrees(radians) {
  return typeof radians === 'number' && !Number.isNaN(radians) ? (radians * 180) / Math.PI : null;
}

// One step as a line of text, for the PDF: only what the forecast has.
export function describeStep(step, { t, format, withDate = false }) {
  const direction = (radians) => {
    const point = compassPoint(radians);
    return point ? t(`compass.${point}`) : '';
  };
  const joined = (...parts) => parts.filter(Boolean).join(' ');
  const parts = [];
  const kind = weatherKind(step.weatherCode);
  if (kind) {
    parts.push(t(`weather.kind.${kind}`));
  }
  if (typeof step.windSpeed === 'number') {
    const force = beaufort(step.windSpeed);
    parts.push(
      joined(
        t('weather.lineWind'),
        direction(step.windDirection),
        format.speed(step.windSpeed),
        t('weather.beaufortShort', { force }),
        typeof step.windGust === 'number' &&
          `(${t('weather.gust', { speed: format.speed(step.windGust) })})`
      )
    );
  }
  if (typeof step.precipitation === 'number' && step.precipitation > 0) {
    parts.push(t('weather.lineRain', { amount: format.precipitation(step.precipitation) }));
  }
  if (typeof step.waveHeight === 'number') {
    parts.push(
      joined(
        t('weather.lineWaves', { height: format.depth(step.waveHeight) }),
        format.period(step.wavePeriod),
        direction(step.waveDirection)
      )
    );
  }
  if (typeof step.swellHeight === 'number') {
    parts.push(
      joined(
        t('weather.lineSwell', { height: format.depth(step.swellHeight) }),
        format.period(step.swellPeriod),
        direction(step.swellDirection)
      )
    );
  }
  if (typeof step.pressure === 'number') {
    parts.push(format.pressure(step.pressure));
  }
  if (typeof step.visibility === 'number') {
    parts.push(t('weather.lineVisibility', { distance: format.distance(step.visibility) }));
  }
  if (typeof step.airTemperature === 'number') {
    parts.push(t('weather.lineAir', { temperature: format.temperature(step.airTemperature) }));
  }
  if (typeof step.seaTemperature === 'number') {
    parts.push(t('weather.lineSea', { temperature: format.temperature(step.seaTemperature) }));
  }
  if (typeof step.currentSpeed === 'number') {
    const towards = direction(step.currentDirection);
    parts.push(
      joined(
        t('weather.lineCurrent', { speed: format.speed(step.currentSpeed) }),
        towards && t('weather.towards', { direction: towards })
      )
    );
  }
  const when = withDate
    ? `${format.shortDate(step.time)} ${format.time(step.time)}`
    : format.time(step.time);
  return `${when} ${parts.join(', ')}`;
}
