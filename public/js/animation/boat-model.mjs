// The boat of the 3D view: a sailboat built in code, or the crew's own model.
//
// Both are one unit long, bow towards +z, y up, with the waterline at y = 0, so
// the renderer scales either to whatever the camera needs. Nothing is a file:
// the default boat is generated, so there is no asset to ship or to credit.

import * as THREE from '../../vendor/three.min.mjs';
import { findSails, SAIL_ROLES } from './boat-parts.mjs';

const HULL_STATIONS = [
  // u: along the hull from the stern; half beam; deck height above the water.
  { u: 0, beam: 0.108, deck: 0.078 },
  { u: 0.12, beam: 0.136, deck: 0.072 },
  { u: 0.3, beam: 0.152, deck: 0.068 },
  { u: 0.5, beam: 0.153, deck: 0.07 },
  { u: 0.68, beam: 0.132, deck: 0.078 },
  { u: 0.84, beam: 0.084, deck: 0.09 },
  { u: 0.95, beam: 0.032, deck: 0.102 },
  { u: 1, beam: 0.002, deck: 0.108 }
];

// One half of a cross-section, from the deck edge down to the keel, as fractions
// of the half beam and of the draught.
const SECTION = [
  { x: 1, y: 'deck' },
  { x: 0.99, y: 0.25 },
  { x: 0.93, y: 0 },
  { x: 0.78, y: -0.42 },
  { x: 0.52, y: -0.78 },
  { x: 0.2, y: -0.97 }
];
const DRAUGHT = 0.05;

const HULL_LENGTH = 1;
const COLOURS = {
  topsides: new THREE.Color('#f4f1ea'),
  stripe: new THREE.Color('#1d4ed8'),
  bottom: new THREE.Color('#7a1f1f'),
  deck: new THREE.Color('#c9a26b'),
  cabin: new THREE.Color('#f4f1ea'),
  glass: new THREE.Color('#1b2733'),
  metal: new THREE.Color('#9aa5b1'),
  sail: new THREE.Color('#fbfaf5')
};

function interpolateStation(u, key) {
  for (let i = 0; i < HULL_STATIONS.length - 1; i += 1) {
    const a = HULL_STATIONS[i];
    const b = HULL_STATIONS[i + 1];
    if (u <= b.u) {
      const t = (u - a.u) / (b.u - a.u);
      const eased = t * t * (3 - 2 * t);
      return a[key] + (b[key] - a[key]) * eased;
    }
  }
  return HULL_STATIONS[HULL_STATIONS.length - 1][key];
}

function hullColour(y, deck) {
  if (y < -0.004) {
    return COLOURS.bottom;
  }
  // A blue stripe just under the rail, white above and below it.
  return y > deck - 0.02 && y < deck - 0.008 ? COLOURS.stripe : COLOURS.topsides;
}

function buildHull() {
  const stations = 34;
  const positions = [];
  const colours = [];
  const indices = [];
  let ringSize = 0;

  for (let s = 0; s <= stations; s += 1) {
    const u = s / stations;
    const z = (u - 0.5) * HULL_LENGTH;
    const beam = interpolateStation(u, 'beam');
    const deck = interpolateStation(u, 'deck');
    // Starboard is -x. The ring runs down the starboard side, up the port one,
    // and closes across the deck.
    const half = SECTION.map((point) => ({
      x: point.x * beam,
      y: point.y === 'deck' ? deck : point.y * (point.y < 0 ? DRAUGHT : deck)
    }));
    const ring = [
      ...half.map((point) => ({ x: -point.x, y: point.y })),
      ...half
        .slice()
        .reverse()
        .map((point) => ({ x: point.x, y: point.y }))
    ];
    ringSize = ring.length;
    for (const point of ring) {
      positions.push(point.x, point.y, z);
      const colour = hullColour(point.y, deck);
      colours.push(colour.r, colour.g, colour.b);
    }
  }
  for (let s = 0; s < stations; s += 1) {
    for (let i = 0; i < ringSize; i += 1) {
      const a = s * ringSize + i;
      const b = s * ringSize + ((i + 1) % ringSize);
      const c = (s + 1) * ringSize + i;
      const d = (s + 1) * ringSize + ((i + 1) % ringSize);
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// The deck follows the sheer of the hull, a hair above it.
function buildDeck() {
  const stations = 34;
  const positions = [];
  const indices = [];
  for (let s = 0; s <= stations; s += 1) {
    const u = s / stations;
    const z = (u - 0.5) * HULL_LENGTH;
    const beam = interpolateStation(u, 'beam') * 0.94;
    const deck = interpolateStation(u, 'deck') + 0.0015;
    positions.push(-beam, deck, z, beam, deck, z);
  }
  for (let s = 0; s < stations; s += 1) {
    const a = s * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function material(colour, options = {}) {
  return new THREE.MeshStandardMaterial({
    color: colour,
    roughness: 0.6,
    metalness: 0,
    ...options
  });
}

function mesh(geometry, colour, options) {
  const result = new THREE.Mesh(geometry, material(colour, options));
  return result;
}

const MAST_Z = 0.1;
const DECK_AT_MAST = 0.082;
const MAST_HEIGHT = 0.62;
const BOOM_LENGTH = 0.3;
const FORESTAY_Z = 0.44;
const FORESTAY_DECK = 0.1;

// A triangle of sail as a small grid, so it can belly. Vertices are in the
// sail's own plane; `camber` moves the middle out of it, to leeward.
function sailGeometry(corners, camber, rows = 6) {
  const [tack, head, clew] = corners;
  const positions = [];
  const indices = [];
  for (let r = 0; r <= rows; r += 1) {
    for (let c = 0; c <= rows - r; c += 1) {
      // Barycentric: r along the leech from the clew, c along the foot.
      const a = r / rows;
      const b = c / rows;
      const w = 1 - a - b;
      const point = [0, 1, 2].map((k) => tack[k] * w + head[k] * a + clew[k] * b);
      // Fullest in the middle of the cloth, none on its edges.
      point[0] +=
        camber * Math.sin(Math.PI * Math.min(1, a * 1.6)) * Math.sin(Math.PI * (b * 0.8 + 0.1));
      positions.push(...point);
    }
  }
  const at = (r, c) => {
    let offset = 0;
    for (let i = 0; i < r; i += 1) {
      offset += rows - i + 1;
    }
    return offset + c;
  };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < rows - r; c += 1) {
      indices.push(at(r, c), at(r + 1, c), at(r, c + 1));
      if (c < rows - r - 1) {
        indices.push(at(r, c + 1), at(r + 1, c), at(r + 1, c + 1));
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function sailMaterial() {
  return new THREE.MeshStandardMaterial({
    color: COLOURS.sail,
    roughness: 0.85,
    side: THREE.DoubleSide
  });
}

export function createProceduralBoat() {
  const root = new THREE.Group();

  const hull = mesh(buildHull(), 0xffffff, {
    vertexColors: true,
    roughness: 0.4,
    side: THREE.DoubleSide
  });
  root.add(hull);
  root.add(mesh(buildDeck(), COLOURS.deck, { roughness: 0.8, side: THREE.DoubleSide }));

  const cabin = mesh(new THREE.BoxGeometry(0.15, 0.045, 0.26), COLOURS.cabin);
  cabin.position.set(0, DECK_AT_MAST + 0.022, -0.06);
  root.add(cabin);
  for (const side of [-1, 1]) {
    const glass = mesh(new THREE.BoxGeometry(0.004, 0.018, 0.16), COLOURS.glass, {
      roughness: 0.2
    });
    glass.position.set(side * 0.0755, DECK_AT_MAST + 0.028, -0.06);
    root.add(glass);
  }
  const hatch = mesh(new THREE.BoxGeometry(0.1, 0.008, 0.07), COLOURS.glass, { roughness: 0.3 });
  hatch.position.set(0, DECK_AT_MAST + 0.048, 0.02);
  root.add(hatch);

  const mast = mesh(new THREE.CylinderGeometry(0.004, 0.005, MAST_HEIGHT, 8), COLOURS.metal, {
    metalness: 0.6,
    roughness: 0.4
  });
  mast.position.set(0, DECK_AT_MAST + MAST_HEIGHT / 2, MAST_Z);
  root.add(mast);

  // The mainsail turns about the mast; the boom goes with it.
  const mainPivot = new THREE.Group();
  mainPivot.position.set(0, DECK_AT_MAST, MAST_Z);
  const boom = mesh(new THREE.CylinderGeometry(0.0032, 0.0032, BOOM_LENGTH, 6), COLOURS.metal, {
    metalness: 0.6
  });
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 0.05, -BOOM_LENGTH / 2);
  mainPivot.add(boom);
  const mainCamber = 0.03;
  const mainsail = new THREE.Mesh(
    sailGeometry(
      [
        [0, 0.052, 0],
        [0, MAST_HEIGHT - 0.01, 0],
        [0, 0.056, -BOOM_LENGTH + 0.01]
      ],
      mainCamber
    ),
    sailMaterial()
  );
  mainPivot.add(mainsail);
  root.add(mainPivot);

  // The jib is fixed at the bow and the masthead; only its clew swings, so it
  // is rebuilt when the angle changes, and the boat's own frame stays put.
  const jibTack = [0, FORESTAY_DECK + 0.02, FORESTAY_Z - 0.02];
  const jibHead = [0, DECK_AT_MAST + MAST_HEIGHT - 0.04, MAST_Z + 0.012];
  const jibClewLength = 0.3;
  const jib = new THREE.Mesh(new THREE.BufferGeometry(), sailMaterial());
  root.add(jib);
  const stay = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0012, 0.0012, 1, 4),
    material(COLOURS.metal, { metalness: 0.6 })
  );
  const stayFrom = new THREE.Vector3(...jibTack);
  const stayTo = new THREE.Vector3(...jibHead);
  stay.position.copy(stayFrom).add(stayTo).multiplyScalar(0.5);
  stay.scale.y = stayFrom.distanceTo(stayTo);
  stay.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    stayTo.clone().sub(stayFrom).normalize()
  );
  root.add(stay);

  let lastAngle = null;
  function trimJib(angle) {
    if (lastAngle !== null && Math.abs(angle - lastAngle) < 1e-4) {
      return;
    }
    lastAngle = angle;
    const clew = [
      -Math.sin(angle) * jibClewLength,
      FORESTAY_DECK + 0.03,
      jibTack[2] - Math.cos(angle) * jibClewLength
    ];
    jib.geometry.dispose();
    // Bellying to leeward, the same side as the boom.
    jib.geometry = sailGeometry([jibTack, jibHead, clew], -Math.sign(angle || 1) * 0.022);
  }
  trimJib(0);

  // The pulpit and stanchions would be lost at this size; a rudder and a
  // little cockpit coaming are not.
  const coaming = mesh(new THREE.BoxGeometry(0.11, 0.014, 0.1), COLOURS.deck, { roughness: 0.8 });
  coaming.position.set(0, DECK_AT_MAST + 0.006, -0.36);
  root.add(coaming);

  function update(pose) {
    mainPivot.rotation.y = pose.sail;
    // The cloth bellies to leeward: the side the boom is on.
    mainsail.scale.x = pose.sail <= 0 ? 1 : -1;
    trimJib(pose.sail * 0.8);
  }

  function dispose() {
    root.traverse((child) => {
      child.geometry?.dispose();
      child.material?.dispose();
    });
  }

  return { root, update, dispose };
}

// The crew's model, sized to one unit long, its lowest point just under the
// waterline and its middle on the origin. Its bow must be towards +z with y up
// — the glTF convention — because nothing else says which end is the front.
export function normaliseCustomModel(scene) {
  const holder = new THREE.Group();
  holder.add(scene);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const length = Math.max(size.x, size.z, 1e-6);
  const scale = HULL_LENGTH / length;
  scene.position.set(-centre.x, -box.min.y, -centre.z);
  holder.scale.setScalar(scale);
  // Its keel below the waterline, its topsides above.
  holder.position.y = -DRAUGHT;
  const wrapper = new THREE.Group();
  wrapper.add(holder);
  return wrapper;
}

// The sails a crew's model has, by the names of its nodes: what the boat will
// trim, as `[{ node, role }]`.
export function customSails(scene) {
  return findSails(scene);
}

export function createCustomBoat(template) {
  const root = template.clone(true);
  // Each sail turns about the vertical axis through its own origin, from where the
  // model has it at rest: the crew put the origin on the mast (or the forestay).
  const sails = customSails(root).map(({ node, role }) => ({
    node,
    factor: SAIL_ROLES[role].factor,
    rest: node.rotation.y
  }));
  return {
    root,
    update(pose) {
      for (const { node, factor, rest } of sails) {
        node.rotation.y = rest + pose.sail * factor;
      }
    },
    dispose() {}
  };
}
