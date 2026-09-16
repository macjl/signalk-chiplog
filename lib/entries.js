const { withTransaction } = require('./database');
const { badRequest, conflict, notFound } = require('./errors');
const { coordinatesName, initialPlaceName } = require('./place-names');
const { distanceBetween, rememberPlaceName } = require('./places');
const { toPosition, paginate } = require('./rows');

const CHILD_TABLES = ['track_points', 'observations', 'propulsion_segments', 'events'];

// Still this close to where the last passage ended, the vessel is at that
// passage's destination: an alarm or a note there belongs to it.
const STILL_AT_ARRIVAL_METRES = 1852;

function toEntry(row) {
  return {
    id: row.id,
    state: row.state,
    startTime: row.start_time,
    endTime: row.end_time,
    stoppedSince: row.stopped_since,
    startPosition: toPosition(row.start_lat, row.start_lon),
    endPosition: toPosition(row.end_lat, row.end_lon),
    startPlaceId: row.start_place_id,
    endPlaceId: row.end_place_id,
    startPlaceName: row.start_place_name,
    endPlaceName: row.end_place_name,
    startPlacePending: row.start_place_pending === 1,
    endPlacePending: row.end_place_pending === 1,
    distance: row.distance,
    engineDuration: row.engine_duration,
    sailDuration: row.sail_duration,
    openedByEventId: row.opened_by_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireEntryRow(db, id) {
  const row = db.prepare('SELECT * FROM log_entries WHERE id = ?').get(id);
  if (!row) {
    throw notFound('entry', id);
  }
  return row;
}

// Shared by listEntries and getStats, so a date range means the same thing
// to both: matched on startTime, from inclusive and to exclusive.
function rangeWhere({ from, to }) {
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
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

function listEntries(db, { from, to, limit, offset }) {
  const { where, params } = rangeWhere({ from, to });
  return paginate(db, {
    table: 'log_entries',
    where,
    params,
    orderBy: 'start_time DESC, id DESC',
    limit,
    offset,
    map: toEntry
  });
}

// Totals across every entry matching the range, for a summary line above the
// day-grouped list -- not just what happens to be loaded on the page.
function getStats(db, { from, to, now }) {
  const { where, params } = rangeWhere({ from, to });
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM(distance), 0) AS distance,
         COALESCE(SUM(MAX(0, (julianday(COALESCE(end_time, ?)) - julianday(start_time)) * 86400)), 0)
           AS duration
       FROM log_entries ${where}`
    )
    .get(now, ...params);
  return { count: row.count, distance: row.distance, duration: Math.round(row.duration) };
}

function getEntry(db, id) {
  const entry = toEntry(requireEntryRow(db, id));
  const count = (table) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE entry_id = ?`).get(id).n;
  const maxSpeed = db
    .prepare('SELECT MAX(sog) AS value FROM track_points WHERE entry_id = ?')
    .get(id).value;
  // True wind, published or derived, is preferred throughout; apparent only
  // stands in when the boat never had a true-wind source on this passage.
  // Track points give a far denser reading than the hourly snapshots, so both
  // are combined for the highest one actually seen.
  const wind = db
    .prepare(
      `SELECT MAX(tws) AS tws, MAX(aws) AS aws FROM (
         SELECT tws, aws FROM track_points WHERE entry_id = ?
         UNION ALL
         SELECT tws, aws FROM observations WHERE entry_id = ?
       )`
    )
    .get(id, id);
  return {
    ...entry,
    counts: {
      trackPoints: count('track_points'),
      observations: count('observations'),
      events: count('events')
    },
    maxSpeed,
    maxWindSpeed: wind.tws ?? wind.aws,
    maxWindApparent: wind.tws === null && wind.aws !== null
  };
}

// A segment still open counts up to `now`, so the totals of a passage in
// progress stay current.
function recomputeDurations(db, entryId, now) {
  const totals = db
    .prepare(
      `SELECT type,
         SUM(MAX(0, (julianday(COALESCE(end_time, ?)) - julianday(start_time)) * 86400)) AS seconds
       FROM propulsion_segments
       WHERE entry_id = ?
       GROUP BY type`
    )
    .all(now, entryId);
  const secondsOf = (type) => Math.round(totals.find((t) => t.type === type)?.seconds ?? 0);
  db.prepare(
    'UPDATE log_entries SET engine_duration = ?, sail_duration = ?, updated_at = ? WHERE id = ?'
  ).run(secondsOf('engine'), secondsOf('sail'), now, entryId);
}

// A corrected name only reflects what was learned from this passage onward:
// an entry timestamped later that already reused the same place is renamed
// too, so the log does not go on showing what is now known to be wrong, but
// one timestamped earlier keeps the name it recorded — it was accurate then.
function renameLaterEntries(db, placeId, excludeId, sinceTime, name) {
  for (const side of ['start', 'end']) {
    db.prepare(
      `UPDATE log_entries SET ${side}_place_name = ?
       WHERE ${side}_place_id = ? AND id <> ? AND ${side}_time > ?`
    ).run(name, placeId, excludeId, sinceTime);
  }
}

function updateEntry(db, id, patch, { placeMatchRadius, now }) {
  return withTransaction(db, () => {
    const row = requireEntryRow(db, id);
    const next = { ...row };

    if (patch.startTime !== undefined) {
      next.start_time = patch.startTime;
    }
    if (patch.endTime !== undefined) {
      if (row.state === 'active') {
        throw conflict(
          'entry_active',
          `Entry ${id} is still in progress; close it rather than setting endTime`
        );
      }
      next.end_time = patch.endTime;
    }
    if (next.end_time !== null && next.end_time < next.start_time) {
      throw badRequest('endTime must not be earlier than startTime');
    }

    for (const side of ['start', 'end']) {
      const position = patch[`${side}Position`];
      const name = patch[`${side}PlaceName`];
      if (
        side === 'end' &&
        row.state === 'active' &&
        (position !== undefined || name !== undefined)
      ) {
        throw conflict('entry_active', `Entry ${id} is still in progress; it has no arrival yet`);
      }
      if (position !== undefined) {
        next[`${side}_lat`] = position ? position.lat : null;
        next[`${side}_lon`] = position ? position.lon : null;
        // A name still generated from coordinates follows the corrected position.
        if (name === undefined && row[`${side}_place_pending`] === 1) {
          next[`${side}_place_name`] = position ? coordinatesName(position) : null;
          next[`${side}_place_pending`] = position ? 1 : 0;
        }
      }
      if (name !== undefined) {
        const at = toPosition(next[`${side}_lat`], next[`${side}_lon`]);
        next[`${side}_place_name`] = name;
        next[`${side}_place_pending`] = 0;
        const placeId =
          name !== null && at ? rememberPlaceName(db, at, name, placeMatchRadius, now) : null;
        next[`${side}_place_id`] = placeId;
        if (placeId !== null) {
          renameLaterEntries(db, placeId, id, next[`${side}_time`], name);
        }
      }
    }

    if (patch.distance !== undefined) {
      next.distance = patch.distance;
    }

    db.prepare(
      `UPDATE log_entries SET
         start_time = ?, end_time = ?,
         start_lat = ?, start_lon = ?, end_lat = ?, end_lon = ?,
         start_place_id = ?, end_place_id = ?, start_place_name = ?, end_place_name = ?,
         start_place_pending = ?, end_place_pending = ?,
         distance = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      next.start_time,
      next.end_time,
      next.start_lat,
      next.start_lon,
      next.end_lat,
      next.end_lon,
      next.start_place_id,
      next.end_place_id,
      next.start_place_name,
      next.end_place_name,
      next.start_place_pending,
      next.end_place_pending,
      next.distance,
      now,
      id
    );

    return getEntry(db, id);
  });
}

function closeEntry(db, id, { now, position, placeMatchRadius }) {
  return withTransaction(db, () => {
    const row = requireEntryRow(db, id);
    if (row.state === 'closed') {
      throw conflict('entry_already_closed', `Entry ${id} is already closed`);
    }
    // Closing by hand confirms an arrival: when detection has already seen the
    // vessel stop, the passage ended then, not when someone pressed the button.
    const stoppedAt = row.stopped_since ?? now;
    const endTime = stoppedAt < row.start_time ? row.start_time : stoppedAt;
    const end = toPosition(row.end_lat, row.end_lon) ?? position;
    const place =
      row.end_place_name === null
        ? initialPlaceName(db, end, placeMatchRadius)
        : { id: row.end_place_id, name: row.end_place_name, pending: row.end_place_pending };

    db.prepare(
      `UPDATE log_entries
       SET state = 'closed', end_time = ?, stopped_since = NULL, end_lat = ?, end_lon = ?,
           end_place_id = ?, end_place_name = ?, end_place_pending = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      endTime,
      end ? end.lat : null,
      end ? end.lon : null,
      place.id,
      place.name,
      place.pending,
      now,
      id
    );

    return getEntry(db, id);
  });
}

// The earlier entry survives and absorbs the later one, so the passage keeps
// its original id and departure.
function mergeEntries(db, id, otherId, now) {
  if (id === otherId) {
    throw badRequest('An entry cannot be merged with itself');
  }

  return withTransaction(db, () => {
    const [earlier, later] = [requireEntryRow(db, id), requireEntryRow(db, otherId)].sort(
      (a, b) => a.start_time.localeCompare(b.start_time) || a.id - b.id
    );

    if (earlier.state === 'active') {
      throw conflict(
        'entry_active',
        `Entry ${earlier.id} is still in progress and cannot absorb a later entry`
      );
    }

    const between = db
      .prepare(
        `SELECT COUNT(*) AS n FROM log_entries
         WHERE id NOT IN (?, ?) AND start_time >= ? AND start_time <= ?`
      )
      .get(earlier.id, later.id, earlier.start_time, later.start_time).n;
    if (between > 0) {
      throw conflict(
        'entries_not_consecutive',
        `Entries ${earlier.id} and ${later.id} are not consecutive`
      );
    }

    // Detection dates the entry's own end from the last movement it saw
    // (`stoppedSince`), but only records the "entry_end" observation once the
    // stop has held past the closure threshold and it actually closes the
    // entry -- up to `stopClosureMinutes` later. Read before the
    // reassignment below, while entry_id still tells earlier's own snapshot
    // apart from later's.
    const entryEndObservation = db
      .prepare(`SELECT MAX(time) AS time FROM observations WHERE entry_id = ? AND reason = ?`)
      .get(earlier.id, 'entry_end').time;

    for (const table of CHILD_TABLES) {
      db.prepare(`UPDATE ${table} SET entry_id = ? WHERE entry_id = ?`).run(earlier.id, later.id);
    }
    // Delete before reopening: if the later entry is active, the single-active
    // index would otherwise reject the update below.
    db.prepare('DELETE FROM log_entries WHERE id = ?').run(later.id);

    // The merge below overwrites the earlier entry's end with the later
    // entry's: without this, the place where the passage actually stopped —
    // the whole reason a merge exists — would leave no trace on the timeline.
    if (earlier.end_place_name !== null) {
      // Placed no earlier than the entry_end reading, so it follows it on
      // the timeline instead of appearing to predate the passage's own
      // arrival. Falls back to the entry's end time when there is no
      // reading to follow — closed by hand, or with no instrument data.
      const time =
        entryEndObservation && entryEndObservation > earlier.end_time
          ? entryEndObservation
          : earlier.end_time;
      // The comment carries the raw place name too, like an sk_alarm's
      // message, so it still reads in a CSV export or before any
      // translation is applied.
      db.prepare(
        `INSERT INTO events (entry_id, time, type, lat, lon, comment, payload, source, created_at)
         VALUES (?, ?, 'stopover', ?, ?, ?, ?, 'auto', ?)`
      ).run(
        earlier.id,
        time,
        earlier.end_lat,
        earlier.end_lon,
        earlier.end_place_name,
        JSON.stringify({
          placeName: earlier.end_place_name,
          placePending: earlier.end_place_pending === 1
        }),
        now
      );
    }

    db.prepare(
      `UPDATE log_entries SET
         state = ?, end_time = ?, stopped_since = ?,
         end_lat = ?, end_lon = ?, end_place_id = ?, end_place_name = ?, end_place_pending = ?,
         distance = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      later.state,
      later.end_time,
      later.stopped_since,
      later.end_lat,
      later.end_lon,
      later.end_place_id,
      later.end_place_name,
      later.end_place_pending,
      earlier.distance + later.distance,
      now,
      earlier.id
    );
    recomputeDurations(db, earlier.id, now);

    return getEntry(db, earlier.id);
  });
}

function activeEntryId(db) {
  return db.prepare("SELECT id FROM log_entries WHERE state = 'active'").get()?.id ?? null;
}

// The last passage, while the vessel is still at its arrival; null otherwise.
function entryNearArrival(db, position) {
  if (!position) {
    return null;
  }
  const last = db
    .prepare(
      `SELECT id, end_lat, end_lon FROM log_entries WHERE state = 'closed'
       ORDER BY end_time DESC, id DESC LIMIT 1`
    )
    .get();
  const stillThere =
    last &&
    last.end_lat !== null &&
    distanceBetween(position, { lat: last.end_lat, lon: last.end_lon }) <= STILL_AT_ARRIVAL_METRES;
  return stillThere ? last.id : null;
}

// A passage opened by the crew casting off, before detection sees the vessel
// move. It starts stopped, so the first movement resumes it rather than opening
// another one, and a departure that never happens closes like any long stop.
function openEntryByHand(db, { time, position, placeMatchRadius, now }) {
  const previousEnd = db.prepare('SELECT MAX(end_time) AS endTime FROM log_entries').get().endTime;
  const startTime = previousEnd && time < previousEnd ? previousEnd : time;
  const place = initialPlaceName(db, position, placeMatchRadius);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO log_entries (
         state, start_time, stopped_since, start_lat, start_lon, start_place_id, start_place_name,
         start_place_pending, end_lat, end_lon, created_at, updated_at
       ) VALUES ('active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      startTime,
      startTime,
      position ? position.lat : null,
      position ? position.lon : null,
      place.id,
      place.name,
      place.pending,
      position ? position.lat : null,
      position ? position.lon : null,
      now,
      now
    );
  return Number(lastInsertRowid);
}

function deleteEntry(db, id) {
  requireEntryRow(db, id);
  db.prepare('DELETE FROM log_entries WHERE id = ?').run(id);
}

module.exports = {
  toEntry,
  requireEntryRow,
  listEntries,
  getStats,
  getEntry,
  updateEntry,
  closeEntry,
  mergeEntries,
  deleteEntry,
  recomputeDurations,
  activeEntryId,
  entryNearArrival,
  openEntryByHand
};
