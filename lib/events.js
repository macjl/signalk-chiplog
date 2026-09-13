const { ApiError, badRequest, notFound } = require('./errors');
const { requireEntryRow } = require('./entries');
const { toPosition, paginate } = require('./rows');
const { isPlainObject } = require('./validation');

const EVENT_TYPES = [
  'manoeuvre',
  'text_annotation',
  'handwritten_annotation',
  'sk_alarm',
  'autopilot',
  'weather_threshold',
  'manual_correction'
];

// The other event types are produced by the plugin itself from Signal K data
// or from corrections, never posted by a client.
const CLIENT_EVENT_TYPES = ['manoeuvre', 'text_annotation', 'handwritten_annotation'];

function toEvent(row) {
  return {
    id: row.id,
    entryId: row.entry_id,
    time: row.time,
    type: row.type,
    subtype: row.subtype,
    position: toPosition(row.lat, row.lon),
    comment: row.comment,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    source: row.source,
    createdAt: row.created_at
  };
}

function requireEventRow(db, id) {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!row) {
    throw notFound('event', id);
  }
  return row;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidStrokes(payload) {
  const strokes = isPlainObject(payload) ? payload.strokes : undefined;
  return (
    Array.isArray(strokes) &&
    strokes.length > 0 &&
    strokes.every(
      (stroke) =>
        isPlainObject(stroke) &&
        Array.isArray(stroke.points) &&
        stroke.points.length > 0 &&
        stroke.points.every(
          (point) =>
            isPlainObject(point) &&
            isFiniteNumber(point.x) &&
            isFiniteNumber(point.y) &&
            isFiniteNumber(point.t) &&
            (point.pressure === undefined || isFiniteNumber(point.pressure))
        )
    )
  );
}

function validateContent(db, { type, subtype, comment, payload }) {
  if (type === 'manoeuvre') {
    if (!subtype) {
      throw badRequest('A manoeuvre event requires subtype, the manoeuvre key');
    }
    if (!db.prepare('SELECT 1 FROM manoeuvre_types WHERE key = ?').get(subtype)) {
      throw new ApiError(400, 'unknown_manoeuvre_type', `Unknown manoeuvre type: ${subtype}`);
    }
  }
  if (type === 'text_annotation' && !comment) {
    throw badRequest('A text annotation requires a comment');
  }
  if (type === 'handwritten_annotation' && !isValidStrokes(payload)) {
    throw badRequest(
      'A handwritten annotation requires payload.strokes: [{ points: [{ x, y, t, pressure? }] }]'
    );
  }
}

function serializePayload(payload) {
  return payload === undefined || payload === null ? null : JSON.stringify(payload);
}

function listEvents(db, entryId, { type, limit, offset }) {
  requireEntryRow(db, entryId);
  return paginate(db, {
    table: 'events',
    where: type === undefined ? 'WHERE entry_id = ?' : 'WHERE entry_id = ? AND type = ?',
    params: type === undefined ? [entryId] : [entryId, type],
    orderBy: 'time, id',
    limit,
    offset,
    map: toEvent
  });
}

function allEvents(db, entryId) {
  return db
    .prepare('SELECT * FROM events WHERE entry_id = ? ORDER BY time, id')
    .all(entryId)
    .map(toEvent);
}

function createEvent(db, entryId, input, { now, vesselPosition }) {
  requireEntryRow(db, entryId);
  validateContent(db, input);

  const position = input.position === undefined ? vesselPosition : input.position;
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO events (entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
    )
    .run(
      entryId,
      input.time ?? now,
      input.type,
      input.subtype ?? null,
      position ? position.lat : null,
      position ? position.lon : null,
      input.comment ?? null,
      serializePayload(input.payload),
      now
    );

  return toEvent(requireEventRow(db, Number(lastInsertRowid)));
}

function updateEvent(db, id, patch) {
  const current = toEvent(requireEventRow(db, id));

  if (!CLIENT_EVENT_TYPES.includes(current.type)) {
    const disallowed = Object.keys(patch).filter((field) => field !== 'comment');
    if (disallowed.length > 0) {
      throw badRequest(`Only comment can be edited on a ${current.type} event`);
    }
  }

  const next = { ...current, ...patch };
  validateContent(db, next);

  db.prepare('UPDATE events SET time = ?, subtype = ?, comment = ?, payload = ? WHERE id = ?').run(
    next.time,
    next.subtype,
    next.comment,
    serializePayload(next.payload),
    id
  );

  return toEvent(requireEventRow(db, id));
}

function deleteEvent(db, id) {
  requireEventRow(db, id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
}

module.exports = {
  EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  listEvents,
  allEvents,
  createEvent,
  updateEvent,
  deleteEvent
};
