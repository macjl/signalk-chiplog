const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const {
  createWeatherForecaster,
  getWeatherForecast,
  WEATHER_DEFAULTS
} = require('../lib/weather-forecaster');
const { TIDE_DEFAULTS } = require('../lib/tide-forecaster');
const { startServer, insertEntry } = require('./helpers');

const MINIMES = { lat: 46.1466, lon: -1.1686 };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function jsonResponse(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

// 72 hourly readings (past_days=1, forecast_days=2) from `from`, with the
// units Open-Meteo declares; a constant value per variable is enough here.
function series(from, units, values) {
  const hourly = { time: [] };
  for (let hour = 0; hour < 72; hour += 1) {
    hourly.time.push(new Date(from + hour * HOUR).toISOString().slice(0, 16));
  }
  for (const [variable, value] of Object.entries(values)) {
    hourly[variable] = hourly.time.map(() => value);
  }
  return { hourly_units: { time: 'iso8601', ...units }, hourly };
}

const ATMOSPHERE_UNITS = {
  wind_speed_10m: 'm/s',
  wind_direction_10m: '°',
  wind_gusts_10m: 'm/s',
  pressure_msl: 'hPa',
  weather_code: 'wmo code',
  visibility: 'm',
  precipitation: 'mm',
  cloud_cover: '%',
  temperature_2m: '°C'
};
const ATMOSPHERE_VALUES = {
  wind_speed_10m: 7,
  wind_direction_10m: 225,
  wind_gusts_10m: 11,
  pressure_msl: 1015,
  weather_code: 80,
  visibility: 24000,
  precipitation: 0.4,
  cloud_cover: 75,
  temperature_2m: 18
};
const SEA_UNITS = {
  wave_height: 'm',
  wave_direction: '°',
  wave_period: 's',
  swell_wave_height: 'm',
  swell_wave_direction: '°',
  swell_wave_period: 's',
  sea_surface_temperature: '°C',
  ocean_current_velocity: 'km/h',
  ocean_current_direction: '°'
};
const SEA_VALUES = {
  wave_height: 1.2,
  wave_direction: 270,
  wave_period: 7,
  swell_wave_height: 0.8,
  swell_wave_direction: 280,
  swell_wave_period: 11,
  sea_surface_temperature: 16,
  ocean_current_velocity: 1.8,
  ocean_current_direction: 90
};

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

describe('weather forecast', () => {
  let dataDir;
  let db;
  let requests;
  let atmosphere;
  let sea;

  function forecaster(overrides = {}) {
    return createWeatherForecaster({
      db,
      settings: { ...TIDE_DEFAULTS, ...WEATHER_DEFAULTS, ...overrides },
      userAgent: 'signalk-chiplog/test',
      fetch: (url, options) => {
        const parsed = new URL(url);
        requests.push({ url: parsed, options });
        return parsed.pathname.endsWith('/marine')
          ? sea(parsed, options)
          : atmosphere(parsed, options);
      }
    });
  }

  function departedEntry(startTime, position = MINIMES) {
    const endTime = new Date(Date.parse(startTime) + HOUR).toISOString();
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO log_entries (state, start_time, end_time, start_lat, start_lon, created_at, updated_at)
         VALUES ('closed', ?, ?, ?, ?, ?, ?)`
      )
      .run(startTime, endTime, position.lat, position.lon, startTime, startTime);
    return Number(lastInsertRowid);
  }

  const forecastRow = (entryId) =>
    db.prepare('SELECT * FROM weather_forecasts WHERE entry_id = ?').get(entryId);

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-weather-'));
    ({ db } = openDatabase(dataDir));
    requests = [];
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const from = todayMidnight.getTime() - 24 * HOUR;
    atmosphere = () => jsonResponse(series(from, ATMOSPHERE_UNITS, ATMOSPHERE_VALUES));
    sea = () => jsonResponse(series(from, SEA_UNITS, SEA_VALUES));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('asks both services for the departure position', async () => {
    departedEntry(new Date().toISOString());

    await forecaster().resolveNext();

    assert.equal(requests.length, 2);
    const byService = Object.fromEntries(
      requests.map(({ url, options }) => [url.origin + url.pathname, { url, options }])
    );
    const weather = byService['https://api.open-meteo.com/v1/forecast'];
    const marine = byService['https://marine-api.open-meteo.com/v1/marine'];
    assert.ok(weather && marine);
    assert.deepEqual(
      weather.url.searchParams.get('hourly').split(','),
      Object.keys(ATMOSPHERE_UNITS)
    );
    assert.deepEqual(marine.url.searchParams.get('hourly').split(','), Object.keys(SEA_UNITS));
    for (const { url, options } of [weather, marine]) {
      assert.equal(url.searchParams.get('latitude'), String(MINIMES.lat));
      assert.equal(url.searchParams.get('longitude'), String(MINIMES.lon));
      assert.equal(url.searchParams.get('timezone'), 'UTC');
      assert.equal(url.searchParams.get('past_days'), '1');
      assert.equal(url.searchParams.get('forecast_days'), '2');
      assert.equal(url.searchParams.get('wind_speed_unit'), 'ms');
      assert.equal(options.headers['User-Agent'], 'signalk-chiplog/test');
    }
  });

  it('saves the 24 h from departure, merged and converted to SI units', async () => {
    const now = Date.now();
    const id = departedEntry(new Date(now).toISOString());

    const result = await forecaster().resolveNext();

    assert.equal(result.outcome, 'fetched');
    const points = JSON.parse(forecastRow(id).points);
    assert.ok(points.length >= 23 && points.length <= 25, `${points.length} points`);
    assert.ok(
      points.every((point) => {
        const time = Date.parse(point.time);
        return time >= now && time < now + 24 * HOUR;
      })
    );
    const [point] = points;
    assert.match(point.time, /^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/);
    close(point.windSpeed, 7);
    close(point.windDirection, (225 * Math.PI) / 180);
    close(point.windGust, 11);
    close(point.pressure, 101500);
    assert.equal(point.weatherCode, 80);
    close(point.visibility, 24000);
    close(point.precipitation, 0.0004);
    close(point.cloudCover, 0.75);
    close(point.airTemperature, 291.15);
    close(point.waveHeight, 1.2);
    close(point.waveDirection, (270 * Math.PI) / 180);
    close(point.wavePeriod, 7);
    close(point.swellHeight, 0.8);
    close(point.swellDirection, (280 * Math.PI) / 180);
    close(point.swellPeriod, 11);
    close(point.seaTemperature, 289.15);
    close(point.currentSpeed, 0.5);
    close(point.currentDirection, Math.PI / 2);
  });

  it('converts from the units the service declares', async () => {
    const id = departedEntry(new Date().toISOString());
    const from = Math.floor(Date.now() / HOUR) * HOUR - 24 * HOUR;
    sea = () => jsonResponse({}, 400);
    atmosphere = () =>
      jsonResponse(
        series(
          from,
          { wind_speed_10m: 'kn', temperature_2m: '°F', visibility: 'ft' },
          { wind_speed_10m: 10, temperature_2m: 50, visibility: 1000 }
        )
      );

    await forecaster().resolveNext();

    const [point] = JSON.parse(forecastRow(id).points);
    close(point.windSpeed, 18520 / 3600);
    close(point.airTemperature, 283.15);
    close(point.visibility, 304.8);
  });

  it('keeps missing values as null, and drops hours with nothing at all', async () => {
    const id = departedEntry(new Date().toISOString());
    const from = Math.floor(Date.now() / HOUR) * HOUR - 24 * HOUR;
    const withGaps = series(from, ATMOSPHERE_UNITS, ATMOSPHERE_VALUES);
    withGaps.hourly.wind_gusts_10m = withGaps.hourly.wind_gusts_10m.map(() => null);
    for (const variable of Object.keys(ATMOSPHERE_VALUES)) {
      withGaps.hourly[variable][30] = null;
    }
    atmosphere = () => jsonResponse(withGaps);
    sea = () => jsonResponse(series(from, SEA_UNITS, { wave_height: null }));

    await forecaster().resolveNext();

    const points = JSON.parse(forecastRow(id).points);
    assert.ok(points.every((point) => point.windGust === null && point.waveHeight === null));
    assert.ok(points.every((point) => point.windSpeed !== null));
    const hour30 = new Date(from + 30 * HOUR).toISOString();
    assert.ok(!points.some((point) => point.time === hour30));
  });

  it('keeps the atmosphere when the marine service has nothing or fails', async () => {
    const inland = departedEntry(new Date().toISOString());
    sea = () => jsonResponse({ error: true, reason: 'No data' }, 400);
    assert.equal((await forecaster().resolveNext()).outcome, 'fetched');
    const [point] = JSON.parse(forecastRow(inland).points);
    close(point.windSpeed, 7);
    assert.equal(point.waveHeight, null);

    const unreachable = departedEntry(new Date().toISOString());
    sea = () => Promise.reject(new TypeError('fetch failed'));
    assert.equal((await forecaster().resolveNext()).outcome, 'fetched');
    assert.ok(forecastRow(unreachable));
  });

  it('retries when the weather service is unreachable, with a growing delay', async () => {
    const id = departedEntry(new Date().toISOString());
    const working = atmosphere;
    atmosphere = () => Promise.reject(new TypeError('fetch failed'));
    const service = forecaster();

    const delays = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await service.resolveNext();
      assert.equal(result.outcome, 'failed');
      delays.push(result.retryInMs / MINUTE);
    }
    assert.deepEqual(delays, [5, 10, 20]);
    assert.equal(forecastRow(id), undefined);

    atmosphere = working;
    assert.equal((await service.resolveNext()).outcome, 'fetched');
  });

  it('treats rate limiting as worth retrying', async () => {
    departedEntry(new Date().toISOString());
    atmosphere = () => jsonResponse({}, 429);
    assert.equal((await forecaster().resolveNext()).outcome, 'failed');
  });

  it('records no forecast, and stops asking, when neither service has data', async () => {
    const id = departedEntry(new Date().toISOString());
    atmosphere = () => jsonResponse({}, 400);
    sea = () => jsonResponse({}, 400);
    const service = forecaster();

    assert.equal((await service.resolveNext()).outcome, 'no_data');
    assert.deepEqual(JSON.parse(forecastRow(id).points), []);
    assert.equal(getWeatherForecast(db, id), null);
    assert.equal((await service.resolveNext()).outcome, 'idle');
    assert.equal(requests.length, 2, 'not asked again');
  });

  it('ignores a departure too long ago', async () => {
    departedEntry(new Date(Date.now() - 4 * HOUR).toISOString());
    assert.equal((await forecaster().resolveNext()).outcome, 'idle');
    assert.equal(requests.length, 0);
  });

  it('does not reach either service when disabled, even with tides on', async () => {
    departedEntry(new Date().toISOString());

    const result = await forecaster({ weatherEnabled: false, tidesEnabled: true }).resolveNext();

    assert.equal(result.outcome, 'disabled');
    assert.equal(requests.length, 0);
  });

  it('is independent of the tide forecast', async () => {
    const id = departedEntry(new Date().toISOString());
    db.prepare(
      `INSERT INTO tide_forecasts (entry_id, lat, lon, fetched_at, points) VALUES (?, 0, 0, ?, '[]')`
    ).run(id, new Date().toISOString());

    assert.equal((await forecaster({ tidesEnabled: false }).resolveNext()).outcome, 'fetched');
  });

  it('abandons a fetch in flight when stopped, without writing', async () => {
    const id = departedEntry(new Date().toISOString());
    const hang = (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason))
      );
    atmosphere = hang;
    sea = hang;

    const service = forecaster();
    const lookup = service.resolveNext();
    service.stop();

    assert.equal((await lookup).outcome, 'stopped');
    assert.equal(forecastRow(id), undefined);
  });

  it('uses self-hosted instances', async () => {
    departedEntry(new Date().toISOString());

    await forecaster({
      weatherUrl: 'https://weather.example.internal/v1/forecast',
      tideUrl: 'https://weather.example.internal/v1/marine'
    }).resolveNext();

    assert.deepEqual(requests.map(({ url }) => url.href.split('?')[0]).sort(), [
      'https://weather.example.internal/v1/forecast',
      'https://weather.example.internal/v1/marine'
    ]);
  });

  it('is deleted with its entry', async () => {
    const id = departedEntry(new Date().toISOString());
    await forecaster().resolveNext();
    db.prepare('DELETE FROM log_entries WHERE id = ?').run(id);
    assert.equal(forecastRow(id), undefined);
  });

  it('reads back with its position and fetch time', async () => {
    const id = departedEntry(new Date().toISOString());
    await forecaster().resolveNext();

    const forecast = getWeatherForecast(db, id);

    assert.deepEqual(forecast.position, MINIMES);
    assert.ok(forecast.fetchedAt);
    assert.ok(forecast.points.length > 0);
  });
});

describe('GET /entries/:id/weather', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  const insertForecast = (id, points) =>
    ctx.db
      .prepare(
        `INSERT INTO weather_forecasts (entry_id, lat, lon, fetched_at, points)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, MINIMES.lat, MINIMES.lon, '2026-09-13T08:00:00.000Z', JSON.stringify(points));

  it('returns the forecast once one has been recorded', async () => {
    const id = insertEntry(ctx.db, { start_lat: MINIMES.lat, start_lon: MINIMES.lon });
    const point = { time: '2026-09-13T08:00:00.000Z', windSpeed: 7, waveHeight: null };
    insertForecast(id, [point]);

    const { status, body } = await ctx.request('GET', `/entries/${id}/weather`);

    assert.equal(status, 200);
    assert.deepEqual(body, {
      position: MINIMES,
      fetchedAt: '2026-09-13T08:00:00.000Z',
      points: [point]
    });
  });

  it('answers 404 with no forecast recorded, or one with no data', async () => {
    const withNone = insertEntry(ctx.db);
    const { status, body } = await ctx.request('GET', `/entries/${withNone}/weather`);
    assert.equal(status, 404);
    assert.equal(body.error.code, 'weather_not_found');

    const empty = insertEntry(ctx.db);
    insertForecast(empty, []);
    assert.equal((await ctx.request('GET', `/entries/${empty}/weather`)).status, 404);
  });

  it('answers 404 for an unknown entry', async () => {
    const { status, body } = await ctx.request('GET', '/entries/999/weather');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'entry_not_found');
  });

  it('is open to readonly users', () => {
    assert.ok(
      ctx.permissions.some(
        (route) =>
          route.method === 'GET' &&
          route.path === '/api/entries/:id/weather' &&
          route.level === 'readonly'
      )
    );
  });
});
