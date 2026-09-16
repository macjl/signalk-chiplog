const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { openDatabase, withTransaction } = require('../lib/database');

describe('withTransaction', () => {
  let db;
  let dataDir;

  afterEach(() => {
    db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function open() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-db-'));
    ({ db } = openDatabase(dataDir));
    db.exec('CREATE TABLE t (n INTEGER)');
  }

  const count = () => db.prepare('SELECT COUNT(*) AS n FROM t').get().n;

  it('lets a nested call join the outer transaction', () => {
    open();
    const result = withTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)');
      return withTransaction(db, () => {
        db.exec('INSERT INTO t VALUES (2)');
        return 'inner';
      });
    });

    assert.equal(result, 'inner');
    assert.equal(count(), 2);
    // Back to a plain connection: a new transaction can start.
    withTransaction(db, () => db.exec('INSERT INTO t VALUES (3)'));
    assert.equal(count(), 3);
  });

  it('rolls the whole transaction back when a nested call fails', () => {
    open();
    assert.throws(
      () =>
        withTransaction(db, () => {
          db.exec('INSERT INTO t VALUES (1)');
          withTransaction(db, () => {
            db.exec('INSERT INTO t VALUES (2)');
            throw new Error('boom');
          });
        }),
      /boom/
    );

    assert.equal(count(), 0);
    withTransaction(db, () => db.exec('INSERT INTO t VALUES (3)'));
    assert.equal(count(), 1);
  });
});
