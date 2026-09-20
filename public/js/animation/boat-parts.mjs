// Which parts of a crew-supplied boat model are its sails.
//
// The default boat sets its own sails from the wind; a model loaded from a .glb
// can have the same done to it, provided its sails are named so they can be found
// (README, "Your own boat"). Nothing here touches the 3D library, so plain Node
// can test it; the boat model does the rotating.

// What each kind of sail does, relative to the wind-driven angle the boat is given
// (see boat-pose.mjs `sailAngle`): the mainsail follows it, the headsail a little
// less, as it is sheeted in closer.
export const SAIL_ROLES = {
  main: { factor: 1 },
  jib: { factor: 0.8 }
};

// Names are compared without case, punctuation or the number a modelling tool adds
// to a duplicate (Mainsail.001 arrives as Mainsail001), and in English or French.
const NAMES = {
  main: ['main', 'mainsail', 'sailmain', 'grandvoile', 'gv'],
  jib: ['jib', 'genoa', 'headsail', 'foresail', 'sailjib', 'foc', 'genois']
};

function normalise(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+$/, '');
}

// 'main', 'jib' or null.
export function sailRole(name) {
  const key = normalise(name);
  if (!key) {
    return null;
  }
  return Object.keys(NAMES).find((role) => NAMES[role].includes(key)) ?? null;
}

// The sails of a model, given its nodes as { name, children }: each sail found,
// leaving out any node inside another sail (the outermost one is what turns).
export function findSails(root) {
  const found = [];
  const visit = (node) => {
    const role = sailRole(node.name);
    if (role) {
      found.push({ node, role });
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return found;
}
