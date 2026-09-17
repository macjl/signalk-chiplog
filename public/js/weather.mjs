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

// Which columns a set of steps has anything to show in -- a table (the
// passage page, the PDF block) leaves out the rest: no sea state inland.
export function weatherColumns(steps) {
  const has = (fields) =>
    steps.some((step) => fields.some((field) => typeof step[field] === 'number'));
  return {
    sky: has(['weatherCode', 'precipitation']),
    wind: has(['windSpeed']),
    waves: has(['waveHeight']),
    swell: has(['swellHeight']),
    pressure: has(['pressure']),
    visibility: has(['visibility']),
    temperature: has(['airTemperature', 'seaTemperature']),
    current: has(['currentSpeed'])
  };
}

// One step as a `{ main, sub }` per column, shared by the passage page's
// table and the PDF's weather block -- only for the columns it has data for.
export function describeStepColumns(step, { t, format }) {
  const direction = (radians) => {
    const point = compassPoint(radians);
    return point ? t(`compass.${point}`) : null;
  };
  const columns = {};
  const kind = weatherKind(step.weatherCode);
  const hasRain = typeof step.precipitation === 'number' && step.precipitation > 0;
  if (kind || hasRain) {
    columns.sky = {
      main: kind ? t(`weather.kind.${kind}`) : null,
      sub: hasRain ? format.precipitation(step.precipitation) : null
    };
  }
  if (typeof step.windSpeed === 'number') {
    const force = beaufort(step.windSpeed);
    columns.wind = {
      main: [
        t('weather.beaufort', { force }),
        direction(step.windDirection),
        format.speed(step.windSpeed)
      ]
        .filter(Boolean)
        .join(' '),
      sub:
        typeof step.windGust === 'number'
          ? t('weather.gust', { speed: format.speed(step.windGust) })
          : null
    };
  }
  if (typeof step.waveHeight === 'number') {
    columns.waves = {
      main: format.depth(step.waveHeight),
      sub: [format.period(step.wavePeriod), direction(step.waveDirection)].filter(Boolean).join(' ')
    };
  }
  if (typeof step.swellHeight === 'number') {
    columns.swell = {
      main: format.depth(step.swellHeight),
      sub: [format.period(step.swellPeriod), direction(step.swellDirection)]
        .filter(Boolean)
        .join(' ')
    };
  }
  if (typeof step.pressure === 'number') {
    columns.pressure = { main: format.pressure(step.pressure), sub: null };
  }
  if (typeof step.visibility === 'number') {
    columns.visibility = { main: format.distance(step.visibility), sub: null };
  }
  if (typeof step.airTemperature === 'number' || typeof step.seaTemperature === 'number') {
    columns.temperature = {
      main:
        typeof step.airTemperature === 'number' ? format.temperature(step.airTemperature) : null,
      sub:
        typeof step.seaTemperature === 'number'
          ? t('weather.lineSea', { temperature: format.temperature(step.seaTemperature) })
          : null
    };
  }
  if (typeof step.currentSpeed === 'number') {
    columns.current = {
      main: format.speed(step.currentSpeed),
      sub: direction(step.currentDirection)
    };
  }
  return columns;
}
