const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { createUsbExportScheduler, USB_EXPORT_DEFAULTS } = require('../lib/usb-scheduler');
const { at, startServer, insertEntry } = require('./helpers');

const MINUTE = 60 * 1000;
const T0 = Date.parse('2026-09-13T08:00:00.000Z');

function setup({ settings = {}, fail = null } = {}) {
  const clock = { now: T0 };
  const writes = [];
  const logs = [];
  const control = { fail, release: null, hold: false };
  const write = async (db, directory, now) => {
    writes.push({ directory, now });
    if (control.hold) {
      await new Promise((resolve) => {
        control.release = resolve;
      });
    }
    if (control.fail) {
      throw Object.assign(new Error(control.fail), { code: 'usb_export_unavailable' });
    }
    return { entries: 3, written: 1, unchanged: 2, removed: [] };
  };
  const scheduler = createUsbExportScheduler({
    db: null,
    settings: { ...USB_EXPORT_DEFAULTS, usbExportPath: '/media/usb', ...settings },
    clock: () => clock.now,
    write,
    log: (level, message) => logs.push({ level, message })
  });
  const advance = async (minutes) => {
    clock.now += minutes * MINUTE;
    scheduler.tick();
    await settle();
  };
  return { scheduler, clock, writes, logs, control, advance };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('USB copy scheduler', () => {
  it('copies a minute after start, then at the configured interval', async () => {
    const { writes, advance } = setup({ settings: { usbExportIntervalMinutes: 10 } });

    await advance(0.5);
    assert.equal(writes.length, 0, 'the drive gets time to mount');
    await advance(0.5);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].directory, '/media/usb');
    await advance(9);
    assert.equal(writes.length, 1);
    await advance(1);
    assert.equal(writes.length, 2);
  });

  it('copies periodically only when an interval is set', async () => {
    const { writes, advance, scheduler } = setup({ settings: { usbExportIntervalMinutes: 0 } });
    await advance(120);
    assert.equal(writes.length, 0);
    assert.equal(scheduler.status().nextAt, null);
  });

  it('does nothing without a USB directory', async () => {
    const { writes, advance, scheduler } = setup({ settings: { usbExportPath: null } });
    scheduler.afterDetection({ activeEntryId: 1 });
    scheduler.afterDetection({ activeEntryId: null });
    await advance(120);
    assert.equal(writes.length, 0);
    assert.equal(scheduler.status().configured, false);
  });

  it('copies when a passage ends or gives way to another, not at start-up', async () => {
    const { writes, scheduler } = setup({ settings: { usbExportIntervalMinutes: 0 } });

    scheduler.afterDetection({ activeEntryId: 4 });
    scheduler.afterDetection({ activeEntryId: 4 });
    await settle();
    assert.equal(writes.length, 0);

    scheduler.afterDetection({ activeEntryId: null });
    await settle();
    assert.equal(writes.length, 1);

    scheduler.afterDetection({ activeEntryId: null });
    scheduler.afterDetection({ activeEntryId: 5 });
    await settle();
    assert.equal(writes.length, 1, 'a departure is no arrival');

    scheduler.afterDetection({ activeEntryId: 6 });
    await settle();
    assert.equal(writes.length, 2);
  });

  it('can leave arrivals to the periodic copy', async () => {
    const { writes, scheduler } = setup({
      settings: { usbExportIntervalMinutes: 0, usbExportOnArrival: false }
    });
    scheduler.afterDetection({ activeEntryId: 4 });
    scheduler.afterDetection({ activeEntryId: null });
    await settle();
    assert.equal(writes.length, 0);
  });

  it('never writes twice at once, and serves requests made meanwhile with one more copy', async () => {
    const { writes, scheduler, control } = setup({ settings: { usbExportIntervalMinutes: 0 } });
    control.hold = true;

    const first = scheduler.run('manual');
    await settle();
    assert.equal(scheduler.status().running, true);
    const second = scheduler.run('arrival');
    const third = scheduler.run('manual');
    assert.equal(second, third);
    await settle();
    assert.equal(writes.length, 1);

    control.release();
    await first;
    await settle();
    assert.equal(writes.length, 2);
    control.release();
    await second;
    assert.equal(scheduler.status().running, false);
  });

  it('reports the last copy and a failure once, until it recovers', async () => {
    const { scheduler, logs, control, advance } = setup({
      settings: { usbExportIntervalMinutes: 15 },
      fail: 'Export directory /media/usb is not available; is the USB drive mounted?'
    });

    await advance(1);
    await advance(15);
    await advance(15);
    const { lastError, lastSuccess } = scheduler.status();
    assert.equal(lastSuccess, null);
    assert.equal(lastError.code, 'usb_export_unavailable');
    assert.equal(lastError.reason, 'scheduled');
    assert.equal(logs.filter((entry) => entry.level === 'error').length, 1);

    control.fail = null;
    await advance(15);
    const recovered = scheduler.status();
    assert.equal(recovered.lastError, null);
    assert.deepEqual(
      { ...recovered.lastSuccess, at: undefined },
      { at: undefined, reason: 'scheduled', entries: 3, written: 1, unchanged: 2, removed: 0 }
    );
    assert.equal(recovered.nextAt, new Date(T0 + 61 * MINUTE).toISOString());
  });

  it('passes a failed manual copy on to its caller', async () => {
    const { scheduler } = setup({ fail: 'drive gone' });
    await assert.rejects(scheduler.run('manual'), /drive gone/);
  });

  it('stops scheduling once stopped', async () => {
    const { writes, scheduler, advance } = setup();
    scheduler.stop();
    scheduler.afterDetection({ activeEntryId: 1 });
    scheduler.afterDetection({ activeEntryId: null });
    await advance(60);
    assert.equal(writes.length, 0);
  });
});

describe('USB copy through the API', () => {
  let ctx;
  let exportDir;

  beforeEach(async () => {
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-usb-'));
    ctx = await startServer({
      config: { usbExportPath: exportDir, usbExportIntervalMinutes: 30 }
    });
  });

  afterEach(async () => {
    await ctx.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it('reports the schedule and the last copy to readonly users', async () => {
    insertEntry(ctx.db, { start_place_name: 'A', end_place_name: 'B', end_time: at(1) });

    const before = await ctx.request('GET', '/export/usb');
    assert.equal(before.status, 200);
    assert.equal(before.body.directory, exportDir);
    assert.equal(before.body.intervalMinutes, 30);
    assert.equal(before.body.onArrival, true);
    assert.equal(before.body.lastSuccess, null);
    assert.ok(
      ctx.permissions.some(
        (route) =>
          route.method === 'GET' && route.path === '/api/export/usb' && route.level === 'readonly'
      )
    );

    await ctx.request('POST', '/export/usb');
    const after = await ctx.request('GET', '/export/usb');
    assert.equal(after.body.lastSuccess.reason, 'manual');
    assert.equal(after.body.lastSuccess.written, 1);
  });

  it('reports a failed manual copy', async () => {
    fs.rmSync(exportDir, { recursive: true, force: true });
    await ctx.request('POST', '/export/usb');
    const { body } = await ctx.request('GET', '/export/usb');
    assert.equal(body.lastError.code, 'usb_export_unavailable');
    assert.equal(body.lastError.reason, 'manual');
  });

  it('copies when a passage closes, on the next detection cycle', async (t) => {
    await ctx.close();
    t.mock.timers.enable({ apis: ['setInterval'] });
    ctx = await startServer({
      config: { usbExportPath: exportDir, usbExportIntervalMinutes: 0 }
    });
    const entryId = insertEntry(ctx.db, {
      state: 'active',
      start_time: at(0),
      start_place_name: 'A'
    });
    t.mock.timers.tick(15 * 1000);

    await ctx.request('POST', `/entries/${entryId}/close`);
    t.mock.timers.tick(15 * 1000);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(exportDir, 'chiplog')); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { body } = await ctx.request('GET', '/export/usb');
    assert.equal(body.lastSuccess?.reason, 'arrival');
    assert.equal(
      fs
        .readdirSync(path.join(exportDir, 'chiplog'))
        .filter((f) => f.endsWith('.json') && !f.startsWith('.')).length,
      1
    );
  });
});
