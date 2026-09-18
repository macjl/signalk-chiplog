import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTileCache,
  TILE_LAYERS,
  TILE_REFERRER_POLICY,
  tileKey,
  tileUrl
} from '../public/js/animation/tiles.mjs';

const OSM = TILE_LAYERS[0];
const tile = (x, y, z = 12) => ({ z, x, y });

// A stand-in for an ImageBitmap that records having been closed, which is what
// keeps the cache from leaking graphics memory.
function fakeBitmap(name) {
  return {
    name,
    closed: false,
    close() {
      this.closed = true;
    }
  };
}

// Records every request, and answers whatever the plan says.
function recorder(plan = () => ({ ok: true })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const answer = await plan(url, calls.length);
    if (answer instanceof Error) {
      throw answer;
    }
    return {
      ok: answer.ok,
      status: answer.status ?? (answer.ok ? 200 : 404),
      blob: async () => answer.body ?? url
    };
  };
  return { calls, fetchImpl };
}

const decode = async (body) => fakeBitmap(String(body));

describe('tile addressing', () => {
  it('fills the template in', () => {
    assert.equal(
      tileUrl(OSM.url, tile(2034, 1454)),
      'https://tile.openstreetmap.org/12/2034/1454.png'
    );
  });

  it('wraps a column round the world', () => {
    assert.equal(tileUrl('{z}/{x}/{y}', { z: 2, x: -1, y: 1 }), '2/3/1');
    assert.equal(tileUrl('{z}/{x}/{y}', { z: 2, x: 4, y: 1 }), '2/0/1');
    assert.equal(tileUrl('{z}/{x}/{y}', { z: 2, x: 9, y: 1 }), '2/1/1');
  });

  it('keys a tile by its layer', () => {
    assert.equal(tileKey('osm', tile(1, 2)), 'osm/12/1/2');
    assert.notEqual(tileKey('osm', tile(1, 2)), tileKey('seamarks', tile(1, 2)));
  });
});

describe('tile cache', () => {
  it('sends the referrer policy OpenStreetMap needs', async () => {
    // Without it Signal K's no-referrer pages get an "Access blocked" tile.
    const { calls, fetchImpl } = recorder();
    const cache = createTileCache({ fetchImpl, decode });
    await cache.load(OSM, [tile(1, 1), tile(2, 1)]);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.init.referrerPolicy, TILE_REFERRER_POLICY);
      assert.equal(call.init.mode, 'cors');
    }
  });

  it('downloads a tile once, however often it is asked for', async () => {
    const { calls, fetchImpl } = recorder();
    const cache = createTileCache({ fetchImpl, decode });
    await cache.load(OSM, [tile(1, 1)]);
    await cache.load(OSM, [tile(1, 1)]);
    cache.request(OSM, [tile(1, 1)]);
    assert.equal(calls.length, 1);
    assert.ok(cache.peek('osm', tile(1, 1)));
  });

  it('collapses the same tile asked for twice while in flight', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { calls, fetchImpl } = recorder(async () => {
      await gate;
      return { ok: true };
    });
    const cache = createTileCache({ fetchImpl, decode });
    const first = cache.load(OSM, [tile(5, 5)]);
    const second = cache.load(OSM, [tile(5, 5)]);
    release();
    await Promise.all([first, second]);
    assert.equal(calls.length, 1);
  });

  it('keeps no more than the allowed number of requests in the air', async () => {
    let peak = 0;
    let inFlight = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { fetchImpl } = recorder(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return { ok: true };
    });
    const cache = createTileCache({ fetchImpl, decode, maxConcurrent: 3 });
    const tiles = Array.from({ length: 20 }, (unused, i) => tile(i, 0));
    const loading = cache.load(OSM, tiles);
    await Promise.resolve();
    release();
    await loading;
    assert.equal(peak, 3);
  });

  it('takes a 404 as final: the layer has no tile there', async () => {
    const { calls, fetchImpl } = recorder(() => ({ ok: false, status: 404 }));
    const cache = createTileCache({ fetchImpl, decode });
    await cache.load(OSM, [tile(3, 3)]);
    await cache.load(OSM, [tile(3, 3)]);
    assert.equal(calls.length, 1, 'a missing seamark tile should not be asked for twice');
    assert.equal(cache.peek('osm', tile(3, 3)), null);
    assert.equal(cache.stats.failed, 1);
  });

  // Treating a busy server as final was leaving permanent holes in the map that
  // no amount of scrubbing back would fill.
  it('tries again when the server was only busy', async () => {
    for (const status of [429, 500, 503]) {
      let clock = 0;
      let answer = { ok: false, status };
      const { calls, fetchImpl } = recorder(() => answer);
      const cache = createTileCache({ fetchImpl, decode, now: () => clock });
      await cache.load(OSM, [tile(6, 6)]);
      assert.equal(calls.length, 1, `${status}: first try`);
      clock = 10_000;
      answer = { ok: true };
      await cache.load(OSM, [tile(6, 6)]);
      assert.equal(calls.length, 2, `${status}: should have tried again`);
      assert.ok(cache.peek('osm', tile(6, 6)), `${status}: should have the tile now`);
    }
  });

  it('retries a tile the network dropped, once the wait is over', async () => {
    let clock = 0;
    const { calls, fetchImpl } = recorder(() => new TypeError('Failed to fetch'));
    const cache = createTileCache({ fetchImpl, decode, now: () => clock });
    await cache.load(OSM, [tile(4, 4)]);
    await cache.load(OSM, [tile(4, 4)]);
    assert.equal(calls.length, 1, 'should hold off straight away');
    clock = 60_000;
    await cache.load(OSM, [tile(4, 4)]);
    assert.equal(calls.length, 2, 'should try again later');
  });

  it('notices it is offline, and notices when it is not', async () => {
    let failing = true;
    const { fetchImpl } = recorder(() => (failing ? new TypeError('offline') : { ok: true }));
    let clock = 0;
    const cache = createTileCache({ fetchImpl, decode, now: () => clock });
    for (let i = 0; i < 5; i += 1) {
      await cache.load(OSM, [tile(i, 7)]);
    }
    assert.equal(cache.offline, true);
    failing = false;
    clock = 100_000;
    await cache.load(OSM, [tile(99, 7)]);
    assert.equal(cache.offline, false);
  });

  it('closes the bitmaps it evicts', async () => {
    const { fetchImpl } = recorder();
    const cache = createTileCache({ fetchImpl, decode, limit: 2 });
    await cache.load(OSM, [tile(1, 0), tile(2, 0)]);
    // Reading refreshes a tile, so read them in the order they should go: the
    // first one read is then the one furthest from view.
    const first = cache.peek('osm', tile(1, 0));
    cache.peek('osm', tile(2, 0));
    await cache.load(OSM, [tile(3, 0)]);
    assert.equal(first.closed, true, 'the evicted bitmap should have been closed');
    assert.equal(cache.peek('osm', tile(1, 0)), null);
    assert.equal(cache.stats.evicted, 1);
  });

  it('keeps what is on screen, evicting what was read longest ago', async () => {
    const { fetchImpl } = recorder();
    const cache = createTileCache({ fetchImpl, decode, limit: 2 });
    await cache.load(OSM, [tile(1, 0), tile(2, 0)]);
    cache.peek('osm', tile(1, 0)); // still in view
    await cache.load(OSM, [tile(3, 0)]);
    assert.ok(cache.peek('osm', tile(1, 0)), 'the tile last looked at should have stayed');
    assert.equal(cache.peek('osm', tile(2, 0)), null);
  });

  it('closes everything when it is emptied', async () => {
    const { fetchImpl } = recorder();
    const cache = createTileCache({ fetchImpl, decode });
    await cache.load(OSM, [tile(1, 0), tile(2, 0)]);
    const bitmap = cache.peek('osm', tile(1, 0));
    cache.clear();
    assert.equal(bitmap.closed, true);
    assert.equal(cache.peek('osm', tile(1, 0)), null);
  });

  it('reports progress from nothing to everything', async () => {
    const { fetchImpl } = recorder();
    const cache = createTileCache({ fetchImpl, decode });
    const seen = [];
    const tiles = Array.from({ length: 6 }, (unused, i) => tile(i, 2));
    await cache.load(OSM, tiles, (progress) => seen.push({ ...progress }));
    assert.equal(seen[0].done, 0);
    assert.equal(seen[seen.length - 1].done, 6);
    for (const step of seen) {
      assert.equal(step.total, 6);
    }
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i].done >= seen[i - 1].done, 'progress should never go backwards');
    }
  });

  it('waits for every tile of a frame before it is called done', async () => {
    const { fetchImpl } = recorder();
    const cache = createTileCache({ fetchImpl, decode });
    const frame = Array.from({ length: 12 }, (unused, i) => tile(i, 4));
    await cache.load(OSM, frame);
    // What an exported frame relies on: the whole map is there before it draws.
    for (const each of frame) {
      assert.ok(cache.peek('osm', each), `tile ${each.x} is missing`);
    }
  });

  it('gives up on an aborted load without losing what arrived', async () => {
    const controller = new AbortController();
    const { fetchImpl } = recorder(async (url, index) => {
      if (index > 1) {
        controller.abort();
        const error = new Error('aborted');
        error.name = 'AbortError';
        return error;
      }
      return { ok: true };
    });
    const cache = createTileCache({ fetchImpl, decode, maxConcurrent: 1 });
    await assert.rejects(
      () => cache.load(OSM, [tile(1, 9), tile(2, 9)], undefined, controller.signal),
      /aborted/
    );
    assert.ok(cache.peek('osm', tile(1, 9)), 'the tile that made it should still be there');
  });
});
