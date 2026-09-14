// Rendering for human-facing exports. This is the presentation layer the data
// model defers unit conversion to: the database stays in Signal K SI units.

const KNOTS_PER_MPS = 3600 / 1852;
const METRES_PER_NM = 1852;

function convert(value, fn, digits) {
  return value === null || value === undefined ? null : Number(fn(value).toFixed(digits));
}

const radiansToDegrees = (rad) => (rad * 180) / Math.PI;
const wrap360 = (degrees) => ((degrees % 360) + 360) % 360;

const toKnots = (value) => convert(value, (mps) => mps * KNOTS_PER_MPS, 1);

function toBearing(value) {
  const degrees = convert(value, (rad) => wrap360(radiansToDegrees(rad)), 0);
  return degrees === 360 ? 0 : degrees;
}

const toSignedAngle = (value) =>
  convert(value, (rad) => wrap360(radiansToDegrees(rad) + 180) - 180, 0);
const toHectopascals = (value) => convert(value, (pa) => pa / 100, 1);
const toCelsius = (value) => convert(value, (k) => k - 273.15, 1);
const toNauticalMiles = (value) => convert(value, (m) => m / METRES_PER_NM, 1);
const toHours = (value) => convert(value, (s) => s / 3600, 1);
const toMetres = (value) => convert(value, (m) => m, 1);
const toCoordinate = (value) => convert(value, (deg) => deg, 6);

function toGeoJson(entry, trackPoints) {
  const coordinates = trackPoints.map((point) => [point.lon, point.lat]);
  let geometry = null;
  if (coordinates.length === 1) {
    geometry = { type: 'Point', coordinates: coordinates[0] };
  } else if (coordinates.length > 1) {
    geometry = { type: 'LineString', coordinates };
  }
  return {
    type: 'Feature',
    geometry,
    properties: {
      entryId: entry.id,
      startTime: entry.startTime,
      endTime: entry.endTime,
      startPlaceName: entry.startPlaceName,
      endPlaceName: entry.endPlaceName,
      coordTimes: trackPoints.map((point) => point.time)
    }
  };
}

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => XML_ESCAPES[char]);
}

function trackName(entry) {
  const places = [entry.startPlaceName, entry.endPlaceName].filter(Boolean).join(' - ');
  return places || `Passage of ${entry.startTime.slice(0, 10)}`;
}

function toGpx(bundles) {
  const tracks = bundles.map(({ entry, trackPoints }) => {
    const points = trackPoints
      .map(
        (point) =>
          `      <trkpt lat="${point.lat}" lon="${point.lon}"><time>${point.time}</time></trkpt>`
      )
      .join('\n');
    return [
      '  <trk>',
      `    <name>${escapeXml(trackName(entry))}</name>`,
      '    <trkseg>',
      points,
      '    </trkseg>',
      '  </trk>'
    ]
      .filter((line) => line !== '')
      .join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="signalk-chiplog" xmlns="http://www.topografix.com/GPX/1/1">',
    ...tracks,
    '</gpx>',
    ''
  ].join('\n');
}

const CSV_COLUMNS = [
  'entry_id',
  'time_utc',
  'kind',
  'type',
  'subtype',
  'place',
  'lat',
  'lon',
  'sog_kn',
  'cog_deg',
  'heading_deg',
  'stw_kn',
  'tws_kn',
  'twd_deg',
  'aws_kn',
  'awa_deg',
  'depth_m',
  'pressure_hpa',
  'air_temp_c',
  'water_temp_c',
  'trip_log_nm',
  'engine_runtime_h',
  'comment'
];

// One engine_runtime_<engine>_h column per engine found in the export, after
// the fixed columns, so a spreadsheet keeps each engine's counter apart.
function engineColumn(id) {
  return `engine_runtime_${String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')}_h`;
}

const KIND_ORDER = { departure: 0, observation: 1, event: 2, arrival: 3 };

function csvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  // Spreadsheets execute cells starting with these characters as formulas;
  // comments and place names are free text typed by the crew.
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function positionColumns(position) {
  return {
    lat: toCoordinate(position?.lat),
    lon: toCoordinate(position?.lon)
  };
}

// One chronological line per departure, observation, event and arrival: the
// shape of a paper logbook, readable without the plugin.
function toCsv(bundles) {
  const rows = [];

  for (const { entry, observations, events } of bundles) {
    rows.push({
      entry_id: entry.id,
      time_utc: entry.startTime,
      kind: 'departure',
      place: entry.startPlaceName,
      ...positionColumns(entry.startPosition)
    });

    for (const observation of observations) {
      rows.push({
        entry_id: entry.id,
        time_utc: observation.time,
        kind: 'observation',
        type: observation.reason,
        ...positionColumns(observation.position),
        sog_kn: toKnots(observation.sog),
        cog_deg: toBearing(observation.cog),
        heading_deg: toBearing(observation.heading),
        stw_kn: toKnots(observation.stw),
        tws_kn: toKnots(observation.tws),
        twd_deg: toBearing(observation.twd),
        aws_kn: toKnots(observation.aws),
        awa_deg: toSignedAngle(observation.awa),
        depth_m: toMetres(observation.depth),
        pressure_hpa: toHectopascals(observation.pressure),
        air_temp_c: toCelsius(observation.airTemp),
        water_temp_c: toCelsius(observation.waterTemp),
        trip_log_nm: toNauticalMiles(observation.tripLog),
        engine_runtime_h: toHours(observation.engineRuntime),
        ...Object.fromEntries(
          Object.entries(observation.engineRuntimes ?? {}).map(([id, runtime]) => [
            engineColumn(id),
            toHours(runtime)
          ])
        )
      });
    }

    for (const event of events) {
      rows.push({
        entry_id: entry.id,
        time_utc: event.time,
        kind: 'event',
        type: event.type,
        subtype: event.subtype,
        ...positionColumns(event.position),
        comment: event.comment
      });
    }

    if (entry.endTime) {
      rows.push({
        entry_id: entry.id,
        time_utc: entry.endTime,
        kind: 'arrival',
        place: entry.endPlaceName,
        ...positionColumns(entry.endPosition)
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.time_utc.localeCompare(b.time_utc) ||
      a.entry_id - b.entry_id ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  );

  const engineColumns = [
    ...new Set(
      bundles.flatMap(({ observations }) =>
        observations.flatMap((observation) =>
          Object.keys(observation.engineRuntimes ?? {}).map(engineColumn)
        )
      )
    )
  ];
  const columns = [...CSV_COLUMNS, ...engineColumns];
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { toGeoJson, toGpx, toCsv };
