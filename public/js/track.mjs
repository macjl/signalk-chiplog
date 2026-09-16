// Pure track-point helpers: no vendor imports, so plain Node can test them.

// Flattens the track GeoJSON into one object per point, position and
// instrument readings together, for the passage page's position scrubber.
export function trackPoints(track) {
  const geometry = track?.geometry;
  if (!geometry) {
    return [];
  }
  const coordinates =
    geometry.type === 'Point'
      ? [geometry.coordinates]
      : geometry.type === 'LineString'
        ? geometry.coordinates
        : [];
  const times = track.properties?.coordTimes ?? [];
  const readings = track.properties?.readings ?? [];
  return coordinates.map(([lon, lat], index) => ({
    lat,
    lon,
    time: times[index] ?? null,
    ...readings[index]
  }));
}

// The true wind angle relative to the bow (positive to starboard, like the
// apparent wind angle already published), derived from the true wind
// direction and heading rather than stored: it needs no sensor of its own.
export function trueWindAngle(twd, heading) {
  return twd === null || twd === undefined || heading === null || heading === undefined
    ? null
    : twd - heading;
}
