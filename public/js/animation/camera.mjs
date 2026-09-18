// Framing the animation: how far to zoom out for a passage, and which tiles a
// frame needs. Pure functions over numbers — no canvas, no vendor imports.

import { TILE_SIZE, worldScale, worldX, worldY } from './mercator.mjs';

export const MIN_ZOOM = 3;
export const MAX_ZOOM = 19;

// Zoom is chosen on a quarter-level grid: finer than that is invisible, and a
// coarse grid keeps the choice stable when a track grows by a point.
export const ZOOM_STEP = 0.25;

// How much of the frame the track is allowed to fill, leaving a margin so the
// boat never rides the edge.
export const FIT_FRACTION = 0.82;

// Half the side of the reference box, in degrees of latitude: the box spans
// about 32 km, which is the working scale the camera animates at. It stops a
// hop across a harbour from diving to street level (SPEC §4.12).
export const REFERENCE_HALF_SPAN_DEGREES = 0.143;

// And how far outside that working scale a long passage may pull the camera.
// Without a limit the camera backs off until the whole track fits — but it is
// centred on the boat, not on the track, so most of the frame is then empty
// water the boat crawls across. One level buys some context and no more.
export const MAX_WIDEN_LEVELS = 1;

// Bounds of a track, with its centre. Longitudes are expected already
// unwrapped (see `unwrapLongitude`), so they may sit outside [-180, 180] and
// the span stays the real one rather than a trip around the world.
export function trackBounds(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const { lat, lon } of points) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  if (minLat === Infinity) {
    return null;
  }
  return {
    minLat,
    maxLat,
    minLon,
    maxLon,
    centreLat: (minLat + maxLat) / 2,
    centreLon: (minLon + maxLon) / 2
  };
}

// A box that is square *on screen*: a degree of longitude is shorter than a
// degree of latitude away from the equator, so the longitude span is widened by
// 1 / cos(lat). The fit below then depends only on the shorter side of the
// frame, never on its aspect ratio.
export function referenceBounds({ lat, lon }, halfSpan = REFERENCE_HALF_SPAN_DEGREES) {
  const lonHalf = halfSpan / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - halfSpan,
    maxLat: lat + halfSpan,
    minLon: lon - lonHalf,
    maxLon: lon + lonHalf,
    centreLat: lat,
    centreLon: lon
  };
}

// The closest zoom at which the box still fits the frame with its margin.
export function fitZoom(bounds, options) {
  const {
    width,
    height,
    fraction = FIT_FRACTION,
    minZoom = MIN_ZOOM,
    maxZoom = MAX_ZOOM,
    step = ZOOM_STEP
  } = options;
  const dx = worldX(bounds.maxLon) - worldX(bounds.minLon);
  // y grows southwards, so the northern edge gives the smaller value.
  const dy = worldY(bounds.minLat) - worldY(bounds.maxLat);
  for (let zoom = maxZoom; zoom > minZoom; zoom -= step) {
    const scale = worldScale(zoom);
    if (dx * scale <= width * fraction && dy * scale <= height * fraction) {
      return zoom;
    }
  }
  return minZoom;
}

// The zoom a passage is animated at. The working scale is the reference box:
// a passage smaller than it is shown at that scale rather than magnified — a
// boat that never left its mooring has a zero-sized box and would otherwise
// fit at any zoom at all — and a passage larger than it may pull the camera
// back, but only so far.
export function passageZoom(bounds, options) {
  const centre = { lat: bounds.centreLat, lon: bounds.centreLon };
  const working = fitZoom(referenceBounds(centre), options);
  const whole = fitZoom(bounds, options);
  return Math.max(Math.min(whole, working), working - MAX_WIDEN_LEVELS);
}

// World pixels are measured from the track's centre rather than from the
// antimeridian: at zoom 19 absolute world coordinates reach 1.3e8, far enough
// for canvas path precision to start showing.
export function createProjection({ zoom, bounds }) {
  const scale = worldScale(zoom);
  const originX = worldX(bounds.centreLon) * scale;
  const originY = worldY(bounds.centreLat) * scale;
  return {
    zoom,
    scale,
    originX,
    originY,
    projectX: (lon) => worldX(lon) * scale - originX,
    projectY: (lat) => worldY(lat) * scale - originY
  };
}

// What to translate the canvas by to put `centre` in the middle of the frame.
// A translation leaves line widths alone, so nothing needs compensating.
export function cameraOffset(projection, centre, width, height) {
  return {
    ox: width / 2 - projection.projectX(centre.lon),
    oy: height / 2 - projection.projectY(centre.lat)
  };
}

// The tiles covering the frame, in the projection's own pixel space.
//
// `renderScale` is device pixels per frame pixel: the preview draws the very
// same frame smaller, so it should fetch coarser tiles rather than the
// export's full-resolution ones. It changes which zoom the tiles come from and
// nothing else — the framing is identical, which is what makes the preview a
// faithful preview.
export function visibleTiles(projection, centre, options) {
  const { width, height, renderScale = 1, layerMaxZoom = MAX_ZOOM } = options;
  const effectiveZoom = projection.zoom + Math.log2(renderScale);
  const tileZoom = Math.max(0, Math.min(Math.ceil(effectiveZoom), layerMaxZoom));
  const count = 2 ** tileZoom;
  // scale / count is TILE_SIZE * 2 ** (zoom - tileZoom): a tile's size in the
  // frame's own pixels, which is above TILE_SIZE when the layer ran out of
  // zoom levels and the tiles have to be blown up.
  const tilePixels = projection.scale / count;
  const centreTileX = worldX(centre.lon) * count;
  const centreTileY = worldY(centre.lat) * count;
  const halfX = width / 2 / tilePixels;
  const halfY = height / 2 / tilePixels;
  const tiles = [];
  const firstY = Math.floor(centreTileY - halfY);
  const lastY = Math.floor(centreTileY + halfY);
  const firstX = Math.floor(centreTileX - halfX);
  const lastX = Math.floor(centreTileX + halfX);
  for (let y = firstY; y <= lastY; y += 1) {
    // Above 85° N or below 85° S there is no map, only the background.
    if (y < 0 || y >= count) {
      continue;
    }
    for (let x = firstX; x <= lastX; x += 1) {
      tiles.push({
        z: tileZoom,
        x,
        y,
        // The seam is only a numbering matter; the drawing stays continuous.
        wrappedX: ((x % count) + count) % count,
        px: (x / count) * projection.scale - projection.originX,
        py: (y / count) * projection.scale - projection.originY,
        size: tilePixels
      });
    }
  }
  return { tileZoom, tilePixels, tiles };
}

export { TILE_SIZE };
