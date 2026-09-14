const { withTransaction } = require('./database');
const { ApiError, badRequest, conflict, notFound } = require('./errors');
const { activeEntryId, entryNearArrival, openEntryByHand, requireEntryRow } = require('./entries');
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

// Logged with no passage open, these open one: the crew is leaving.
const DEPARTURE_MANOEUVRES = new Set(['cast_off', 'anchor_up']);

// An entry logged after the fact — typically replayed from the tablet's offline
// queue — takes the position the track recorded at its time.
const TRACK_POSITION_WINDOW_MS = 2 * 60 * 1000;
const CURRENT_POSITION_WINDOW_MS = 5 * 60 * 1000;

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
    clientRef: row.client_ref,
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

function positionAt(db, time, { now, vesselPosition }) {
  if (time === undefined) {
    return vesselPosition;
  }
  const target = Date.parse(time);
  const nearest = [
    db.prepare(
      'SELECT time, lat, lon FROM track_points WHERE time <= ? ORDER BY time DESC LIMIT 1'
    ),
    db.prepare('SELECT time, lat, lon FROM track_points WHERE time >= ? ORDER BY time LIMIT 1')
  ]
    .map((statement) => statement.get(time))
    .filter(
      (point) => point && Math.abs(Date.parse(point.time) - target) <= TRACK_POSITION_WINDOW_MS
    )
    .sort(
      (a, b) => Math.abs(Date.parse(a.time) - target) - Math.abs(Date.parse(b.time) - target)
    )[0];
  if (nearest) {
    return { lat: nearest.lat, lon: nearest.lon };
  }
  return Math.abs(Date.parse(now) - target) <= CURRENT_POSITION_WINDOW_MS ? vesselPosition : null;
}

function findByClientRef(db, clientRef) {
  if (clientRef === undefined) {
    return null;
  }
  const row = db.prepare('SELECT * FROM events WHERE client_ref = ?').get(clientRef);
  return row ? toEvent(row) : null;
}

function insertEvent(db, entryId, input, position, now) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO events (
         entry_id, time, type, subtype, lat, lon, comment, payload, source, client_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
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
      input.clientRef ?? null,
      now
    );
  return toEvent(requireEventRow(db, Number(lastInsertRowid)));
}

// Returns { event, created }: a clientRef already logged answers with that
// event instead of a duplicate.
function createEvent(db, entryId, input, context) {
  requireEntryRow(db, entryId);
  validateContent(db, input);
  const existing = findByClientRef(db, input.clientRef);
  if (existing) {
    return { event: existing, created: false };
  }
  const position =
    input.position === undefined ? positionAt(db, input.time, context) : input.position;
  return { event: insertEvent(db, entryId, input, position, context.now), created: true };
}

// An entry from the crew, attached to the passage it belongs to: the open one;
// failing that, a departure manoeuvre opens one; failing that, the last
// passage while the vessel is still at its arrival.
function logCrewEvent(db, input, context) {
  validateContent(db, input);
  return withTransaction(db, () => {
    const existing = findByClientRef(db, input.clientRef);
    if (existing) {
      return { event: existing, created: false, openedEntry: false };
    }
    const position =
      input.position === undefined ? positionAt(db, input.time, context) : input.position;
    const time = input.time ?? context.now;

    let entryId = activeEntryId(db);
    let openedEntry = false;
    if (entryId === null && input.type === 'manoeuvre' && DEPARTURE_MANOEUVRES.has(input.subtype)) {
      entryId = openEntryByHand(db, {
        time,
        position,
        placeMatchRadius: context.placeMatchRadius,
        now: context.now
      });
      openedEntry = true;
    }
    entryId ??= entryNearArrival(db, position);
    if (entryId === null) {
      throw conflict(
        'no_passage',
        'No passage is open and the vessel is not at the last arrival; cast off or weigh anchor first'
      );
    }

    const event = insertEvent(db, entryId, input, position, context.now);
    if (openedEntry) {
      db.prepare('UPDATE log_entries SET opened_by_event_id = ? WHERE id = ?').run(
        event.id,
        entryId
      );
    }
    return { event, created: true, openedEntry };
  });
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

// Undoing the departure that opened a passage, before the vessel moved and
// before anything else was logged in it, takes the passage away too.
function deleteEvent(db, id) {
  requireEventRow(db, id);
  withTransaction(db, () => {
    const opened = db
      .prepare(
        `SELECT id FROM log_entries
         WHERE opened_by_event_id = ? AND state = 'active' AND last_moving_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM events WHERE entry_id = log_entries.id AND id <> ?)`
      )
      .get(id, id);
    if (opened) {
      db.prepare('DELETE FROM log_entries WHERE id = ?').run(opened.id);
    } else {
      db.prepare('DELETE FROM events WHERE id = ?').run(id);
    }
  });
}

module.exports = {
  EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  listEvents,
  allEvents,
  createEvent,
  logCrewEvent,
  updateEvent,
  deleteEvent
};
