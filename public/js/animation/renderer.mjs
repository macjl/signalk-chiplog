// Drawing one frame of the animation.
//
// Everything here is in the frame's own logical coordinates — the size of the
// chosen export format. The preview scales the whole context down by
// `renderScale`, so a frame on screen and a frame in the MP4 are the same
// drawing at different resolutions, and the framing cannot drift apart.
//
// Colours are literals rather than CSS variables, as in components/TrackMap.mjs
// (a canvas cannot read them) and, for the overlay, deliberately: the video is
// watched outside the app and must not depend on the theme of whoever exported
// it.

import { cameraOffset, createProjection, visibleTiles } from './camera.mjs';
import { worldX, worldY } from './mercator.mjs';

export const COLOURS = {
  sea: '#aad3df',
  track: '#e8590c',
  trackPast: 'rgba(232, 89, 12, 0.55)',
  boat: '#1d4ed8',
  boatOutline: '#ffffff',
  departure: '#2b8a3e',
  arrival: '#c92a2a',
  markerOutline: '#ffffff',
  bubble: 'rgba(255, 255, 255, 0.88)',
  bubbleBorder: 'rgba(0, 0, 0, 0.18)',
  text: '#16222e',
  muted: '#5a6b7b',
  attribution: 'rgba(255, 255, 255, 0.75)',
  attributionText: '#16222e'
};

const FONT = "600 {size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const LABEL_FONT = "500 {size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// No frame ever issues more than this many line segments: a season of sailing
// is tens of thousands of points, and most of them land on the same pixel.
const MAX_SEGMENTS = 4000;

// Sizes are derived from the short side, so a 9:16 phone video and a 16:9
// widescreen one carry the same weight of text. Pure, so it can be tested.
export function overlayLayout(width, height) {
  const unit = Math.min(width, height) / 1080;
  const margin = Math.round(48 * unit);
  return {
    unit,
    margin,
    padding: Math.round(22 * unit),
    radius: Math.round(18 * unit),
    labelSize: Math.round(24 * unit),
    valueSize: Math.round(54 * unit),
    clockSize: Math.round(30 * unit),
    attributionSize: Math.round(20 * unit),
    lineGap: Math.round(12 * unit),
    trackWidth: Math.max(2, 5 * unit),
    boatSize: Math.round(44 * unit),
    markerRadius: Math.round(11 * unit),
    placeSize: Math.round(24 * unit)
  };
}

function font(template, size) {
  return template.replace('{size}', size);
}

// A camera is a zoom and a centre; the frame's origin is that centre, so the
// numbers stay small whatever the zoom.
function frameProjection(camera, width, height) {
  const projection = createProjection({
    zoom: camera.zoom,
    bounds: { centreLat: camera.centre.lat, centreLon: camera.centre.lon }
  });
  const { ox, oy } = cameraOffset(projection, camera.centre, width, height);
  return {
    projection,
    ox,
    oy,
    // Legs carry their positions as world fractions, which do not depend on the
    // zoom: turning one into a pixel is then two multiplications.
    x: (worldFractionX) => worldFractionX * projection.scale - projection.originX + ox,
    y: (worldFractionY) => worldFractionY * projection.scale - projection.originY + oy
  };
}

function drawTiles(ctx, view, camera, scene) {
  const { width, height, renderScale, cache, layers } = scene;
  for (const layer of layers) {
    const { tiles } = visibleTiles(view.projection, camera.centre, {
      width,
      height,
      renderScale,
      layerMaxZoom: layer.maxZoom
    });
    for (const tile of tiles) {
      const bitmap = cache.peek(layer.id, tile);
      if (!bitmap) {
        continue;
      }
      // Floor the corner and round the size up: at a fractional zoom, exact
      // placement leaves hairline seams between tiles.
      ctx.drawImage(
        bitmap,
        Math.floor(tile.px + view.ox),
        Math.floor(tile.py + view.oy),
        Math.ceil(tile.size) + 1,
        Math.ceil(tile.size) + 1
      );
    }
  }
}

function strokeLeg(ctx, view, leg, upTo) {
  const { worldXs, worldYs } = leg;
  const count = upTo ?? leg.timeline.count;
  if (count < 2) {
    return;
  }
  const stride = Math.max(1, Math.ceil(count / MAX_SEGMENTS));
  ctx.beginPath();
  ctx.moveTo(view.x(worldXs[0]), view.y(worldYs[0]));
  for (let i = stride; i < count; i += stride) {
    ctx.lineTo(view.x(worldXs[i]), view.y(worldYs[i]));
  }
  // Always finish on the real last point, whatever the stride skipped.
  ctx.lineTo(view.x(worldXs[count - 1]), view.y(worldYs[count - 1]));
  ctx.stroke();
}

function drawTracks(ctx, view, scene, layout) {
  const { legs, state } = scene;
  ctx.lineWidth = layout.trackWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (let index = 0; index <= state.legIndex; index += 1) {
    const leg = legs[index];
    const sailing = index === state.legIndex && state.phase === 'leg';
    ctx.strokeStyle = index === state.legIndex ? COLOURS.track : COLOURS.trackPast;
    // The legs still to come are not drawn: the film shows the passage being
    // made, not a route already plotted.
    strokeLeg(ctx, view, leg, sailing ? leg.timeline.indexAt(state.timeMs) + 2 : undefined);
  }
}

function drawMarker(ctx, view, leg, which, layout, label) {
  const index = which === 'departure' ? 0 : leg.timeline.count - 1;
  const x = view.x(leg.worldXs[index]);
  const y = view.y(leg.worldYs[index]);
  ctx.beginPath();
  ctx.arc(x, y, layout.markerRadius, 0, Math.PI * 2);
  ctx.fillStyle = which === 'departure' ? COLOURS.departure : COLOURS.arrival;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, 2.5 * layout.unit);
  ctx.strokeStyle = COLOURS.markerOutline;
  ctx.stroke();

  if (!label) {
    return;
  }
  ctx.font = font(LABEL_FONT, layout.placeSize);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const offset = layout.markerRadius + Math.round(8 * layout.unit);
  // An outline behind the name, so it reads over any chart.
  ctx.lineWidth = Math.max(2, 4 * layout.unit);
  ctx.strokeStyle = COLOURS.markerOutline;
  ctx.lineJoin = 'round';
  // fillText draws the crew's own words as text, never as markup.
  ctx.strokeText(label, x, y - offset);
  ctx.fillStyle = COLOURS.text;
  ctx.fillText(label, x, y - offset);
}

function drawPorts(ctx, view, scene, layout) {
  const { legs, state } = scene;
  if (legs.length === 0) {
    return;
  }
  drawMarker(ctx, view, legs[0], 'departure', layout, legs[0].entry?.startPlaceName);
  for (let index = 0; index < state.legIndex; index += 1) {
    drawMarker(ctx, view, legs[index], 'arrival', layout, legs[index].entry?.endPlaceName);
  }
  // The leg being sailed only gets its arrival marker once it is reached.
  if (state.phase !== 'leg') {
    const leg = legs[state.legIndex];
    drawMarker(ctx, view, leg, 'arrival', layout, leg.entry?.endPlaceName);
  }
}

function drawBoat(ctx, view, scene, layout) {
  const { state } = scene;
  if (!state.boatVisible) {
    return;
  }
  const x = view.x(worldX(state.lon));
  const y = view.y(worldY(state.lat));
  const heading = state.heading ?? state.cog ?? 0;
  const size = layout.boatSize;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  // The same hull as the map's marker, drawn in a 24-unit box pointing north.
  const k = size / 24;
  ctx.beginPath();
  ctx.moveTo(0 * k, -10 * k);
  ctx.lineTo(6.5 * k, 8 * k);
  ctx.lineTo(0 * k, 4.5 * k);
  ctx.lineTo(-6.5 * k, 8 * k);
  ctx.closePath();
  ctx.fillStyle = COLOURS.boat;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, 2.5 * layout.unit);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLOURS.boatOutline;
  ctx.stroke();
  ctx.restore();
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

// Speed, distance covered since the film began, and when — the readout the
// whole animation is for.
function drawBubble(ctx, scene, layout) {
  const { overlay } = scene;
  const rows = [
    [overlay.speedLabel, overlay.speed],
    [overlay.distanceLabel, overlay.distance]
  ];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  let widest = 0;
  ctx.font = font(FONT, layout.valueSize);
  for (const [, value] of rows) {
    widest = Math.max(widest, ctx.measureText(value).width);
  }
  ctx.font = font(LABEL_FONT, layout.clockSize);
  widest = Math.max(widest, ctx.measureText(overlay.clock).width);

  const rowHeight = layout.labelSize + layout.lineGap + layout.valueSize;
  const height =
    layout.padding * 2 + rows.length * rowHeight + layout.lineGap * 2 + layout.clockSize;
  const width = widest + layout.padding * 2;
  const x = layout.margin;
  const y = layout.margin;

  roundedRect(ctx, x, y, width, height, layout.radius);
  ctx.fillStyle = COLOURS.bubble;
  ctx.fill();
  ctx.lineWidth = Math.max(1, layout.unit);
  ctx.strokeStyle = COLOURS.bubbleBorder;
  ctx.stroke();

  let cursor = y + layout.padding;
  for (const [label, value] of rows) {
    ctx.font = font(LABEL_FONT, layout.labelSize);
    ctx.fillStyle = COLOURS.muted;
    ctx.fillText(label, x + layout.padding, cursor);
    cursor += layout.labelSize + layout.lineGap;
    ctx.font = font(FONT, layout.valueSize);
    ctx.fillStyle = COLOURS.text;
    ctx.fillText(value, x + layout.padding, cursor);
    cursor += layout.valueSize;
  }
  cursor += layout.lineGap * 2;
  ctx.font = font(LABEL_FONT, layout.clockSize);
  ctx.fillStyle = COLOURS.muted;
  ctx.fillText(overlay.clock, x + layout.padding, cursor);
}

// Once the frames leave the page, the map credit has to travel with them.
function drawAttribution(ctx, scene, layout) {
  const { width, height, overlay } = scene;
  ctx.font = font(LABEL_FONT, layout.attributionSize);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const text = overlay.attribution;
  const padding = Math.round(10 * layout.unit);
  const measured = ctx.measureText(text).width;
  const boxHeight = layout.attributionSize + padding * 2;
  const x = width - measured - padding * 2 - Math.round(12 * layout.unit);
  const y = height - boxHeight - Math.round(12 * layout.unit);
  roundedRect(ctx, x, y, measured + padding * 2, boxHeight, Math.round(6 * layout.unit));
  ctx.fillStyle = COLOURS.attribution;
  ctx.fill();
  ctx.fillStyle = COLOURS.attributionText;
  ctx.fillText(
    text,
    width - padding - Math.round(12 * layout.unit),
    height - padding - Math.round(12 * layout.unit)
  );
}

// The one impure function here. `scene` carries everything already worked out:
// the state, the legs, the tile cache and the overlay's already-formatted,
// already-translated strings — the renderer knows nothing of i18n.
export function drawFrame(ctx, scene) {
  const { width, height, state } = scene;
  const layout = overlayLayout(width, height);

  ctx.save();
  ctx.fillStyle = COLOURS.sea;
  ctx.fillRect(0, 0, width, height);

  if (state) {
    const view = frameProjection(state.camera, width, height);
    drawTiles(ctx, view, state.camera, scene);
    drawTracks(ctx, view, scene, layout);
    drawPorts(ctx, view, scene, layout);
    drawBoat(ctx, view, scene, layout);
  }

  if (scene.overlay) {
    drawBubble(ctx, scene, layout);
    drawAttribution(ctx, scene, layout);
  }
  ctx.restore();
}
