import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  canRead,
  declaredMinReader,
  describeSchema,
  maxReaderOf,
  migrate,
  readSchemaState,
} from '../server/schema.mjs';

let databases: DatabaseSync[] = [];

function database() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return db;
}

function meta(db: DatabaseSync) {
  return db.prepare("SELECT key, value FROM schema_meta ORDER BY key").all();
}

function snapshot(db: DatabaseSync) {
  return {
    userVersion: db.prepare('PRAGMA user_version').get(),
    schemaMeta: db.prepare('SELECT key, value FROM schema_meta ORDER BY key').all(),
    master: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('migration declarations and schema state', () => {
  it('uses the prior generation for strings and validates object declarations by migration number', () => {
    expect(declaredMinReader('CREATE TABLE x (id)', 4)).toBe(3);
    expect(declaredMinReader({ sql: 'CREATE TABLE x (id)', minReader: 4 }, 4)).toBe(4);
    expect(declaredMinReader({ sql: 'CREATE TABLE x (id)', minReader: 0 }, 4)).toBe(0);

    for (const entry of [
      null,
      { minReader: 0 },
      { sql: 4, minReader: 0 },
      { sql: 'SELECT 1', minReader: -1 },
      { sql: 'SELECT 1', minReader: 5 },
      { sql: 'SELECT 1', minReader: 1.5 },
    ]) {
      expect(() => declaredMinReader(entry as never, 4)).toThrow(/migration 4/);
    }
  });

  it('reports the highest declared reader generation', () => {
    expect(maxReaderOf(['SELECT 1', { sql: 'SELECT 2', minReader: 2 }, 'SELECT 3'])).toBe(2);
    expect(maxReaderOf([])).toBe(0);
  });

  it('reads fresh, legacy, recorded and invalid metadata states', () => {
    const fresh = database();
    expect(readSchemaState(fresh)).toEqual({ version: 0, minReader: 0, legacy: true });

    const legacy = database();
    legacy.exec('PRAGMA user_version = 3');
    expect(readSchemaState(legacy)).toEqual({ version: 3, minReader: 3, legacy: true });

    const recorded = database();
    recorded.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('min_reader', '2'); PRAGMA user_version = 3");
    expect(readSchemaState(recorded)).toEqual({ version: 3, minReader: 2, legacy: false });

    const garbage = database();
    garbage.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('min_reader', 'many'); PRAGMA user_version = 3");
    expect(readSchemaState(garbage)).toEqual({ version: 3, minReader: 3, legacy: true });
  });
});

describe('migrate', () => {
  it('applies a fresh database and records the highest declared reader generation', () => {
    const db = database();
    const migrations = [
      'CREATE TABLE first_table (id INTEGER)',
      { sql: 'CREATE TABLE second_table (id INTEGER)', minReader: 2 },
    ];

    expect(migrate(db, migrations, 'test')).toEqual({ version: 2, minReader: 2, legacy: false });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(meta(db)).toEqual([{ key: 'min_reader', value: '2' }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('first_table', 'second_table') ORDER BY name").all())
      .toEqual([{ name: 'first_table' }, { name: 'second_table' }]);
  });

  it('records a legacy database at its own generation before continuing, then is unchanged on a second call', () => {
    const db = database();
    const migrations = [
      'CREATE TABLE first_table (id INTEGER)',
      'CREATE TABLE second_table (id INTEGER)',
      'CREATE TABLE third_table (id INTEGER)',
    ];
    db.exec(`${migrations[0]}; PRAGMA user_version = 1`);

    expect(migrate(db, migrations.slice(0, 1), 'test')).toEqual({ version: 1, minReader: 1, legacy: false });
    expect(meta(db)).toEqual([{ key: 'min_reader', value: '1' }]);
    expect(migrate(db, migrations, 'test')).toEqual({ version: 3, minReader: 2, legacy: false });
    const before = snapshot(db);
    expect(migrate(db, migrations, 'test')).toEqual({ version: 3, minReader: 2, legacy: false });
    expect(snapshot(db)).toEqual(before);
  });

  it('keeps an expand-only upgrade readable by the immediately previous generation', () => {
    const db = database();
    const first = ['CREATE TABLE first_table (id INTEGER)', 'CREATE TABLE second_table (id INTEGER)'];
    migrate(db, first, 'test');
    expect(readSchemaState(db).minReader).toBe(1);

    const expanded = [...first, 'CREATE TABLE third_table (id INTEGER)'];
    const state = migrate(db, expanded, 'test');
    expect(state).toEqual({ version: 3, minReader: 2, legacy: false });
    expect(canRead(state, 2)).toBe(true);
  });

  it('raises min_reader for a breaking entry and rolls back both it and user_version when its SQL fails', () => {
    const db = database();
    const base = ['CREATE TABLE stable (id INTEGER)'];
    migrate(db, base, 'test');
    const breaking = [...base, { sql: 'CREATE TABLE changed (id INTEGER)', minReader: 2 }];
    expect(migrate(db, breaking, 'test')).toEqual({ version: 2, minReader: 2, legacy: false });
    expect(meta(db)).toEqual([{ key: 'min_reader', value: '2' }]);

    const beforeFailure = snapshot(db);
    const failing = [...breaking, {
      sql: "CREATE TABLE never_committed (id INTEGER); UPDATE schema_meta SET value = '99' WHERE key = 'min_reader'; PRAGMA user_version = 99; INSERT INTO missing_table VALUES (1)",
      minReader: 3,
    }];
    expect(() => migrate(db, failing, 'test')).toThrow(/missing_table/);
    expect(snapshot(db)).toEqual(beforeFailure);
  });

  it('refuses too-new legacy and recorded databases with the stable message prefix', () => {
    const legacy = database();
    legacy.exec('PRAGMA user_version = 4');
    expect(() => migrate(legacy, ['SELECT 1', 'SELECT 2', 'SELECT 3'], 'directory')).toThrow(/^directory was written by a newer Tabula \(schema 4/);

    const recorded = database();
    recorded.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('min_reader', '3'); PRAGMA user_version = 4");
    expect(() => migrate(recorded, ['SELECT 1', 'SELECT 2'], 'chat.sqlite')).toThrow(/^chat\.sqlite was written by a newer Tabula \(schema 4/);
  });

  it('leaves an ahead but readable database exactly unchanged and enforces the rollback boundary', () => {
    const db = database();
    const newer = [
      'CREATE TABLE first_table (id INTEGER)',
      'CREATE TABLE second_table (id INTEGER)',
      'CREATE TABLE third_table (id INTEGER)',
    ];
    migrate(db, newer, 'test');
    const before = snapshot(db);
    const state = migrate(db, newer.slice(0, 2), 'test');
    expect(state).toEqual({ version: 3, minReader: 2, legacy: false });
    expect(snapshot(db)).toEqual(before);
    expect(canRead(state, 2)).toBe(true);
    expect(() => migrate(db, newer.slice(0, 1), 'test')).toThrow(/^test was written by a newer Tabula \(schema 3/);

    const breakingDb = database();
    const breaking = [...newer.slice(0, 2), { sql: 'CREATE TABLE breaking_table (id INTEGER)', minReader: 3 }];
    migrate(breakingDb, breaking, 'test');
    expect(() => migrate(breakingDb, breaking.slice(0, 2), 'test')).toThrow(/^test was written by a newer Tabula \(schema 3/);
  });

  it('describes the build and the database on disk', () => {
    const db = database();
    const migrations = ['CREATE TABLE first_table (id INTEGER)', { sql: 'CREATE TABLE second_table (id INTEGER)', minReader: 2 }];
    migrate(db, migrations, 'test');
    expect(describeSchema(db, migrations)).toEqual({
      build: { schema: 2, maxReader: 2 },
      disk: { schema: 2, minReader: 2, legacy: false },
    });
  });
});
