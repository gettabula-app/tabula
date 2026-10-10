// Which builds may open a SQLite database file, and the migration runner that directory.sqlite and chat.sqlite share
// (docs/migrations.md, TAB-225). A database used to be readable only by a build that knew every migration on disk, so a new
// image could never be rolled back. Now a database also records `min_reader`: the lowest schema generation (number of
// migrations) of a build that can still read it, and a build refuses a database only when its own generation is below that.
//
// The contract that makes it true is expand-then-contract: a migration that only adds (a table, a nullable column, an index
// that no write can trip over) leaves the previous generation able to read and write the database, and does not raise
// `min_reader`. A migration that does anything else says so, as `{ sql, minReader }`, and the lint in test/migrations-lint.test.ts
// fails until it does.

/** The table both databases get for it. It is not a numbered migration, so an older build neither sees nor trips over it. */
export const META_TABLE = 'schema_meta';
const MIN_READER_KEY = 'min_reader';

/** The SQL of a migration entry: a string (expand-only) or `{ sql, minReader }`. */
export const migrationSql = (entry) => (typeof entry === 'string' ? entry : entry.sql);

/**
 * The lowest schema generation that can still read a database right after migration number `n` (1-based) ran. A plain string is
 * expand-only: the generation before it still reads the database. Its SQL may start with `-- minReader: k` when an additive migration
 * is known to remain readable by an earlier generation. An entry that breaks that says `{ sql, minReader: n }` (or another
 * explicit number from 0 to n).
 */
export function declaredMinReader(entry, n) {
  if (typeof entry === 'string') {
    const annotated = entry.match(/^\s*--\s*minReader:\s*(\d+)\s*$/m);
    if (!annotated) return n - 1;
    const value = Number(annotated[1]);
    if (!Number.isInteger(value) || value < 0 || value > n) {
      throw new TypeError(`migration ${n} minReader annotation must be a whole number from 0 to ${n}`);
    }
    return value;
  }
  const value = entry?.minReader;
  if (typeof entry?.sql !== 'string' || !Number.isInteger(value) || value < 0 || value > n) {
    throw new TypeError(`migration ${n} must be SQL text or { sql, minReader } with minReader a whole number from 0 to ${n}`);
  }
  return value;
}

/** The highest `minReader` any migration of a build declares: what a rollback to an older build has to be measured against. */
export const maxReaderOf = (migrations) => migrations.reduce((max, entry, i) => Math.max(max, declaredMinReader(entry, i + 1)), 0);

const hasMeta = (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(META_TABLE) !== undefined;

/**
 * What is on disk: the schema generation (`user_version`) and the `min_reader` recorded next to it. A database written before
 * this existed has none, and is read strictly: only a build that knows every migration on it may open it (`legacy: true`).
 */
export function readSchemaState(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  let recorded = null;
  if (hasMeta(db)) {
    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(MIN_READER_KEY);
    const n = row ? Number(row.value) : NaN;
    if (Number.isInteger(n) && n >= 0) recorded = n;
  }
  return { version, minReader: recorded ?? version, legacy: recorded === null };
}

/** Whether a build that knows `known` migrations may open a database in this state. */
export const canRead = (state, known) => state.minReader <= known;

/** The sentence for a database this build may not open (the prefix is what the tests and the restore errors have always said). */
export const tooNewMessage = (name, state, known) =>
  `${name} was written by a newer Tabula (schema ${state.version}, readable by a build that knows ${state.minReader} or more, this build knows ${known})`;

const setMinReader = (db, value) =>
  db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(MIN_READER_KEY, String(value));

/**
 * Opens `db` for this build: refuses it when it is too new for the build to read, records `min_reader` on a database that has
 * none (a legacy one is recorded as its own generation, so nothing that could not open it yesterday can open it today), then
 * applies the migrations the database has not seen, each in its own transaction. A database that is ahead of this build but
 * readable by it is left exactly as it is: nothing is migrated and `user_version` is never lowered.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly (string | { sql: string, minReader: number })[]} migrations
 * @param {string} name what the error says: 'directory', 'chat.sqlite'
 */
export function migrate(db, migrations, name) {
  const known = migrations.length;
  const disk = readSchemaState(db);
  if (!canRead(disk, known)) throw new Error(tooNewMessage(name, disk, known));
  const ahead = disk.version > known;
  if (ahead) return disk;

  let minReader = disk.minReader;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // a legacy database is recorded as strict, once; a database that has the row keeps it
    if (disk.legacy) setMinReader(db, minReader);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (let i = disk.version; i < known; i++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrationSql(migrations[i]));
      minReader = Math.max(minReader, declaredMinReader(migrations[i], i + 1));
      setMinReader(db, minReader);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { version: known, minReader, legacy: false };
}

/** What `GET /api/internal/version` says about one database of this build and its file. */
export function describeSchema(db, migrations) {
  const disk = readSchemaState(db);
  return {
    build: { schema: migrations.length, maxReader: maxReaderOf(migrations) },
    disk: { schema: disk.version, minReader: disk.minReader, legacy: disk.legacy },
  };
}
