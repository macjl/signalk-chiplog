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
    const forecasts = [];
    for (const entry of entries.items) {
      const weather = await ctx.request('GET', `/entries/${entry.id}/weather`);
      forecasts.push(weather.status === 200 ? weather.body : null);
      const { body } = await ctx.request('GET', `/entries/${entry.id}/events?limit=500`);
      body.items.forEach((event) => types.add(event.type));
      assert.ok(entry.startTanks.length > 0, `passage ${entry.id} notes its tanks`);
      assert.ok(entry.startBatteries.length > 0, `passage ${entry.id} notes its batteries`);
      const track = await ctx.request('GET', `/entries/${entry.id}/track`);
      assert.equal(track.body.geometry.type, 'LineString');
    }
    assert.ok(forecasts.includes(null), 'a passage without a weather forecast');
    const stormy = forecasts.find((forecast) => forecast?.points.some((p) => p.weatherCode >= 95));
    assert.ok(stormy, 'a forecast with a thunderstorm');
    assert.equal(stormy.points.length, 24);
    assert.ok(stormy.points.every((point) => typeof point.currentSpeed === 'number'));
    assert.deepEqual([...types].sort(), [
      'autopilot',
      'handwritten_annotation',
      'manoeuvre',
      'manual_correction',
      'propulsion_change',
      'sk_alarm',
      'stopover',
      'text_annotation',
      'weather_threshold'
    ]);
  });

  // The animation (SPEC §4.12) strings the range's passages together, so the
  // demo has to offer passages of different sizes and a night in port.
  it('covers what the animation needs', async () => {
    const { buildLegs, buildStoryboard, OVERNIGHT_HOLD_UNITS } =
      await import('../public/js/animation/storyboard.mjs');
    const { fitZoom, MAX_WIDEN_LEVELS, referenceBounds } =
      await import('../public/js/animation/camera.mjs');
    const { trackPoints } = await import('../public/js/track.mjs');

    const { body: entries } = await ctx.request('GET', '/entries');
    const passages = [];
    for (const entry of entries.items) {
      const track = await ctx.request('GET', `/entries/${entry.id}/track`);
      passages.push({ entry, points: trackPoints(track.body) });
    }

    const legs = buildLegs(passages, { width: 1920, height: 1080 });
    assert.equal(legs.length, entries.items.length, 'every demo passage is animatable');
    // Coastal hops of a few miles: each is animated at the working scale rather
    // than magnified to its own extent, and none is pulled wider than the cap.
    for (const leg of legs) {
      const centre = { lat: leg.bounds.centreLat, lon: leg.bounds.centreLon };
      const working = fitZoom(referenceBounds(centre), { width: 1920, height: 1080 });
      assert.ok(leg.frame.zoom <= working, `passage ${leg.entry.id} is magnified`);
      assert.ok(
        leg.frame.zoom >= working - MAX_WIDEN_LEVELS,
        `passage ${leg.entry.id} is too wide`
      );
    }

    const board = buildStoryboard(legs);
    assert.ok(
      board.segments.some(
        (segment) => segment.kind === 'hold' && segment.units === OVERNIGHT_HOLD_UNITS
      ),
      'a night in port, for the longer rest between legs'
    );
    // The range spans days; the animation must still be seconds long.
    assert.ok(board.totalUnits < 60, `${board.totalUnits} units is too long for the demo range`);
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
