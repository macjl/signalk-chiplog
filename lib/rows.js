function toPosition(lat, lon) {
  return lat === null || lon === null ? null : { lat, lon };
}

// Table and ORDER BY fragments are always literals from the calling module,
// never request input; only `params` carry user-supplied values.
function paginate(db, { table, where = '', params = [], orderBy, limit, offset, map }) {
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${where}`).get(...params);
  const rows = db
    .prepare(`SELECT * FROM ${table} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, limit, offset, items: rows.map(map) };
}

module.exports = { toPosition, paginate };
