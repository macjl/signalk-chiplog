// Web Mercator, the projection the OpenStreetMap and OpenSeaMap tiles are cut
// in. The animation draws its own map rather than animating Leaflet (SPEC
// §4.12), so it needs the projection itself. No vendor imports, no DOM: plain
// Node can test this.

export const TILE_SIZE = 256;

// Web Mercator cannot reach the poles; every slippy map cuts here, which makes
// the world a square.
export const MAX_LATITUDE = 85.05112878;

// Both axes return a fraction of the world, 0 to 1, so a zoom level is applied
// afterwards by `worldScale`. x grows eastwards, y grows *southwards* — the
// screen direction, not the compass one.
export function worldX(lon) {
  return (lon + 180) / 360;
}

export function worldY(lat) {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const phi = (clamped * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  // MAX_LATITUDE is the rounded cut-off, so it lands a few 1e-12 outside the
  // square. Left alone, that floors to tile -1 and a row of tiles goes missing.
  return Math.max(0, Math.min(1, y));
}

export function lonAt(x) {
  return x * 360 - 180;
}

export function latAt(y) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

// Pixels across the whole world at this zoom. Fractional zooms are allowed and
// meaningful: the camera picks one per passage, and tiles are then drawn from
// the next integer level up and scaled down.
export function worldScale(zoom) {
  return TILE_SIZE * 2 ** zoom;
}

// The projection is a cylinder cut at ±180°, so a track crossing the
// antimeridian would jump the width of the world between two points. Longitudes
// are unwrapped once, when a track is read, by keeping each point on the side
// its predecessor was: they may then leave [-180, 180], which every function
// here tolerates, and tile numbers are wrapped back when a URL is built.
export function unwrapLongitude(previousLon, lon) {
  return lon + 360 * Math.round((previousLon - lon) / 360);
}
