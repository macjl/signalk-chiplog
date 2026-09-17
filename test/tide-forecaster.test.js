const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createTideForecaster, getTideForecast, TIDE_DEFAULTS } = require('../lib/tide-forecaster');
const { startServer, insertEntry } = require('./helpers');

const MINIMES = { lat: 46.1466, lon: -1.1686 };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function jsonResponse(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

// 72 hourly readings (past_days=1, forecast_days=2), a plain sine so every
// window has both a high and a low, starting at `from` (a Date, UTC midnight).
function hourlySeries(from, amplitude = 2) {
  const time = [];
  const sea_level_height_msl = [];
  for (let hour = 0; hour < 72; hour += 1) {
    time.push(new Date(from.getTime() + hour * HOUR).toISOString().slice(0, 16));
    sea_level_height_msl.push(amplitude * Math.sin((hour / 12.42) * 2 * Math.PI));
  }
  return { hourly: { time, sea_level_height_msl } };
}

describe('tide forecast', () => {
  let dataDir;
  let db;
  let requests;
  let answer;

  const settings = (overrides = {}) => ({
    ...TIDE_DEFAULTS,
    ...overrides
  });

  function forecaster(overrides) {
    return createTideForecaster({
      db,
      settings: settings(overrides),
      userAgent: 'signalk-chiplog/test',
      fetch: (url, options) => {
        requests.push({ url: new URL(url), options });
        return answer(url, options);
      }
    });
  }

  // Closed, not active: several may exist at once, and the tide forecaster
  // does not care about an entry's state, only its departure and position.
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
    db.prepare('SELECT * FROM tide_forecasts WHERE entry_id = ?').get(entryId);

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-tide-'));
    ({ db } = openDatabase(dataDir));
    requests = [];
    // Midnight UTC today, so a departure "now" falls inside past_days=1..forecast_days=2.
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    answer = () => jsonResponse(hourlySeries(new Date(todayMidnight.getTime() - 24 * HOUR)));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fetches the 24 h window from departure and saves it', async () => {
    const now = new Date();
    const id = departedEntry(now.toISOString());

    const result = await forecaster().resolveNext();

    assert.equal(result.outcome, 'fetched');
    const row = forecastRow(id);
    assert.equal(row.lat, MINIMES.lat);
    assert.equal(row.lon, MINIMES.lon);
    const points = JSON.parse(row.points);
    assert.ok(points.length >= 23 && points.length <= 25, `${points.length} points`);
    assert.ok(
      points.every((point) => {
        const time = Date.parse(point.time);
        return time >= now.getTime() && time < now.getTime() + 24 * HOUR;
      })
    );
    assert.ok(points.every((point) => typeof point.height === 'number'));

    const [{ url, options }] = requests;
    assert.equal(url.origin + url.pathname, 'https://marine-api.open-meteo.com/v1/marine');
    assert.equal(url.searchParams.get('latitude'), String(MINIMES.lat));
    assert.equal(url.searchParams.get('longitude'), String(MINIMES.lon));
    assert.equal(url.searchParams.get('hourly'), 'sea_level_height_msl');
    assert.equal(url.searchParams.get('timezone'), 'UTC');
    assert.equal(url.searchParams.get('past_days'), '1');
    assert.equal(url.searchParams.get('forecast_days'), '2');
    assert.equal(options.headers['User-Agent'], 'signalk-chiplog/test');
  });

  it('drops null readings from the service', async () => {
    const now = new Date();
    departedEntry(now.toISOString());
    const series = hourlySeries(new Date(now.getTime() - HOUR));
    series.hourly.sea_level_height_msl[1] = null;
    answer = () => jsonResponse(series);

    await forecaster().resolveNext();

    const points = JSON.parse(forecastRow(1).points);
    assert.ok(points.every((point) => point.height !== null));
  });

  it('is idle once the only recent departure already has a forecast', async () => {
    const id = departedEntry(new Date().toISOString());
    const service = forecaster();
    await service.resolveNext();
    assert.equal(requests.length, 1);

    const result = await service.resolveNext();

    assert.equal(result.outcome, 'idle');
    assert.equal(requests.length, 1, 'no second request');
    assert.ok(forecastRow(id));
  });

  it('picks the most recently departed pending entry', async () => {
    departedEntry(new Date(Date.now() - HOUR).toISOString());
    const later = departedEntry(new Date().toISOString());

    await forecaster().resolveNext();

    assert.ok(forecastRow(later));
    assert.equal(requests.length, 1);
  });

  it('ignores a departure too long ago to still be "near departure"', async () => {
    departedEntry(new Date(Date.now() - 4 * HOUR).toISOString());

    const result = await forecaster().resolveNext();

    assert.equal(result.outcome, 'idle');
    assert.equal(requests.length, 0);
  });

  it('saves an empty forecast and stops asking when the service has no data for the position', async () => {
    const id = departedEntry(new Date().toISOString());
    answer = () => jsonResponse({ hourly: { time: [], sea_level_height_msl: [] } });

    const service = forecaster();
    const first = await service.resolveNext();
    assert.equal(first.outcome, 'no_data');
    assert.deepEqual(JSON.parse(forecastRow(id).points), []);
    assert.equal(getTideForecast(db, id), null);

    const second = await service.resolveNext();
    assert.equal(second.outcome, 'idle');
    assert.equal(requests.length, 1, 'not asked again');
  });

  it('retries a network failure with a growing delay, and keeps it pending', async () => {
    const id = departedEntry(new Date().toISOString());
    answer = () => Promise.reject(new TypeError('fetch failed'));
    const service = forecaster();

    const delays = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await service.resolveNext();
      assert.equal(result.outcome, 'failed');
      delays.push(result.retryInMs / MINUTE);
    }
    assert.deepEqual(delays, [5, 10, 20, 40, 60, 60]);
    assert.equal(forecastRow(id), undefined);

    answer = () => jsonResponse(hourlySeries(new Date(Date.now() - HOUR)));
    const recovered = await service.resolveNext();
    assert.equal(recovered.outcome, 'fetched');
    assert.equal(recovered.retryInMs, 0, 'back to normal pace');
  });

  it('starts retrying afresh for a new passage, and once nothing is pending', async () => {
    const earlier = departedEntry(new Date(Date.now() - HOUR).toISOString());
    answer = () => Promise.reject(new TypeError('fetch failed'));
    const service = forecaster();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.resolveNext();
    }
    assert.equal((await service.resolveNext()).retryInMs, 60 * MINUTE);

    // A passage opening meanwhile is tried first, from the shortest delay.
    const later = departedEntry(new Date().toISOString());
    assert.equal((await service.resolveNext()).retryInMs, 5 * MINUTE);
    assert.equal((await service.resolveNext()).retryInMs, 10 * MINUTE);

    // Once nothing is left to fetch, the next passage starts afresh too.
    db.prepare('DELETE FROM log_entries WHERE id IN (?, ?)').run(earlier, later);
    assert.equal((await service.resolveNext()).outcome, 'idle');
    departedEntry(new Date().toISOString());
    assert.equal((await service.resolveNext()).retryInMs, 5 * MINUTE);
  });

  it('treats rate limiting as worth retrying, but another client error as no data', async () => {
    departedEntry(new Date().toISOString());
    answer = () => jsonResponse({}, 429);
    assert.equal((await forecaster().resolveNext()).outcome, 'failed');

    answer = () => jsonResponse({}, 400);
    assert.equal((await forecaster().resolveNext()).outcome, 'no_data');
  });

  it('does not reach the service when disabled', async () => {
    departedEntry(new Date().toISOString());

    const result = await forecaster({ tidesEnabled: false }).resolveNext();

    assert.equal(result.outcome, 'disabled');
    assert.equal(requests.length, 0);
  });

  it('abandons a fetch in flight when stopped, without writing', async () => {
    const id = departedEntry(new Date().toISOString());
    answer = (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason))
      );

    const service = forecaster();
    const lookup = service.resolveNext();
    service.stop();

    assert.equal((await lookup).outcome, 'stopped');
    assert.equal(forecastRow(id), undefined);
  });

  it('uses a self-hosted Open-Meteo instance', async () => {
    departedEntry(new Date().toISOString());

    await forecaster({ tideUrl: 'https://weather.example.internal/marine' }).resolveNext();

    assert.equal(requests[0].url.href.split('?')[0], 'https://weather.example.internal/marine');
  });

  describe('getTideForecast', () => {
    it('is null with no forecast recorded', () => {
      const id = departedEntry(new Date().toISOString());
      assert.equal(getTideForecast(db, id), null);
    });

    it('returns the position, fetch time and points once fetched', async () => {
      const id = departedEntry(new Date().toISOString());
      await forecaster().resolveNext();

      const forecast = getTideForecast(db, id);

      assert.deepEqual(forecast.position, MINIMES);
      assert.ok(forecast.fetchedAt);
      assert.equal(forecast.datum, 'msl');
      assert.ok(forecast.points.length > 0);
    });
  });
});

describe('GET /entries/:id/tide', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('returns the forecast once one has been recorded', async () => {
    const id = insertEntry(ctx.db, { start_lat: MINIMES.lat, start_lon: MINIMES.lon });
    ctx.db
      .prepare(
        `INSERT INTO tide_forecasts (entry_id, lat, lon, fetched_at, points)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        id,
        MINIMES.lat,
        MINIMES.lon,
        '2026-09-13T08:00:00.000Z',
        JSON.stringify([{ time: '2026-09-13T08:00:00.000Z', height: 1.2 }])
      );

    const { status, body } = await ctx.request('GET', `/entries/${id}/tide`);

    assert.equal(status, 200);
    assert.deepEqual(body.position, MINIMES);
    assert.equal(body.fetchedAt, '2026-09-13T08:00:00.000Z');
    assert.equal(body.datum, 'msl');
    assert.deepEqual(body.points, [{ time: '2026-09-13T08:00:00.000Z', height: 1.2 }]);
  });

  it('answers 404 with no forecast recorded, or one with no data', async () => {
    const withNone = insertEntry(ctx.db);
    const { status, body } = await ctx.request('GET', `/entries/${withNone}/tide`);
    assert.equal(status, 404);
    assert.equal(body.error.code, 'tide_not_found');

    const empty = insertEntry(ctx.db);
    ctx.db
      .prepare(
        `INSERT INTO tide_forecasts (entry_id, lat, lon, fetched_at, points) VALUES (?, ?, ?, ?, '[]')`
      )
      .run(empty, MINIMES.lat, MINIMES.lon, '2026-09-13T08:00:00.000Z');
    assert.equal((await ctx.request('GET', `/entries/${empty}/tide`)).status, 404);
  });

  it('answers 404 for an unknown entry', async () => {
    const { status, body } = await ctx.request('GET', '/entries/999/tide');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'entry_not_found');
  });

  it('is open to readonly users', async () => {
    assert.ok(
      ctx.permissions.some(
        (route) =>
          route.method === 'GET' &&
          route.path === '/api/entries/:id/tide' &&
          route.level === 'readonly'
      )
    );
  });
});
