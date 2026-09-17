const {
  createDepartureForecaster,
  readForecast,
  getJson,
  utcTime
} = require('./departure-forecast');

const WEATHER_DEFAULTS = {
  weatherEnabled: true,
  weatherUrl: 'https://api.open-meteo.com/v1/forecast'
};

const TABLE = 'weather_forecasts';

// Open-Meteo variable → stored field, per service. The marine one is the
// same service as the tide (`tideUrl`). Directions keep the service's
// conventions, which are also Signal K's: wind, waves and swell are where
// they come *from*, the current where it flows *towards*.
const ATMOSPHERE = {
  wind_speed_10m: 'windSpeed',
  wind_direction_10m: 'windDirection',
  wind_gusts_10m: 'windGust',
  pressure_msl: 'pressure',
  weather_code: 'weatherCode',
  visibility: 'visibility',
  precipitation: 'precipitation',
  cloud_cover: 'cloudCover',
  temperature_2m: 'airTemperature'
};
const SEA = {
  wave_height: 'waveHeight',
  wave_direction: 'waveDirection',
  wave_period: 'wavePeriod',
  swell_wave_height: 'swellHeight',
  swell_wave_direction: 'swellDirection',
  swell_wave_period: 'swellPeriod',
  sea_surface_temperature: 'seaTemperature',
  ocean_current_velocity: 'currentSpeed',
  ocean_current_direction: 'currentDirection'
};
const FIELDS = [...Object.values(ATMOSPHERE), ...Object.values(SEA)];

// Values are converted to SI from the units each answer declares, rather than
// from what was asked for: the marine service ignores `wind_speed_unit` for
// the current, which comes in km/h.
const TO_SI = {
  'm/s': (v) => v,
  'km/h': (v) => v / 3.6,
  kn: (v) => (v * 1852) / 3600,
  mph: (v) => v * 0.44704,
  '°': (v) => (v * Math.PI) / 180,
  hPa: (v) => v * 100,
  '°C': (v) => v + 273.15,
  '°F': (v) => ((v - 32) * 5) / 9 + 273.15,
  mm: (v) => v / 1000,
  inch: (v) => v * 0.0254,
  '%': (v) => v / 100,
  m: (v) => v,
  ft: (v) => v * 0.3048,
  s: (v) => v,
  'wmo code': (v) => v
};

// { "2026-09-17T08:00:00.000Z": { windSpeed: 5.1, ... } } from one answer.
function readSeries(result, variables, into) {
  const times = result?.hourly?.time ?? [];
  const units = result?.hourly_units ?? {};
  for (const [variable, field] of Object.entries(variables)) {
    const values = result?.hourly?.[variable];
    const convert = TO_SI[units[variable]];
    if (!Array.isArray(values) || !convert) {
      continue;
    }
    times.forEach((time, index) => {
      const value = values[index];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return;
      }
      const key = utcTime(time);
      if (!into.has(key)) {
        into.set(key, {});
      }
      into.get(key)[field] = convert(value);
    });
  }
}

function createWeatherForecaster({ db, settings, userAgent, fetch = globalThis.fetch }) {
  function request(base, variables, position) {
    const endpoint = new URL(base);
    endpoint.searchParams.set('latitude', String(position.lat));
    endpoint.searchParams.set('longitude', String(position.lon));
    endpoint.searchParams.set('hourly', Object.keys(variables).join(','));
    endpoint.searchParams.set('timezone', 'UTC');
    endpoint.searchParams.set('past_days', '1');
    endpoint.searchParams.set('forecast_days', '2');
    endpoint.searchParams.set('wind_speed_unit', 'ms');
    return endpoint;
  }

  async function fetchWeather(position, signal) {
    const options = { userAgent, signal };
    const [atmosphere, sea] = await Promise.all([
      getJson(fetch, request(settings.weatherUrl, ATMOSPHERE, position), {
        ...options,
        label: 'Weather service'
      }),
      // The sea state is a complement: far from the sea it has nothing, and a
      // failure there is not worth losing the wind forecast for.
      getJson(fetch, request(settings.tideUrl, SEA, position), {
        ...options,
        label: 'Marine service'
      }).catch((error) => {
        if (signal.aborted) {
          throw error;
        }
        return null;
      })
    ]);

    const byTime = new Map();
    readSeries(atmosphere, ATMOSPHERE, byTime);
    readSeries(sea, SEA, byTime);
    return [...byTime.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, values]) => {
        const point = { time };
        for (const field of FIELDS) {
          point[field] = values[field] ?? null;
        }
        return point;
      });
  }

  return createDepartureForecaster({
    db,
    table: TABLE,
    isEnabled: () => settings.weatherEnabled,
    fetchPoints: fetchWeather
  });
}

function getWeatherForecast(db, entryId) {
  return readForecast(db, TABLE, entryId);
}

module.exports = { createWeatherForecaster, getWeatherForecast, WEATHER_DEFAULTS };
