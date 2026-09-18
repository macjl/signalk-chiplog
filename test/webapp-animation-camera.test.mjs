import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  latAt,
  lonAt,
  MAX_LATITUDE,
  unwrapLongitude,
  worldScale,
  worldX,
  worldY
} from '../public/js/animation/mercator.mjs';
import {
  cameraOffset,
  createProjection,
  fitZoom,
  MAX_WIDEN_LEVELS,
  MIN_ZOOM,
  MAX_ZOOM,
  passageZoom,
  referenceBounds,
  trackBounds,
  visibleTiles
} from '../public/js/animation/camera.mjs';

// La Rochelle, where the demo data sails.
const HOME = { lat: 46.1591, lon: -1.1522 };

describe('web mercator', () => {
  it('places the origin at the centre of the world square', () => {
    assert.equal(worldX(0), 0.5);
    assert.equal(worldX(-180), 0);
    assert.equal(worldX(180), 1);
    assert.equal(worldY(0), 0.5);
  });

  it('clamps the poles to the square the tiles are cut in', () => {
    assert.equal(worldY(90), worldY(MAX_LATITUDE));
    assert.equal(worldY(-90), worldY(-MAX_LATITUDE));
    assert.ok(worldY(90) >= 0 && worldY(-90) <= 1);
  });

  it('round-trips through the inverse projection', () => {
    for (const lat of [0, 45, -46.1591, 84]) {
      assert.ok(Math.abs(latAt(worldY(lat)) - lat) < 1e-9, `latitude ${lat}`);
    }
    for (const lon of [0, 12.5, -1.1522, 179]) {
      assert.ok(Math.abs(lonAt(worldX(lon)) - lon) < 1e-9, `longitude ${lon}`);
    }
  });

  it('projects a known position onto a known tile', () => {
    assert.equal(worldX(HOME.lon), 0.49679944444444446);
    assert.equal(worldY(HOME.lat), 0.3551246550414887);
    assert.equal(Math.floor(worldX(HOME.lon) * 2 ** 12), 2034);
    assert.equal(Math.floor(worldY(HOME.lat) * 2 ** 12), 1454);
  });

  it('scales continuously through fractional zooms', () => {
    assert.equal(worldScale(0), 256);
    assert.equal(worldScale(12), 1048576);
    assert.ok(Math.abs(worldScale(11.5) - worldScale(11) * Math.SQRT2) < 1e-9);
  });

  it('keeps a track on one side of the antimeridian', () => {
    // Eastbound across the seam: 179.5 then -179.5 is half a degree, not 359.
    assert.equal(unwrapLongitude(179.5, -179.5), 180.5);
    assert.equal(unwrapLongitude(-179.5, 179.5), -180.5);
    assert.equal(unwrapLongitude(12, 12.5), 12.5);
  });
});

describe('animation framing', () => {
  it('bounds a track and finds its centre', () => {
    const bounds = trackBounds([
      { lat: 46, lon: -1 },
      { lat: 46.5, lon: -2 },
      { lat: 45.5, lon: -1.5 }
    ]);
    assert.deepEqual(bounds, {
      minLat: 45.5,
      maxLat: 46.5,
      minLon: -2,
      maxLon: -1,
      centreLat: 46,
      centreLon: -1.5
    });
  });

  it('ignores points without a usable position, and has no bounds without any', () => {
    const bounds = trackBounds([
      { lat: 46, lon: -1 },
      { lat: null, lon: -2 },
      { lat: 47, lon: undefined }
    ]);
    assert.equal(bounds.maxLat, 46);
    assert.equal(trackBounds([]), null);
    assert.equal(trackBounds([{ lat: null, lon: null }]), null);
  });

  it('makes the reference box square on screen', () => {
    const box = referenceBounds(HOME);
    const latSpan = box.maxLat - box.minLat;
    const lonSpan = box.maxLon - box.minLon;
    // The box spans 0.286° of latitude, about 32 km: the working scale.
    assert.ok(Math.abs(latSpan - 2 * 0.143) < 1e-12);
    assert.ok(Math.abs(lonSpan - latSpan / Math.cos((HOME.lat * Math.PI) / 180)) < 1e-12);
    // At the equator no widening is needed.
    const equator = referenceBounds({ lat: 0, lon: 0 });
    assert.ok(Math.abs(equator.maxLon - equator.minLon - latSpan) < 1e-12);
  });

  it('fits a box to the frame, on the quarter-level grid', () => {
    const frame = { width: 1000, height: 1000 };
    const box = { minLat: -0.1, maxLat: 0.1, minLon: -0.1, maxLon: 0.1 };
    const zoom = fitZoom(box, frame);
    assert.equal(zoom % 0.25, 0);
    // Twice the span is exactly one zoom level further out.
    const wider = { minLat: -0.2, maxLat: 0.2, minLon: -0.2, maxLon: 0.2 };
    assert.equal(fitZoom(wider, frame), zoom - 1);
  });

  it('returns a fit that actually holds, and is the closest one that does', () => {
    const frame = { width: 1080, height: 1920 };
    const box = referenceBounds(HOME);
    const zoom = fitZoom(box, frame);
    const fits = (z) => {
      const scale = worldScale(z);
      return (
        (worldX(box.maxLon) - worldX(box.minLon)) * scale <= frame.width * 0.82 &&
        (worldY(box.minLat) - worldY(box.maxLat)) * scale <= frame.height * 0.82
      );
    };
    assert.ok(fits(zoom));
    assert.ok(!fits(zoom + 0.25));
  });

  it('clamps a point-sized box in and an impossible box out', () => {
    const frame = { width: 800, height: 600 };
    const point = { minLat: 46, maxLat: 46, minLon: -1, maxLon: -1 };
    assert.equal(fitZoom(point, frame), MAX_ZOOM);
    const world = { minLat: -85, maxLat: 85, minLon: -180, maxLon: 180 };
    assert.equal(fitZoom(world, frame), MIN_ZOOM);
  });

  // This is what fixes the decision that the zoom is computed from the export
  // format's size, not from the canvas the preview happens to have: the same
  // box fits at 10 on a small preview and at 11.5 at export resolution, a
  // factor of nearly three in scale.
  it('depends on the frame size, which is why the format sets it', () => {
    const box = referenceBounds(HOME);
    assert.equal(fitZoom(box, { width: 600, height: 380 }), 10);
    assert.equal(fitZoom(box, { width: 1080, height: 1920 }), 11.5);
    assert.equal(fitZoom(box, { width: 1920, height: 1080 }), 11.5);
    assert.equal(fitZoom(box, { width: 1080, height: 1080 }), 11.5);
  });

  it('shows a short hop at the working scale rather than magnifying it', () => {
    const frame = { width: 1920, height: 1080 };
    // About half a nautical mile: on its own it would frame far too close.
    const bounds = trackBounds([HOME, { lat: HOME.lat + 0.008, lon: HOME.lon + 0.008 }]);
    assert.ok(fitZoom(bounds, frame) > 16, 'the raw fit should be street level');
    assert.equal(passageZoom(bounds, frame), fitZoom(referenceBounds(HOME), frame));
  });

  // The camera is centred on the boat, not on the track, so backing off far
  // enough to fit a whole crossing leaves the boat crawling across empty water.
  it('lets a long passage widen the view, but only so far', () => {
    const frame = { width: 1920, height: 1080 };
    const working = fitZoom(referenceBounds(HOME), frame);
    // Roughly 100 nautical miles north-west.
    const bounds = trackBounds([HOME, { lat: 47.6, lon: -2.8 }]);
    const whole = fitZoom(bounds, frame);
    assert.ok(whole < working - MAX_WIDEN_LEVELS, 'the whole track would need a far wider view');
    const zoom = passageZoom(bounds, frame);
    const centre = { lat: bounds.centreLat, lon: bounds.centreLon };
    assert.equal(zoom, fitZoom(referenceBounds(centre), frame) - MAX_WIDEN_LEVELS);
    assert.ok(zoom > whole, 'should stay tighter than framing the whole track');
  });

  it('takes the track fit when it falls inside what is allowed', () => {
    const frame = { width: 1920, height: 1080 };
    const working = fitZoom(referenceBounds(HOME), frame);
    // Wide enough to pull back, not so wide that the cap bites.
    const bounds = trackBounds([HOME, { lat: HOME.lat + 0.4, lon: HOME.lon - 0.8 }]);
    const whole = fitZoom(bounds, frame);
    assert.ok(whole < working && whole > working - MAX_WIDEN_LEVELS, `track fit ${whole}`);
    assert.equal(passageZoom(bounds, frame), whole);
  });

  it('keeps every passage within one level of the working scale', () => {
    const frame = { width: 1080, height: 1080 };
    for (const span of [0, 0.001, 0.05, 0.5, 5, 40]) {
      const bounds = trackBounds([HOME, { lat: HOME.lat + span, lon: HOME.lon + span }]);
      const centre = { lat: bounds.centreLat, lon: bounds.centreLon };
      const working = fitZoom(referenceBounds(centre), frame);
      const zoom = passageZoom(bounds, frame);
      assert.ok(zoom <= working, `magnified past the working scale, span ${span}`);
      assert.ok(zoom >= working - MAX_WIDEN_LEVELS, `widened past the cap, span ${span}`);
    }
  });
});

describe('animation camera', () => {
  const frame = { width: 1080, height: 1920 };
  const bounds = trackBounds([HOME, { lat: 46.35, lon: -1.35 }]);
  const projection = createProjection({ zoom: passageZoom(bounds, frame), bounds });

  it('puts the camera centre in the middle of the frame', () => {
    const { ox, oy } = cameraOffset(projection, HOME, frame.width, frame.height);
    assert.ok(Math.abs(projection.projectX(HOME.lon) + ox - frame.width / 2) < 1e-9);
    assert.ok(Math.abs(projection.projectY(HOME.lat) + oy - frame.height / 2) < 1e-9);
  });

  it('projects a whole tile east as a whole tile of pixels', () => {
    const integer = createProjection({ zoom: 12, bounds });
    const east = lonAt(worldX(HOME.lon) + 2 ** -12);
    assert.ok(Math.abs(integer.projectX(east) - integer.projectX(HOME.lon) - 256) < 1e-6);
  });

  it('draws tiles from the next level up, scaled down', () => {
    const { tileZoom, tilePixels, tiles } = visibleTiles(projection, HOME, {
      ...frame,
      renderScale: 1
    });
    assert.equal(tileZoom, Math.ceil(projection.zoom));
    assert.ok(tilePixels > 128 && tilePixels <= 256);
    assert.ok(tiles.length <= 120, `${tiles.length} tiles is more than a frame should need`);
    // Whichever level the tiles came from, the one under the camera is there.
    const count = 2 ** tileZoom;
    const underCamera = {
      x: Math.floor(worldX(HOME.lon) * count),
      y: Math.floor(worldY(HOME.lat) * count)
    };
    assert.ok(
      tiles.some((tile) => tile.x === underCamera.x && tile.y === underCamera.y),
      `no tile at ${underCamera.x}/${underCamera.y} on level ${tileZoom}`
    );
  });

  // The preview draws the very same frame smaller, so it should pull coarser
  // tiles — same framing, a fraction of the downloads.
  it('asks for coarser tiles when the frame is drawn smaller', () => {
    const full = visibleTiles(projection, HOME, { ...frame, renderScale: 1 });
    const preview = visibleTiles(projection, HOME, { ...frame, renderScale: 0.5 });
    assert.equal(preview.tileZoom, full.tileZoom - 1);
    assert.ok(preview.tiles.length < full.tiles.length / 2);
  });

  it('stops at the layer, blowing its last tiles up rather than asking for more', () => {
    const { tileZoom, tilePixels } = visibleTiles(projection, HOME, {
      ...frame,
      layerMaxZoom: 8
    });
    assert.equal(tileZoom, 8);
    assert.ok(tilePixels > 256);
  });

  it('covers the whole frame with no gap', () => {
    const { tiles } = visibleTiles(projection, HOME, { ...frame, renderScale: 1 });
    const { ox, oy } = cameraOffset(projection, HOME, frame.width, frame.height);
    for (let x = 0; x <= frame.width; x += 60) {
      for (let y = 0; y <= frame.height; y += 60) {
        const covered = tiles.some(
          (tile) =>
            x >= tile.px + ox &&
            x <= tile.px + ox + tile.size &&
            y >= tile.py + oy &&
            y <= tile.py + oy + tile.size
        );
        assert.ok(covered, `nothing covers (${x}, ${y})`);
      }
    }
  });

  it('numbers tiles across the seam without leaving the world', () => {
    const seam = trackBounds([
      { lat: 0, lon: 179.9 },
      { lat: 0.1, lon: 180.3 }
    ]);
    const across = createProjection({ zoom: 10, bounds: seam });
    const { tiles } = visibleTiles(across, { lat: 0, lon: 180.1 }, frame);
    assert.ok(tiles.length > 0);
    for (const tile of tiles) {
      assert.ok(tile.wrappedX >= 0 && tile.wrappedX < 2 ** tile.z, `wrappedX ${tile.wrappedX}`);
      assert.ok(tile.y >= 0 && tile.y < 2 ** tile.z, `y ${tile.y}`);
    }
  });

  it('has no tiles beyond the poles', () => {
    const polar = trackBounds([
      { lat: 84.9, lon: 0 },
      { lat: 85, lon: 0.1 }
    ]);
    const projected = createProjection({ zoom: 6, bounds: polar });
    const { tiles } = visibleTiles(projected, { lat: 85, lon: 0 }, frame);
    for (const tile of tiles) {
      assert.ok(tile.y >= 0 && tile.y < 2 ** tile.z);
    }
  });
});
