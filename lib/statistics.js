const { rangeWhere } = require('./entries');
const { distanceBetween } = require('./places');

const TOP_COUNT = 5;

// Each ranking of the statistics page, sorted on the passage figure of the same name.
const RANKINGS = ['duration', 'distance', 'averageSpeed', 'maxSpeed', 'maxWindSpeed'];

const seconds = (from, to) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);

const keepHigher = (current, candidate) =>
  candidate !== null && (current === null || candidate > current) ? candidate : current;

// Highest reading per passage, from the dense track points and the sparse
// instrument snapshots alike -- the same sources as a single passage's own
// figures (GET /entries/:id), and the same preference for true wind over apparent.
function loadPeaks(db, where, params) {
  const peaks = new Map();
  const inRange = `entry_id IN (SELECT id FROM log_entries ${where})`;
  for (const table of ['track_points', 'observations']) {
    const rows = db
      .prepare(
        `SELECT entry_id, MAX(sog) AS speed, MAX(tws) AS tws, MAX(aws) AS aws
         FROM ${table} WHERE ${inRange} GROUP BY entry_id`
      )
      .all(...params);
    for (const row of rows) {
      const peak = peaks.get(row.entry_id) ?? { speed: null, tws: null, aws: null };
      peak.speed = keepHigher(peak.speed, row.speed);
      peak.tws = keepHigher(peak.tws, row.tws);
      peak.aws = keepHigher(peak.aws, row.aws);
      peaks.set(row.entry_id, peak);
    }
  }
  return peaks;
}

function loadStops(db, where, params) {
  const stops = new Map();
  const rows = db
    .prepare(
      `SELECT entry_id, time, comment FROM events
       WHERE type = 'stopover' AND entry_id IN (SELECT id FROM log_entries ${where})
       ORDER BY entry_id, time`
    )
    .all(...params);
  for (const row of rows) {
    const list = stops.get(row.entry_id) ?? [];
    list.push(row);
    stops.set(row.entry_id, list);
  }
  return stops;
}

// A passage is cut wherever it stopped over -- a lock, a lunch anchorage kept
// within one entry (SPEC §3.1) -- and each stretch between two stops is measured
// on its own from the track. A passage that never stopped is one stretch, and
// its own distance and times stand: no track needs reading for it.
function legsOf(db, entry, stops, now) {
  if (stops.length === 0) {
    return [
      {
        entryId: entry.id,
        startTime: entry.start_time,
        endTime: entry.end_time,
        distance: entry.distance,
        duration: seconds(entry.start_time, entry.end_time ?? now),
        startPlaceName: entry.start_place_name,
        endPlaceName: entry.end_place_name
      }
    ];
  }

  const legs = stops.map((stop, index) => ({
    entryId: entry.id,
    startTime: index === 0 ? entry.start_time : null,
    endTime: stop.time,
    distance: 0,
    startPlaceName: index === 0 ? entry.start_place_name : stops[index - 1].comment,
    endPlaceName: stop.comment
  }));
  legs.push({
    entryId: entry.id,
    startTime: null,
    endTime: entry.end_time,
    distance: 0,
    startPlaceName: stops[stops.length - 1].comment,
    endPlaceName: entry.end_place_name
  });

  let leg = 0;
  let previous = null;
  const points = db
    .prepare('SELECT time, lat, lon FROM track_points WHERE entry_id = ? ORDER BY time')
    .iterate(entry.id);
  for (const point of points) {
    // A point at the very moment of a stop still belongs to the stretch that
    // ended there.
    while (leg < stops.length && point.time > stops[leg].time) {
      leg += 1;
      previous = null;
    }
    // A stretch starts when the vessel got under way again: its first point.
    legs[leg].startTime ??= point.time;
    if (previous) {
      legs[leg].distance += distanceBetween(previous, point);
    }
    previous = point;
  }

  // A stretch with no track has no distance to speak of, and no start time
  // either; it cannot be the longest.
  return legs
    .filter((candidate) => candidate.startTime !== null)
    .map((candidate) => ({
      ...candidate,
      duration: seconds(candidate.startTime, candidate.endTime ?? now)
    }));
}

// Countries reached by a departure or an arrival in the range, in order of the
// first visit. A place whose country is not known yet -- geocoding off, or not
// answered so far -- is simply not counted.
function loadCountries(db, where, params, now) {
  return db
    .prepare(
      `SELECT places.country_code AS code, MIN(visit.time) AS firstTime
       FROM (
         SELECT start_place_id AS place_id, start_time AS time FROM log_entries ${where}
         UNION ALL
         SELECT end_place_id, COALESCE(end_time, ?) FROM log_entries ${where}
       ) AS visit
       JOIN places ON places.id = visit.place_id
       WHERE places.country_code IS NOT NULL
       GROUP BY places.country_code
       ORDER BY firstTime, code`
    )
    .all(...params, now, ...params);
}

// Figures across every passage the range matches (SPEC §4.14). A passage still
// in progress counts as it stands, as in GET /entries/stats.
function getStatistics(db, { from, to, now }) {
  const { where, params } = rangeWhere({ from, to });
  const entries = db
    .prepare(`SELECT * FROM log_entries ${where} ORDER BY start_time, id`)
    .all(...params);
  const peaks = loadPeaks(db, where, params);
  const stops = loadStops(db, where, params);

  const passages = entries.map((entry) => {
    const peak = peaks.get(entry.id) ?? { speed: null, tws: null, aws: null };
    const duration = seconds(entry.start_time, entry.end_time ?? now);
    return {
      id: entry.id,
      startTime: entry.start_time,
      endTime: entry.end_time,
      startPlaceName: entry.start_place_name,
      endPlaceName: entry.end_place_name,
      startPlacePending: entry.start_place_pending === 1,
      endPlacePending: entry.end_place_pending === 1,
      distance: entry.distance,
      duration,
      averageSpeed: duration > 0 ? entry.distance / duration : null,
      maxSpeed: peak.speed,
      maxWindSpeed: peak.tws ?? peak.aws,
      maxWindApparent: peak.tws === null && peak.aws !== null
    };
  });

  const top = {};
  for (const ranking of RANKINGS) {
    top[ranking] = passages
      .filter((passage) => passage[ranking] !== null && passage[ranking] > 0)
      .sort(
        (a, b) => b[ranking] - a[ranking] || b.startTime.localeCompare(a.startTime) || b.id - a.id
      )
      .slice(0, TOP_COUNT);
  }

  let longestNonStop = null;
  for (const entry of entries) {
    for (const leg of legsOf(db, entry, stops.get(entry.id) ?? [], now)) {
      if (leg.distance > 0 && (longestNonStop === null || leg.distance > longestNonStop.distance)) {
        longestNonStop = leg;
      }
    }
  }

  return {
    count: passages.length,
    distance: passages.reduce((sum, passage) => sum + passage.distance, 0),
    duration: Math.round(passages.reduce((sum, passage) => sum + passage.duration, 0)),
    firstTime: passages[0]?.startTime ?? null,
    lastTime: passages.reduce((latest, passage) => {
      const end = passage.endTime ?? now;
      return latest === null || end > latest ? end : latest;
    }, null),
    maxSpeed: top.maxSpeed[0]?.maxSpeed ?? null,
    maxWindSpeed: top.maxWindSpeed[0]?.maxWindSpeed ?? null,
    maxWindApparent: top.maxWindSpeed[0]?.maxWindApparent ?? false,
    longestNonStop,
    countries: loadCountries(db, where, params, now),
    top
  };
}

module.exports = { getStatistics, TOP_COUNT };
