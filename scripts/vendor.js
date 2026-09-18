// Copies the webapp's third-party browser files from node_modules into
// public/vendor, which Signal K serves as-is: the webapp has no build step and
// must not depend on a CDN, since a boat is usually offline.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'public', 'vendor');

const files = [
  ['node_modules/htm/preact/standalone.module.js', 'preact-htm.mjs'],
  ['node_modules/htm/LICENSE', 'htm-LICENSE'],
  // The htm standalone build bundles Preact.
  ['node_modules/preact/LICENSE', 'preact-LICENSE'],
  // Encoder and muxer for the animation's MP4 export: one self-contained ES
  // module, loaded only when a video is actually exported. MPL-2.0, so the
  // licence travels with it.
  ['node_modules/mediabunny/dist/bundles/mediabunny.min.mjs', 'mediabunny.min.mjs'],
  ['node_modules/mediabunny/LICENSE', 'mediabunny-LICENSE'],
  ['node_modules/leaflet/dist/leaflet.js', 'leaflet/leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css', 'leaflet/leaflet.css'],
  ['node_modules/leaflet/dist/images', 'leaflet/images'],
  ['node_modules/leaflet/LICENSE', 'leaflet/LICENSE']
];

fs.rmSync(vendor, { recursive: true, force: true });
for (const [source, target] of files) {
  const destination = path.join(vendor, target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(root, source), destination, { recursive: true });
}
