const { badRequest, conflict, notFound } = require('./errors');
const { paginate } = require('./rows');

const KEY_PATTERN = /^[a-z0-9_]{1,40}$/;

function toManoeuvreType(row) {
  return {
    key: row.key,
    label: row.label,
    icon: row.icon,
    sortOrder: row.sort_order,
    builtin: row.builtin === 1,
    enabled: row.enabled === 1
  };
}

function requireTypeRow(db, key) {
  const row = db.prepare('SELECT * FROM manoeuvre_types WHERE key = ?').get(key);
  if (!row) {
    throw notFound('manoeuvre_type', key);
  }
  return row;
}

function listManoeuvreTypes(db, { limit, offset }) {
  return paginate(db, {
    table: 'manoeuvre_types',
    orderBy: 'sort_order, key',
    limit,
    offset,
    map: toManoeuvreType
  });
}

function createManoeuvreType(db, { key, label, icon, sortOrder, enabled }) {
  if (!KEY_PATTERN.test(key)) {
    throw badRequest('key must be 1-40 characters of lowercase letters, digits or underscores');
  }
  if (db.prepare('SELECT 1 FROM manoeuvre_types WHERE key = ?').get(key)) {
    throw conflict('manoeuvre_type_exists', `A manoeuvre type with key ${key} already exists`);
  }

  const order =
    sortOrder ??
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM manoeuvre_types').get().next;
  db.prepare(
    `INSERT INTO manoeuvre_types (key, label, icon, sort_order, builtin, enabled)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(key, label, icon ?? null, order, enabled === false ? 0 : 1);

  return toManoeuvreType(requireTypeRow(db, key));
}

function updateManoeuvreType(db, key, patch) {
  const row = requireTypeRow(db, key);
  db.prepare(
    'UPDATE manoeuvre_types SET label = ?, icon = ?, sort_order = ?, enabled = ? WHERE key = ?'
  ).run(
    patch.label ?? row.label,
    patch.icon !== undefined ? patch.icon : row.icon,
    patch.sortOrder ?? row.sort_order,
    patch.enabled === undefined ? row.enabled : Number(patch.enabled),
    key
  );
  return toManoeuvreType(requireTypeRow(db, key));
}

function deleteManoeuvreType(db, key) {
  const row = requireTypeRow(db, key);
  if (row.builtin === 1) {
    throw conflict(
      'builtin_manoeuvre_type',
      `${key} is built in and cannot be deleted; disable it instead`
    );
  }
  db.prepare('DELETE FROM manoeuvre_types WHERE key = ?').run(key);
}

module.exports = {
  listManoeuvreTypes,
  createManoeuvreType,
  updateManoeuvreType,
  deleteManoeuvreType
};
