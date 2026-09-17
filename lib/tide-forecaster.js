const {
  createDepartureForecaster,
  readForecast,
  getJson,
  utcTime
} = require('./departure-forecast');

const TIDE_DEFAULTS = {
  tidesEnabled: true,
  tideUrl: 'https://marine-api.open-meteo.com/v1/marine'
};

// Open-Meteo's sea_level_height_msl is referenced to mean sea level, not the
// chart datum (lowest astronomical tide) nautical tide tables use -- there is
// no parameter to ask it for another datum. The gap between the two can be
// several metres and is not something to derive from a day of readings, so
// this is recorded rather than left implicit: a height here is relative sea
// level, not a substitute for a charted "hauteur d'eau".
const DATUM = 'msl';

const TABLE = 'tide_forecasts';

function createTideForecaster({ db, settings, userAgent, fetch = globalThis.fetch }) {
  async function fetchHeights(position, signal) {
    const endpoint = new URL(settings.tideUrl);
    endpoint.searchParams.set('latitude', String(position.lat));
    endpoint.searchParams.set('longitude', String(position.lon));
    endpoint.searchParams.set('hourly', 'sea_level_height_msl');
    endpoint.searchParams.set('timezone', 'UTC');
    endpoint.searchParams.set('past_days', '1');
    endpoint.searchParams.set('forecast_days', '2');

    const result = await getJson(fetch, endpoint, { userAgent, signal, label: 'Tide service' });
    const times = result?.hourly?.time ?? [];
    const heights = result?.hourly?.sea_level_height_msl ?? [];
    return times
      .map((time, index) => ({ time: utcTime(time), height: heights[index] }))
      .filter((point) => typeof point.height === 'number' && Number.isFinite(point.height));
  }

  return createDepartureForecaster({
    db,
    table: TABLE,
    isEnabled: () => settings.tidesEnabled,
    fetchPoints: fetchHeights
  });
}

function getTideForecast(db, entryId) {
  const forecast = readForecast(db, TABLE, entryId);
  if (!forecast) {
    return null;
  }
  return {
    position: forecast.position,
    fetchedAt: forecast.fetchedAt,
    datum: DATUM,
    points: forecast.points
  };
}

module.exports = { createTideForecaster, getTideForecast, TIDE_DEFAULTS };
