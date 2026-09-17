const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { seedDemoLogbook } = require('../scripts/seed-demo');
const { startServer } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-demo.js');

describe('demo logbook', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
    seedDemoLogbook(ctx.db);
  });

  afterEach(() => ctx.close());

  it('reads back through the API as four recent passages, the last in progress', async () => {
    const { body } = await ctx.request('GET', '/entries');

    assert.equal(body.total, 4);
    assert.deepEqual(
      body.items.map((entry) => entry.state),
      ['active', 'closed', 'closed', 'closed']
    );
    for (const entry of body.items) {
      assert.ok(entry.distance > 1000, `passage ${entry.id} has a track distance`);
      assert.ok(entry.engineDuration + entry.sailDuration > 0, `passage ${entry.id} has segments`);
    }
  });

  it('covers what the webapp displays', async () => {
    const { body: entries } = await ctx.request('GET', '/entries');
    const night = entries.items.find((entry) => entry.endPlacePending);
    assert.ok(night, 'an arrival name pending geocoding');
    assert.notEqual(
      new Date(night.startTime).getDate(),
      new Date(night.endTime).getDate(),
      'a passage across midnight'
    );

    const types = new Set();
    for (const entry of entries.items) {
      const { body } = await ctx.request('GET', `/entries/${entry.id}/events?limit=500`);
      body.items.forEach((event) => types.add(event.type));
      assert.ok(entry.startTanks.length > 0, `passage ${entry.id} notes its tanks`);
      assert.ok(entry.startBatteries.length > 0, `passage ${entry.id} notes its batteries`);
      const track = await ctx.request('GET', `/entries/${entry.id}/track`);
      assert.equal(track.body.geometry.type, 'LineString');
    }
    assert.deepEqual([...types].sort(), [
      'autopilot',
      'handwritten_annotation',
      'manoeuvre',
      'manual_correction',
      'propulsion_change',
      'sk_alarm',
      'text_annotation',
      'weather_threshold'
    ]);
  });
});

describe('demo logbook script', () => {
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-demo-'));
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('seeds an empty directory and refuses a logbook that already has passages', () => {
    const first = spawnSync(process.execPath, [SCRIPT, directory], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Seeded 4 passages/);

    const second = spawnSync(process.execPath, [SCRIPT, directory], { encoding: 'utf8' });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already holds 4 passage\(s\); nothing was added/);
  });

  it('explains its usage without a directory', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Usage/);
  });
});
