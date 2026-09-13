const { withTransaction } = require('./database');
const { notFound } = require('./errors');
const { requireEntryRow, recomputeDurations } = require('./entries');
const { paginate } = require('./rows');

function toSegment(row) {
  return {
    id: row.id,
    entryId: row.entry_id,
    type: row.type,
    startTime: row.start_time,
    endTime: row.end_time,
    source: row.source,
    averageRpm: row.average_rpm
  };
}

function requireSegmentRow(db, id) {
  const row = db.prepare('SELECT * FROM propulsion_segments WHERE id = ?').get(id);
  if (!row) {
    throw notFound('propulsion_segment', id);
  }
  return row;
}

function listSegments(db, entryId, { limit, offset }) {
  requireEntryRow(db, entryId);
  return paginate(db, {
    table: 'propulsion_segments',
    where: 'WHERE entry_id = ?',
    params: [entryId],
    orderBy: 'start_time, id',
    limit,
    offset,
    map: toSegment
  });
}

function allSegments(db, entryId) {
  return db
    .prepare('SELECT * FROM propulsion_segments WHERE entry_id = ? ORDER BY start_time, id')
    .all(entryId)
    .map(toSegment);
}

function correctSegment(db, id, { type }, { now }) {
  return withTransaction(db, () => {
    const row = requireSegmentRow(db, id);
    if (row.type === type) {
      return toSegment(row);
    }

    db.prepare("UPDATE propulsion_segments SET type = ?, source = 'manual' WHERE id = ?").run(
      type,
      id
    );
    recomputeDurations(db, row.entry_id, now);

    // Placed at the segment's start so the timeline shows the correction where
    // it applies; created_at still records when it was made.
    db.prepare(
      `INSERT INTO events (entry_id, time, type, subtype, payload, source, created_at)
       VALUES (?, ?, 'manual_correction', 'propulsion', ?, 'manual', ?)`
    ).run(
      row.entry_id,
      row.start_time,
      JSON.stringify({ segmentId: id, before: { type: row.type }, after: { type } }),
      now
    );

    return toSegment(requireSegmentRow(db, id));
  });
}

module.exports = { listSegments, allSegments, correctSegment };
