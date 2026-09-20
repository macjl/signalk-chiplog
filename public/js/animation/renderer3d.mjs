// Drawing one frame of the animation in 3D.
//
// The counterpart of renderer.mjs: the same scene in, the same picture out —
// the frame's logical size, scaled down for the preview by `renderScale` — but
// the map is laid flat and seen from a camera behind and above the boat, and
// the boat is a model. WebGL draws the scene onto a canvas of its own, which is
// then copied onto the 2D context, so the overlay (readout, place names,
// attribution) is drawn by the very same code as in the map view, and the
// encoder needs no idea which renderer made the frame.
//
// A frame is a pure function of `state`, the film's time and the tiles already
// loaded — nothing reads a clock — which is what keeps an export the same
// whatever it took to render. This is the module that pulls in the 3D library,
// and it is only ever imported lazily.

import * as THREE from '../../vendor/three.min.mjs';
import { createCustomBoat, createProceduralBoat, normaliseCustomModel } from './boat-model.mjs';
import { boatPose } from './boat-pose.mjs';
import {
  BOAT_SHARE,
  cameraFrame,
  EARTH_CIRCUMFERENCE,
  FIELD_OF_VIEW,
  frameOrigin,
  framing3d,
  GROUND_RANGE,
  toScene
} from './camera3d.mjs';
import { drawAttribution, drawBubble, drawMarkerAt, overlayLayout, COLOURS } from './renderer.mjs';
import { worldX } from './mercator.mjs';

const SEA = '#aad3df';

// Textures are the GPU's; an evicted tile bitmap in the cache does not free
// them, so they are bounded here on their own.
const TEXTURE_LIMIT = 360;

// How thick the track is drawn, in frame pixels at 1080 on the short side.
const TRACK_PIXELS = 7;
const MAX_RIBBON_POINTS = 6000;

// The track ribbon: flat on the sea, its width taken from the camera so it
// keeps the same thickness on screen at every distance.
const RIBBON_VERTEX = `
  attribute vec2 side;
  uniform float uHalfWidth;
  void main() {
    vec3 displaced = position + vec3(side.x, 0.0, side.y) * uHalfWidth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;
const RIBBON_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    gl_FragColor = linearToOutputTexel(vec4(uColor, uOpacity));
  }
`;

function ribbonMaterial(colour, opacity) {
  return new THREE.ShaderMaterial({
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT,
    uniforms: {
      uHalfWidth: { value: 1 },
      uColor: { value: new THREE.Color(colour) },
      uOpacity: { value: opacity }
    },
    transparent: opacity < 1,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    side: THREE.DoubleSide
  });
}

// The unit square of a tile, corner at the origin, north edge at z = 0, with its
// picture the right way up: v runs down the image, as the bitmap does.
function tileGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3)
  );
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3)
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  return geometry;
}

// A track as a strip of quads, in metres relative to the leg's own centre so
// single-precision floats are plenty. Every vertex carries the direction to
// push it sideways, and the shader scales that by the current width.
function buildRibbon(leg) {
  const count = leg.timeline.count;
  const stride = Math.max(1, Math.ceil(count / MAX_RIBBON_POINTS));
  const indices = [];
  for (let i = 0; i < count; i += stride) {
    indices.push(i);
  }
  if (indices[indices.length - 1] !== count - 1) {
    indices.push(count - 1);
  }
  const centreX = worldX(leg.frame.centre.lon);
  // The leg's own origin is its first point in z and its centre in x: nothing
  // far from either is in the mesh.
  const xs = indices.map((i) => (leg.worldXs[i] - centreX) * EARTH_CIRCUMFERENCE);
  const zs = indices.map((i) => (leg.worldYs[i] - leg.worldYs[0]) * EARTH_CIRCUMFERENCE);

  const n = indices.length;
  const positions = new Float32Array(n * 2 * 3);
  const sides = new Float32Array(n * 2 * 2);
  for (let k = 0; k < n; k += 1) {
    const before = Math.max(0, k - 1);
    const after = Math.min(n - 1, k + 1);
    let dx = xs[after] - xs[before];
    let dz = zs[after] - zs[before];
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    // The normal to the direction of travel.
    for (const [slot, sign] of [
      [0, 1],
      [1, -1]
    ]) {
      const vertex = k * 2 + slot;
      positions.set([xs[k], 0, zs[k]], vertex * 3);
      sides.set([-dz * sign, dx * sign], vertex * 2);
    }
  }
  const triangles = [];
  for (let k = 0; k < n - 1; k += 1) {
    const a = k * 2;
    triangles.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('side', new THREE.BufferAttribute(sides, 2));
  geometry.setIndex(triangles);
  geometry.setDrawRange(0, 0);
  return { geometry, indices, stride, xs, zs, firstWorldY: leg.worldYs[0], centreX };
}

function createLegTrack(scene, leg) {
  const ribbon = buildRibbon(leg);
  const past = new THREE.Mesh(ribbon.geometry, ribbonMaterial(COLOURS.trackPast, 0.62));
  const current = new THREE.Mesh(ribbon.geometry, ribbonMaterial(COLOURS.track, 1));
  past.frustumCulled = false;
  current.frustumCulled = false;
  past.renderOrder = 3;
  current.renderOrder = 4;

  // The stretch from the last recorded point to the boat itself, which a
  // sampled track cannot show.
  const headGeometry = new THREE.BufferGeometry();
  headGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  headGeometry.setAttribute('side', new THREE.BufferAttribute(new Float32Array(8), 2));
  headGeometry.setIndex([0, 1, 2, 1, 3, 2]);
  headGeometry.setDrawRange(0, 0);
  const head = new THREE.Mesh(headGeometry, ribbonMaterial(COLOURS.track, 1));
  head.frustumCulled = false;
  head.renderOrder = 4;

  const group = new THREE.Group();
  group.add(past, current, head);
  group.visible = false;
  scene.add(group);
  return { group, past, current, head, headGeometry, ribbon };
}

export function createRenderer3d(options = {}) {
  const { onContextLost } = options;
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(2, 2)
      : document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(new THREE.Color(SEA), 1);
  canvas.addEventListener?.('webglcontextlost', (event) => {
    event.preventDefault();
    onContextLost?.();
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SEA);
  scene.fog = new THREE.Fog(SEA, 1, 2);
  const camera = new THREE.PerspectiveCamera((FIELD_OF_VIEW * 180) / Math.PI, 1, 1, 10);

  scene.add(new THREE.HemisphereLight('#ffffff', '#7f9fb0', 1.7));
  const sun = new THREE.DirectionalLight('#fff3e0', 2.6);
  sun.position.set(-0.5, 1, 0.7);
  scene.add(sun);

  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const unitTile = tileGeometry();
  const tiles = new Map();
  const tracks = new Map();
  const wakeGeometry = new THREE.BufferGeometry();
  wakeGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-0.04, 0.004, -0.5, 0.04, 0.004, -0.5, 0.16, 0.004, -1.5, -0.16, 0.004, -1.5],
      3
    )
  );
  wakeGeometry.setIndex([0, 2, 1, 0, 3, 2]);
  const wake = new THREE.Mesh(
    wakeGeometry,
    new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false
    })
  );
  wake.renderOrder = 5;

  const boatRoot = new THREE.Group();
  const boatTilt = new THREE.Group();
  boatRoot.add(wake, boatTilt);
  scene.add(boatRoot);

  let boat = null;
  let boatKey = null;

  function useBoat(template) {
    const key = template ?? 'procedural';
    if (key === boatKey) {
      return;
    }
    if (boat) {
      boatTilt.remove(boat.root);
      boat.dispose();
    }
    boat = template ? createCustomBoat(template) : createProceduralBoat();
    boatTilt.add(boat.root);
    boatKey = key;
  }
  useBoat(customTemplate);

  function tileEntry(layer, tile, bitmap, frame) {
    const key = `${layer.id}/${tile.z}/${tile.x}/${tile.y}`;
    let entry = tiles.get(key);
    if (entry && entry.bitmap !== bitmap) {
      disposeTile(key, entry);
      entry = undefined;
    }
    if (!entry) {
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
      const overlay = layer.id !== 'osm';
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: overlay,
        depthWrite: !overlay,
        side: THREE.DoubleSide,
        polygonOffset: overlay,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      const mesh = new THREE.Mesh(unitTile, material);
      mesh.renderOrder = overlay ? 1 : 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
      entry = { bitmap, texture, material, mesh, frame };
      tiles.set(key, entry);
    } else {
      // Touch it, so the tiles in view are the last to be let go.
      tiles.delete(key);
      tiles.set(key, entry);
    }
    entry.frame = frame;
    return entry;
  }

  function disposeTile(key, entry) {
    scene.remove(entry.mesh);
    entry.material.dispose();
    entry.texture.dispose();
    tiles.delete(key);
  }

  function trimTiles(frame) {
    if (tiles.size <= TEXTURE_LIMIT) {
      return;
    }
    for (const [key, entry] of tiles) {
      if (tiles.size <= TEXTURE_LIMIT) {
        break;
      }
      // Never one the frame being drawn is using.
      if (entry.frame !== frame) {
        disposeTile(key, entry);
      }
    }
  }

  function trackFor(leg) {
    let track = tracks.get(leg);
    if (!track) {
      track = createLegTrack(scene, leg);
      tracks.set(leg, track);
    }
    return track;
  }

  let frameNumber = 0;

  function place(sceneData, pose, wanted, origin, metresPerPixel) {
    const { state, legs, cache, layers, width, height } = sceneData;
    frameNumber += 1;

    // Tiles: one quad each, hidden until this frame asks for it.
    for (const entry of tiles.values()) {
      entry.mesh.visible = false;
    }
    for (const layer of layers) {
      for (const tile of wanted[layer.id] ?? []) {
        const bitmap = cache.peek(layer.id, tile);
        if (!bitmap) {
          continue;
        }
        const count = 2 ** tile.z;
        const side = EARTH_CIRCUMFERENCE / count;
        const entry = tileEntry(layer, tile, bitmap, frameNumber);
        entry.mesh.position.set(
          (tile.x / count - origin.x) * EARTH_CIRCUMFERENCE,
          layer.id === 'osm' ? 0 : pose.distance * 0.0006,
          (tile.y / count - origin.y) * EARTH_CIRCUMFERENCE
        );
        entry.mesh.scale.set(side, 1, side);
        entry.mesh.visible = true;
      }
    }
    trimTiles(frameNumber);

    // Tracks.
    for (const track of tracks.values()) {
      track.group.visible = false;
    }
    const halfWidth = ((TRACK_PIXELS * Math.min(width, height)) / 1080) * metresPerPixel * 0.5;
    for (let index = 0; index <= state.legIndex; index += 1) {
      const leg = legs[index];
      const track = trackFor(leg);
      const { ribbon } = track;
      const isCurrent = index === state.legIndex;
      const sailing = isCurrent && state.phase === 'leg';
      track.group.visible = true;
      // The ribbon lives at the leg's first point.
      track.group.position.set(
        (ribbon.centreX - origin.x) * EARTH_CIRCUMFERENCE,
        0,
        (ribbon.firstWorldY - origin.y) * EARTH_CIRCUMFERENCE
      );
      for (const mesh of [track.past, track.current, track.head]) {
        mesh.material.uniforms.uHalfWidth.value = halfWidth;
      }
      track.past.visible = !isCurrent;
      track.current.visible = isCurrent;
      const segments = ribbon.indices.length - 1;
      if (!sailing) {
        ribbon.geometry.setDrawRange(0, segments * 6);
        track.head.visible = false;
      } else {
        const passed = leg.timeline.indexAt(state.timeMs);
        const last = Math.min(ribbon.indices.length - 1, Math.floor(passed / ribbon.stride));
        ribbon.geometry.setDrawRange(0, last * 6);
        // From the last drawn point to the boat.
        const from = { x: ribbon.xs[last], z: ribbon.zs[last] };
        const boatAt = toScene({ x: ribbon.centreX, y: ribbon.firstWorldY }, state.lat, state.lon);
        let dx = boatAt.x - from.x;
        let dz = boatAt.z - from.z;
        const length = Math.hypot(dx, dz);
        if (length > 1e-6) {
          dx /= length;
          dz /= length;
          const position = track.headGeometry.attributes.position;
          const side = track.headGeometry.attributes.side;
          position.array.set([
            from.x,
            0,
            from.z,
            from.x,
            0,
            from.z,
            boatAt.x,
            0,
            boatAt.z,
            boatAt.x,
            0,
            boatAt.z
          ]);
          side.array.set([-dz, dx, dz, -dx, -dz, dx, dz, -dx]);
          position.needsUpdate = true;
          side.needsUpdate = true;
          track.headGeometry.setDrawRange(0, 6);
          track.head.visible = true;
        } else {
          track.head.visible = false;
        }
      }
    }

    // The boat.
    boatRoot.visible = state.boatVisible;
    if (state.boatVisible) {
      const at = toScene(origin, state.lat, state.lon);
      const posed = boatPose(state, sceneData.at ?? 0, pose.bearing);
      const length = pose.distance * BOAT_SHARE * (sceneData.boatSize ?? 1);
      boatRoot.position.set(at.x, 0, at.z);
      boatRoot.scale.setScalar(length);
      // The model's bow is +z; a compass bearing is clockwise from north, and
      // north is -z.
      boatRoot.rotation.y = Math.PI - posed.heading;
      boatTilt.rotation.z = posed.heel;
      boatTilt.rotation.x = -posed.pitch;
      boatTilt.position.y = posed.lift;
      boat.update(posed);
      const way = Math.max(0, Math.min(1, (state.sog ?? 0) / 2));
      wake.visible = way > 0;
      wake.material.opacity = 0.4 * way;
    }
  }

  // Where a scene position lands in the frame, for the overlay's labels.
  const projector = new THREE.Vector3();
  function toScreen(x, z, width, height) {
    projector.set(x, 0, z).project(camera);
    if (projector.z > 1 || projector.z < -1) {
      return null;
    }
    return { x: (projector.x * 0.5 + 0.5) * width, y: (0.5 - projector.y * 0.5) * height };
  }

  function drawPorts(ctx, sceneData, origin, layout) {
    const { legs, state, width, height } = sceneData;
    const mark = (leg, which, label) => {
      const index = which === 'departure' ? 0 : leg.timeline.count - 1;
      const lat = leg.timeline.latitudes[index];
      const lon = leg.timeline.longitudes[index];
      const at = toScene(origin, lat, lon);
      const screen = toScreen(at.x, at.z, width, height);
      if (screen) {
        drawMarkerAt(ctx, screen.x, screen.y, which, layout, label);
      }
    };
    mark(legs[0], 'departure', legs[0].entry?.startPlaceName);
    for (let index = 0; index < state.legIndex; index += 1) {
      mark(legs[index], 'arrival', legs[index].entry?.endPlaceName);
    }
    if (state.phase !== 'leg') {
      mark(legs[state.legIndex], 'arrival', legs[state.legIndex].entry?.endPlaceName);
    }
  }

  // `ctx` is the 2D context the frame is drawn onto, in the frame's own logical
  // coordinates; the picture is rendered at `renderScale` and copied across.
  function render(ctx, sceneData) {
    const { width, height, state, renderScale = 1 } = sceneData;
    if (!state) {
      return;
    }
    const pixelWidth = Math.max(2, Math.round(width * renderScale));
    const pixelHeight = Math.max(2, Math.round(height * renderScale));
    renderer.setSize(pixelWidth, pixelHeight, false);

    const { pose, tiles: wanted } = framing3d(state, {
      aspect: width / height,
      height,
      frameHeight: pixelHeight,
      layers: sceneData.layers,
      factor: sceneData.framing
    });
    const origin = frameOrigin(pose);
    const frame = cameraFrame(pose, width / height);
    const metresPerPixel = (2 * pose.distance * frame.tanV) / height;

    camera.aspect = width / height;
    camera.near = pose.distance * 0.05;
    camera.far = pose.distance * GROUND_RANGE * 3;
    camera.position.set(frame.position.x, frame.position.y, frame.position.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    scene.fog.near = pose.distance * 1.6;
    scene.fog.far = pose.distance * GROUND_RANGE;

    place(sceneData, pose, wanted, origin, metresPerPixel);
    renderer.render(scene, camera);

    ctx.drawImage(canvas, 0, 0, width, height);
    const layout = overlayLayout(width, height);
    drawPorts(ctx, sceneData, origin, layout);
    if (sceneData.overlay) {
      drawBubble(ctx, sceneData, layout);
      drawAttribution(ctx, sceneData, layout);
    }
  }

  function dispose() {
    for (const [key, entry] of [...tiles]) {
      disposeTile(key, entry);
    }
    for (const track of tracks.values()) {
      track.ribbon.geometry.dispose();
      track.headGeometry.dispose();
    }
    tracks.clear();
    boat?.dispose();
    unitTile.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }

  return {
    render,
    dispose,
    useBoat,
    get boatKey() {
      return boatKey;
    }
  };
}

// The crew's own model is shared by every renderer: parsed once, then cloned
// into each. `null` puts the default boat back.
let customTemplate = null;
const listeners = new Set();

export async function setCustomBoat(buffer) {
  if (!buffer) {
    customTemplate = null;
  } else {
    const { GLTFLoader } = await import('../../vendor/three.min.mjs');
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer, '', resolve, reject);
    });
    customTemplate = normaliseCustomModel(gltf.scene);
  }
  for (const listener of listeners) {
    listener(customTemplate);
  }
}

export function onBoatChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentBoatTemplate() {
  return customTemplate;
}

// One renderer per canvas the frames are drawn onto: the preview's and the
// export's are separate, so neither resizes the other's picture.
const renderers = new WeakMap();

export function renderScene3d(ctx, sceneData, options = {}) {
  let entry = renderers.get(ctx.canvas);
  if (!entry) {
    const instance = createRenderer3d(options);
    entry = { instance, stop: onBoatChange((template) => instance.useBoat(template)) };
    renderers.set(ctx.canvas, entry);
  }
  entry.instance.render(ctx, sceneData);
}

export function releaseScene3d(canvas) {
  const entry = renderers.get(canvas);
  if (entry) {
    entry.stop();
    entry.instance.dispose();
    renderers.delete(canvas);
  }
}
