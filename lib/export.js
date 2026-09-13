const fs = require('node:fs/promises');
const path = require('node:path');
const { getSchemaVersion } = require('./database');
const { conflict } = require('./errors');
const { toEntry } = require('./entries');
const { allEvents } = require('./events');
const { toCsv, toGpx } = require('./formats');
const { allSegments } = require('./propulsion');
const { allTrackPoints, allObservations } = require('./track');

const EXPORT_FORMATS = {
  json: {
    contentType: 'application/json',
    render: (bundles, meta) => `${JSON.stringify({ ...meta, entries: bundles }, null, 2)}\n`
  },
  csv: { contentType: 'text/csv; charset=utf-8', render: toCsv },
  gpx: { contentType: 'application/gpx+xml', render: toGpx }
};

function collectBundles(db, { from, to }) {
  const conditions = [];
  const params = [];
  if (from !== undefined) {
    conditions.push('start_time >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    conditions.push('start_time < ?');
    params.push(to);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db
    .prepare(`SELECT * FROM log_entries ${where} ORDER BY start_time, id`)
    .all(...params)
    .map((row) => ({
      entry: toEntry(row),
      trackPoints: allTrackPoints(db, row.id),
      observations: allObservations(db, row.id),
      propulsion: allSegments(db, row.id),
      events: allEvents(db, row.id)
    }));
}

function exportMeta(db, now) {
  return { exportedAt: now, schemaVersion: getSchemaVersion(db), units: 'Signal K SI' };
}

function renderExport(db, format, range, now) {
  const { contentType, render } = EXPORT_FORMATS[format];
  return {
    contentType,
    filename: `chiplog.${format}`,
    body: render(collectBundles(db, range), exportMeta(db, now))
  };
}

// The drive may be pulled the moment a write returns when abandoning ship, so
// flush to the device before the rename makes the new file visible.
async function writeFileDurably(target, contents) {
  const temporary = `${target}.tmp`;
  const handle = await fs.open(temporary, 'w');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
}

async function writeUsbExport(db, directory, now) {
  const stats = await fs.stat(directory).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw conflict(
      'usb_export_unavailable',
      `Export directory ${directory} is not available; is the USB drive mounted?`
    );
  }

  const bundles = collectBundles(db, {});
  const meta = exportMeta(db, now);
  const files = [];
  for (const [format, { render }] of Object.entries(EXPORT_FORMATS)) {
    const target = path.join(directory, `chiplog.${format}`);
    await writeFileDurably(target, render(bundles, meta));
    files.push(target);
  }

  return { directory, files, entries: bundles.length };
}

module.exports = { EXPORT_FORMATS, renderExport, writeUsbExport };
