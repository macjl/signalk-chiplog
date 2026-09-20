import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clearBoat, loadBoat, saveBoat } from '../public/js/animation/boat-store.mjs';
import { isWebGL2Supported } from '../public/js/animation/webgl.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('WebGL 2 support', () => {
  const canvasWith = (getContext) =>
    function OffscreenCanvas() {
      this.getContext = getContext;
    };

  it('is supported when a webgl2 context can be made', () => {
    const scope = { OffscreenCanvas: canvasWith((kind) => (kind === 'webgl2' ? {} : null)) };
    assert.equal(isWebGL2Supported(scope), true);
  });

  it('is not when the browser refuses the context', () => {
    assert.equal(isWebGL2Supported({ OffscreenCanvas: canvasWith(() => null) }), false);
  });

  it('is not when asking throws, or when there is no canvas at all', () => {
    const throwing = canvasWith(() => {
      throw new Error('blocked');
    });
    assert.equal(isWebGL2Supported({ OffscreenCanvas: throwing }), false);
    assert.equal(isWebGL2Supported({}), false);
  });

  it('falls back to a canvas element where there is no OffscreenCanvas', () => {
    const scope = { document: { createElement: () => ({ getContext: () => ({}) }) } };
    assert.equal(isWebGL2Supported(scope), true);
  });
});

// Just enough of IndexedDB for the store: one object store, requests that
// complete on a later tick, as the real ones do.
function fakeIndexedDB() {
  const data = new Map();
  return {
    data,
    open() {
      const request = {};
      setTimeout(() => {
        request.result = {
          createObjectStore() {},
          close() {},
          transaction() {
            const transaction = {
              objectStore: () => ({
                put(value, key) {
                  data.set(key, value);
                  return finish({});
                },
                get: (key) => finish({ result: data.get(key) }),
                delete(key) {
                  data.delete(key);
                  return finish({});
                }
              })
            };
            function finish(result) {
              setTimeout(() => transaction.oncomplete?.(), 0);
              return result;
            }
            return transaction;
          }
        };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    }
  };
}

describe('the crew’s boat model store', () => {
  it('keeps a model and gives it back, until it is cleared', async () => {
    const factory = fakeIndexedDB();
    assert.equal(await loadBoat(factory), null);
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    assert.equal(await saveBoat({ name: 'boat.glb', buffer }, factory), true);
    const stored = await loadBoat(factory);
    assert.equal(stored.name, 'boat.glb');
    assert.deepEqual([...new Uint8Array(stored.buffer)], [1, 2, 3]);
    assert.equal(await clearBoat(factory), true);
    assert.equal(await loadBoat(factory), null);
  });

  it('shrugs off a browser without usable storage', async () => {
    const broken = {
      open() {
        throw new Error('denied');
      }
    };
    assert.equal(await loadBoat(broken), null);
    assert.equal(await saveBoat({ name: 'x', buffer: new ArrayBuffer(1) }, broken), false);
    assert.equal(await clearBoat(broken), false);
    assert.equal(await loadBoat(undefined), null);
  });
});

describe('the vendored 3D library', () => {
  const entry = fs.readFileSync(path.join(root, 'scripts', 'three-entry.mjs'), 'utf8');
  const exported = new Set(
    [...entry.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((match) =>
      match[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    )
  );

  it('exports every name the 3D modules use', () => {
    const directory = path.join(root, 'public', 'js', 'animation');
    const used = new Set();
    for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.mjs'))) {
      const source = fs.readFileSync(path.join(directory, file), 'utf8');
      for (const match of source.matchAll(/\bTHREE\.([A-Za-z0-9_]+)/g)) {
        used.add(match[1]);
      }
      for (const match of source.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*'[^']*vendor\/three\.min\.mjs'/g
      )) {
        match[1].split(',').forEach((name) => used.add(name.trim().split(/\s+as\s+/)[0]));
      }
      if (/\bGLTFLoader\b/.test(source)) {
        used.add('GLTFLoader');
      }
    }
    assert.ok(used.size > 5, 'found the names the modules use');
    const missing = [...used].filter((name) => name && !exported.has(name));
    assert.deepEqual(missing, [], 'add these to scripts/three-entry.mjs');
  });

  it('is never imported by the modules the map view loads', () => {
    for (const file of ['AnimationView.mjs', 'AnimationExport.mjs']) {
      const source = fs.readFileSync(path.join(root, 'public', 'js', 'components', file), 'utf8');
      assert.ok(
        !/vendor\/three/.test(source),
        `${file} must load it lazily, through renderer3d.mjs`
      );
    }
    const view = fs.readFileSync(
      path.join(root, 'public', 'js', 'components', 'AnimationView.mjs'),
      'utf8'
    );
    assert.ok(
      !/^import .*renderer3d\.mjs/m.test(view),
      'the 3D renderer is imported with import()'
    );
  });
});
