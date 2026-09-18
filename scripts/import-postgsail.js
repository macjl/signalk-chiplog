#!/usr/bin/env node
// Imports passages exported from PostgSail into a Chiplog logbook, through its
// REST API -- so the logbook can be on another machine, such as the boat's Signal K
// server.
//
//   node scripts/import-postgsail.js <trips.geojson> --url http://boat.local:3000 --token <token>
//
// The file is PostgSail's GeoJSON export of one trip or of several: a FeatureCollection
// of Points, one per logged position, the first of each trip carrying its `trip` name
// ("Les Trois-Îlets → Anse de Fortune"). Each trip becomes one passage, sent as one
// request. A passage that overlaps one already on record is skipped, so an import can
// be run again after a failure, or over a file that partly repeats an earlier one.
//
// The API takes an administrator: pass a Signal K token with --token (or CHIPLOG_TOKEN),
// or sign in with --user and --password (or CHIPLOG_PASSWORD).
//
// PostgSail gives speeds and wind in knots, angles in degrees, temperatures in kelvin;
// the API takes Signal K units, converted here.

const fs = require('node:fs');
const { parseArgs } = require('node:util');

const PLUGIN_PATH = '/plugins/signalk-chiplog/api';
const TRIP_NAME_SEPARATOR = ' → ';
const DEFAULT_OBSERVATION_INTERVAL_MINUTES = 60;

const METRES_PER_SECOND_PER_KNOT = 1852 / 3600;
const RADIANS_PER_DEGREE = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const PASCALS_PER_HECTOPASCAL = 100;
// Anything below is a pressure PostgSail kept in hectopascals; a real one in pascals
// never is (870 hPa is the lowest ever measured at sea level).
const HECTOPASCAL_CEILING = 2000;

// PostgSail's `tanklevel` is the fuel tank, as a ratio.
const FUEL_TANK = { type: 'fuel', id: '0' };

// PostgSail's `voltage` and `stateofcharge` are the house battery's, the ratio and volts.
const HOUSE_BATTERY_ID = 'house';

const PROPULSION_OF_STATUS = { sailing: 'sail', motoring: 'engine' };

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function convert(value, factor, digits) {
  const n = number(value);
  return n === null ? null : round(n * factor, digits);
}

// A bearing, in [0, 2π).
function bearing(degrees) {
  const n = number(degrees);
  return n === null ? null : round((((n * RADIANS_PER_DEGREE) % TWO_PI) + TWO_PI) % TWO_PI, 5);
}

// A relative angle, in (-π, π], negative to port.
function relativeAngle(degrees) {
  const n = number(degrees);
  if (n === null) {
    return null;
  }
  const wrapped = ((((n + 180) % 360) + 360) % 360) - 180;
  return round((wrapped === -180 ? 180 : wrapped) * RADIANS_PER_DEGREE, 5);
}

function pressure(value) {
  const n = number(value);
  return n === null ? null : n < HECTOPASCAL_CEILING ? n * PASCALS_PER_HECTOPASCAL : n;
}

// The readings the track and the instrument snapshots have in common.
function readings(properties) {
  return {
    sog: convert(properties.speedoverground, METRES_PER_SECOND_PER_KNOT, 3),
    cog: bearing(properties.courseovergroundtrue),
    heading: bearing(properties.heading),
    twd: bearing(properties.truewinddirection),
    tws: convert(properties.truewindspeed, METRES_PER_SECOND_PER_KNOT, 3),
    awa: relativeAngle(properties.windangleapparent),
    aws: convert(properties.windspeedapparent, METRES_PER_SECOND_PER_KNOT, 3)
  };
}

function toTrackPoint(point) {
  const [lon, lat] = point.geometry.coordinates;
  return {
    time: point.time,
    lat: round(lat, 6),
    lon: round(lon, 6),
    ...readings(point.properties)
  };
}

function toObservation(point, reason) {
  const { properties } = point;
  const [lon, lat] = point.geometry.coordinates;
  return {
    time: point.time,
    reason,
    position: { lat: round(lat, 6), lon: round(lon, 6) },
    ...readings(properties),
    depth: number(properties.depth),
    pressure: pressure(properties.outsidepressure),
    airTemp: number(properties.outsidetemperature),
    waterTemp: number(properties.watertemperature)
  };
}

// Instrument snapshots the way the plugin takes them live: at departure, at arrival,
// and on the clock -- the first position in each slot of `intervalMinutes`.
function observationsOf(points, intervalMinutes) {
  const intervalMs = intervalMinutes * 60 * 1000;
  const observations = [toObservation(points[0], 'entry_start')];
  if (intervalMinutes > 0) {
    let lastSlot = Math.floor(Date.parse(points[0].time) / intervalMs);
    for (const point of points.slice(1, -1)) {
      const slot = Math.floor(Date.parse(point.time) / intervalMs);
      if (slot > lastSlot) {
        observations.push(toObservation(point, 'periodic'));
        lastSlot = slot;
      }
    }
  }
  observations.push(toObservation(points.at(-1), 'entry_end'));
  return observations;
}

// Engine and sail periods from the status of each position: a period runs until the
// next position with another status, `moored` included, which is not under way.
function propulsionOf(points) {
  const periods = [];
  let open = null;
  for (const point of points) {
    const type = PROPULSION_OF_STATUS[point.properties.status] ?? null;
    if (open && open.type !== type) {
      periods.push({ ...open, endTime: point.time });
      open = null;
    }
    if (type && !open) {
      open = { type, startTime: point.time };
    }
  }
  if (open) {
    periods.push({ ...open, endTime: points.at(-1).time });
  }
  return periods.filter((period) => period.endTime > period.startTime);
}

function tanksOf(point) {
  const level = number(point.properties.tanklevel);
  return level === null ? [] : [{ ...FUEL_TANK, level: round(level, 3) }];
}

function batteriesOf(point) {
  const voltage = number(point.properties.voltage);
  const stateOfCharge = number(point.properties.stateofcharge);
  if (voltage === null && stateOfCharge === null) {
    return [];
  }
  return [
    {
      id: HOUSE_BATTERY_ID,
      ...(voltage === null ? {} : { voltage: round(voltage, 2) }),
      ...(stateOfCharge === null ? {} : { stateOfCharge: round(stateOfCharge, 3) })
    }
  ];
}

// PostgSail names a trip "<departure> → <arrival>"; a trip renamed since has no places
// to read, and the logbook then names them from their position.
function placeNames(tripName) {
  const names = typeof tripName === 'string' ? tripName.split(TRIP_NAME_SEPARATOR) : [];
  return names.length === 2 && names.every((name) => name.trim() !== '')
    ? { startPlaceName: names[0].trim(), endPlaceName: names[1].trim() }
    : {};
}

function toPassage(trip, observationIntervalMinutes) {
  const { points } = trip;
  const first = points[0];
  const last = points.at(-1);
  const at = (point) => ({
    lat: round(point.geometry.coordinates[1], 6),
    lon: round(point.geometry.coordinates[0], 6)
  });
  return {
    label: `${trip.name ?? 'Unnamed trip'} (${first.time})`,
    startTime: first.time,
    body: {
      startTime: first.time,
      endTime: last.time,
      startPosition: at(first),
      endPosition: at(last),
      ...placeNames(trip.name),
      startTanks: tanksOf(first),
      startBatteries: batteriesOf(first),
      trackPoints: points.map(toTrackPoint),
      observations: observationsOf(points, observationIntervalMinutes),
      propulsion: propulsionOf(points)
    }
  };
}

// The passages in a PostgSail export, oldest first. A trip starts at each position that
// carries a `trip`; one with fewer than two positions has no passage to make.
function convertGeoJson(
  geojson,
  { observationIntervalMinutes = DEFAULT_OBSERVATION_INTERVAL_MINUTES } = {}
) {
  if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error('Not a GeoJSON FeatureCollection');
  }
  const positions = geojson.features
    .filter(
      (feature) =>
        feature?.geometry?.type === 'Point' &&
        Array.isArray(feature.geometry.coordinates) &&
        feature.geometry.coordinates.every((c) => Number.isFinite(c)) &&
        !Number.isNaN(Date.parse(feature.properties?.time))
    )
    .map((feature) => ({
      geometry: feature.geometry,
      properties: feature.properties,
      time: new Date(feature.properties.time).toISOString()
    }))
    .sort((a, b) => a.time.localeCompare(b.time));

  const trips = [];
  for (const position of positions) {
    if (position.properties.trip || trips.length === 0) {
      trips.push({ name: position.properties.trip?.name ?? null, points: [] });
    }
    trips.at(-1).points.push(position);
  }
  const skipped = trips.filter((trip) => trip.points.length < 2).length;
  const passages = trips
    .filter((trip) => trip.points.length >= 2)
    .map((trip) => toPassage(trip, observationIntervalMinutes));
  return { passages, skipped };
}

function apiUrlOf(url) {
  return `${url.replace(/\/+$/, '')}${PLUGIN_PATH}`;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeFailure(response, body) {
  const message = body?.error?.message ?? (typeof body === 'string' ? body.slice(0, 200) : '');
  const hint =
    response.status === 401 || response.status === 403
      ? ' -- the import needs an administrator (--token, or --user and --password)'
      : response.status === 413
        ? ' -- the server refuses a request this large'
        : '';
  return `HTTP ${response.status} ${message}${hint}`.trim();
}

async function login(url, username, password) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/signalk/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = await readJson(response);
  if (!response.ok || !body?.token) {
    throw new Error(`Sign-in failed: ${describeFailure(response, body)}`);
  }
  return body.token;
}

// Sends the passages one by one, oldest first. An overlap is not an error -- it means
// the passage is on record -- but anything else stops the import, since the next
// passage would most likely fail the same way.
async function importPassages(passages, { apiUrl, token, log = () => {} }) {
  const headers = { 'content-type': 'application/json' };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const summary = { imported: 0, alreadyThere: 0, failed: null };
  for (const [index, passage] of passages.entries()) {
    const label = `[${index + 1}/${passages.length}] ${passage.label}`;
    let response;
    let body;
    try {
      response = await fetch(`${apiUrl}/entries`, {
        method: 'POST',
        headers,
        body: JSON.stringify(passage.body)
      });
      body = await readJson(response);
    } catch (err) {
      summary.failed = `${label}: ${err.cause?.message ?? err.message}`;
      break;
    }
    if (response.ok) {
      summary.imported += 1;
      log(`${label}: imported as entry ${body.id}`);
    } else if (response.status === 409 && body?.error?.code === 'entry_overlaps') {
      summary.alreadyThere += 1;
      log(`${label}: skipped, ${body.error.message}`);
    } else {
      summary.failed = `${label}: ${describeFailure(response, body)}`;
      break;
    }
  }
  return summary;
}

const USAGE = `Usage: node scripts/import-postgsail.js <trips.geojson> --url <Signal K server> [options]

  --url <url>                    Signal K server, e.g. http://boat.local:3000 (or CHIPLOG_URL)
  --token <token>                Signal K administrator token (or CHIPLOG_TOKEN)
  --user <name>                  sign in instead of giving a token
  --password <password>          with --user (or CHIPLOG_PASSWORD)
  --observation-interval <min>   instrument snapshots along the way, on the clock (default 60; 0 for none)
  --dry-run                      show the passages found and send nothing`;

async function main(argv, env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      user: { type: 'string' },
      password: { type: 'string' },
      'observation-interval': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const url = values.url ?? env.CHIPLOG_URL;
  if (!url && !values['dry-run']) {
    console.error(`--url is required\n\n${USAGE}`);
    return 2;
  }
  const interval =
    values['observation-interval'] === undefined
      ? DEFAULT_OBSERVATION_INTERVAL_MINUTES
      : Number(values['observation-interval']);
  if (!Number.isFinite(interval) || interval < 0) {
    console.error('--observation-interval must be a number of minutes, 0 or more');
    return 2;
  }

  const { passages, skipped } = convertGeoJson(
    JSON.parse(fs.readFileSync(positionals[0], 'utf8')),
    {
      observationIntervalMinutes: interval
    }
  );
  if (skipped > 0) {
    console.log(`${skipped} trip(s) with fewer than two positions left out`);
  }
  if (passages.length === 0) {
    console.log('No passage found in the file');
    return 1;
  }
  console.log(`${passages.length} passage(s) found`);
  if (values['dry-run']) {
    for (const { label, body } of passages) {
      console.log(
        `${label}: ${body.trackPoints.length} positions, ${body.observations.length} snapshots, ` +
          `${body.propulsion.length} engine/sail periods`
      );
    }
    return 0;
  }

  const password = values.password ?? env.CHIPLOG_PASSWORD;
  if (values.user && !password) {
    console.error('--user needs --password (or CHIPLOG_PASSWORD)');
    return 2;
  }
  const token =
    values.token ??
    env.CHIPLOG_TOKEN ??
    (values.user ? await login(url, values.user, password) : undefined);
  const summary = await importPassages(passages, {
    apiUrl: apiUrlOf(url),
    token,
    log: console.log
  });
  console.log(`${summary.imported} imported, ${summary.alreadyThere} already on record`);
  if (summary.failed) {
    console.error(`Stopped at ${summary.failed}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}

module.exports = { convertGeoJson, importPassages, apiUrlOf, main };
