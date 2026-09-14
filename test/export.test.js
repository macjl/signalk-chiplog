const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { at, startServer, insert, insertEntry } = require('./helpers');

function seedPassage(db) {
  const entryId = insertEntry(db, {
    start_time: at(0),
    end_time: at(4),
    start_lat: 46.1591,
    start_lon: -1.1522,
    end_lat: 46.5,
    end_lon: -1.79,
    start_place_name: 'La Rochelle',
    end_place_name: 'Les Sables',
    distance: 68500
  });
  insert(db, 'track_points', { entry_id: entryId, time: at(0), lat: 46.1591, lon: -1.1522 });
  insert(db, 'track_points', { entry_id: entryId, time: at(1), lat: 46.25, lon: -1.3 });
  insert(db, 'observations', {
    entry_id: entryId,
    time: at(1),
    reason: 'periodic',
    lat: 46.25,
    lon: -1.3,
    sog: 3.086667,
    cog: Math.PI / 2,
    tws: 7.716667,
    twd: 2 * Math.PI - 0.001,
    awa: -Math.PI / 4,
    pressure: 101325,
    water_temp: 291.15
  });
  insert(db, 'events', {
    entry_id: entryId,
    time: at(2),
    type: 'text_annotation',
    comment: '=HYPERLINK("evil"), with "quotes"',
    created_at: at(2)
  });
  return entryId;
}

describe('export', () => {
  let ctx;
  let exportDir;

  beforeEach(async () => {
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-usb-'));
    ctx = await startServer({ config: { usbExportPath: exportDir } });
  });

  afterEach(async () => {
    await ctx.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  describe('GET /entries/:id/track', () => {
    it('returns GeoJSON by default', async () => {
      const id = seedPassage(ctx.db);
      const { status, body } = await ctx.request('GET', `/entries/${id}/track`);

      assert.equal(status, 200);
      assert.equal(body.type, 'Feature');
      assert.equal(body.geometry.type, 'LineString');
      assert.deepEqual(body.geometry.coordinates[0], [-1.1522, 46.1591]);
      assert.deepEqual(body.properties.coordTimes, [at(0), at(1)]);
    });

    it('returns GPX on request', async () => {
      const id = seedPassage(ctx.db);
      const { status, headers, text } = await ctx.request('GET', `/entries/${id}/track?format=gpx`);

      assert.equal(status, 200);
      assert.match(headers.get('content-type'), /application\/gpx\+xml/);
      assert.match(text, /<name>La Rochelle - Les Sables<\/name>/);
      assert.equal(text.match(/<trkpt /g).length, 2);
    });
  });

  describe('GET /export', () => {
    it('exports the complete logbook as JSON in SI units', async () => {
      seedPassage(ctx.db);
      const { status, headers, body } = await ctx.request('GET', '/export');

      assert.equal(status, 200);
      assert.match(headers.get('content-disposition'), /chiplog\.json/);
      assert.equal(body.schemaVersion, 4);
      assert.equal(body.entries.length, 1);
      const [bundle] = body.entries;
      assert.equal(bundle.entry.distance, 68500);
      assert.equal(bundle.trackPoints.length, 2);
      assert.equal(bundle.observations[0].sog, 3.086667);
      assert.equal(bundle.events.length, 1);
    });

    it('exports CSV logbook lines converted to nautical units', async () => {
      seedPassage(ctx.db);
      const { status, headers, text } = await ctx.request('GET', '/export?format=csv');

      assert.equal(status, 200);
      assert.match(headers.get('content-type'), /text\/csv/);

      const [header, ...rows] = text.trim().split('\r\n');
      const columns = header.split(',');
      assert.deepEqual(
        rows.map((row) => row.split(',')[columns.indexOf('kind')]),
        ['departure', 'observation', 'event', 'arrival']
      );

      const observation = Object.fromEntries(
        rows[1].split(',').map((value, index) => [columns[index], value])
      );
      assert.equal(observation.sog_kn, '6');
      assert.equal(observation.cog_deg, '90');
      assert.equal(observation.tws_kn, '15');
      assert.equal(observation.twd_deg, '0');
      assert.equal(observation.awa_deg, '-45');
      assert.equal(observation.pressure_hpa, '1013.3');
      assert.equal(observation.water_temp_c, '18');
    });

    it('neutralises spreadsheet formulas and escapes quotes in free text', async () => {
      seedPassage(ctx.db);
      const { text } = await ctx.request('GET', '/export?format=csv');
      assert.ok(text.includes(`"'=HYPERLINK(""evil""), with ""quotes"""`));
    });

    it('limits the export to a date range', async () => {
      seedPassage(ctx.db);
      insertEntry(ctx.db, { start_time: at(48), end_time: at(50) });

      const { body } = await ctx.request('GET', `/export?from=${encodeURIComponent(at(24))}`);
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0].entry.startTime, at(48));
    });

    it('answers 501 for PDF, which arrives in V1.1', async () => {
      const { status, body } = await ctx.request('GET', '/export?format=pdf');
      assert.equal(status, 501);
      assert.equal(body.error.code, 'not_implemented');
    });
  });

  describe('POST /export/usb', () => {
    it('writes JSON, CSV and GPX to the configured directory', async () => {
      seedPassage(ctx.db);

      const { status, body } = await ctx.request('POST', '/export/usb');

      assert.equal(status, 200);
      assert.equal(body.entries, 1);
      assert.deepEqual(fs.readdirSync(exportDir).sort(), [
        'chiplog.csv',
        'chiplog.gpx',
        'chiplog.json'
      ]);
      const json = JSON.parse(fs.readFileSync(path.join(exportDir, 'chiplog.json'), 'utf8'));
      assert.equal(json.entries.length, 1);
    });

    it('answers 409 when the directory is not available', async () => {
      fs.rmSync(exportDir, { recursive: true, force: true });
      const { status, body } = await ctx.request('POST', '/export/usb');
      assert.equal(status, 409);
      assert.equal(body.error.code, 'usb_export_unavailable');
    });
  });
});

describe('export without a USB directory configured', () => {
  it('answers 409', async () => {
    const ctx = await startServer();
    try {
      const { status, body } = await ctx.request('POST', '/export/usb');
      assert.equal(status, 409);
      assert.equal(body.error.code, 'usb_export_not_configured');
    } finally {
      await ctx.close();
    }
  });
});
