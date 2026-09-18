// Where a position is, read against the nearest amer, the way a logbook gives
// one: "1.2 nm NE (053°) — Phare du Cap-Ferret" means the boat is that far and
// in that direction *from* the landmark (SPEC §4.13). Pure -- the PDF logbook
// imports it too -- so strings only, no markup and no vendor imports.

const METRES_PER_NM = 1852;

// The same value and formula as `distanceBetween` in lib/places.js.
const EARTH_RADIUS_M = 6371008.8;

// How far out an amer of each kind still says something useful about where the
// boat is: a major light carries for miles, a harbour only places you inside
// it. The largest is MAX_RELEVANT_M in lib/landmarks.js, which sizes the area
// landmarks are fetched for -- a test keeps the two in step.
export const KIND_RANGE_M = {
  lighthouse: 15 * METRES_PER_NM,
  landmark: 8 * METRES_PER_NM,
  cape: 6 * METRES_PER_NM,
  light: 4 * METRES_PER_NM,
  harbour: 3 * METRES_PER_NM,
  beacon: 2 * METRES_PER_NM
};

// Within this, the boat is at the landmark rather than off it: a bearing from
// the harbour you are moored in would be noise.
const ALONGSIDE_M = 30;

// Clockwise from north, as the compass rose reads; the keys are i18n keys.
const COMPASS_POINTS = [
  'n',
  'nne',
  'ne',
  'ene',
  'e',
  'ese',
  'se',
  'sse',
  's',
  'ssw',
  'sw',
  'wsw',
  'w',
  'wnw',
  'nw',
  'nnw'
];

const toRadians = (degrees) => (degrees * Math.PI) / 180;

export function distanceMetres(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The initial great-circle bearing from one position to another, in radians
// clockwise from true north -- what a hand bearing compass would read.
export function bearingRadians(from, to) {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLon = toRadians(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = Math.atan2(y, x);
  return (bearing + 2 * Math.PI) % (2 * Math.PI);
}

// The i18n key of the compass point a bearing falls in, to sixteenths.
export function compassPoint(radians) {
  const sixteenths = Math.round((radians / (2 * Math.PI)) * 16);
  return COMPASS_POINTS[((sixteenths % 16) + 16) % 16];
}

// How far a given landmark is worth naming a position from: its light's range
// when OpenStreetMap gives one -- a harbour light seen for 4 miles should not
// be quoted from ten -- but never further than its kind carries.
export function relevantRange(landmark) {
  const kindRange = KIND_RANGE_M[landmark.kind] ?? KIND_RANGE_M.harbour;
  return landmark.lightRange ? Math.min(landmark.lightRange, kindRange) : kindRange;
}

// The amer a position is best read against: of those in range, the one closest
// *relative to its own range*, so a lighthouse three miles off wins over a
// harbour half a mile away -- which is how a position is given at sea.
export function nearestLandmark(position, landmarks = []) {
  if (!position) {
    return null;
  }
  let best = null;
  for (const landmark of landmarks) {
    const distance = distanceMetres(landmark.position, position);
    const range = relevantRange(landmark);
    if (distance > range) {
      continue;
    }
    const score = distance / range;
    if (!best || score < best.score || (score === best.score && distance < best.distance)) {
      best = {
        landmark,
        distance,
        bearing: bearingRadians(landmark.position, position),
        score
      };
    }
  }
  return best;
}

// The line shown under a position, or null when no amer is near enough (the
// open sea, or an area whose landmarks have not been fetched).
export function landmarkLine(position, landmarks, { t, format }) {
  const fix = nearestLandmark(position, landmarks);
  if (!fix) {
    return null;
  }
  if (fix.distance < ALONGSIDE_M) {
    return fix.landmark.name;
  }
  return t('landmark.bearing', {
    distance: format.shortDistance(fix.distance),
    cardinal: t(`compass.${compassPoint(fix.bearing)}`),
    bearing: format.bearing(fix.bearing),
    name: fix.landmark.name
  });
}
