import { describe, expect, it } from 'vitest';
import { lintMigration } from '../server/migration-lint.mjs';
import { CHAT_MIGRATIONS } from '../server/chat.mjs';
import { MIGRATIONS } from '../server/directory.mjs';

type Migration = string | { sql: string; minReader: number };

function lintEntries(migrations: readonly Migration[], name: string, grandfathered: number) {
  const failures: string[] = [];
  for (const [index, entry] of migrations.entries()) {
    const number = index + 1;
    if (number <= grandfathered || typeof entry !== 'string') continue;
    for (const reason of lintMigration(entry)) {
      failures.push(
        `${name} migration ${number}: ${reason}; use { sql, minReader: ${number} } for a breaking change, or { sql, minReader: ${number - 1} } once reviewed as expand-only.`,
      );
    }
  }
  return failures;
}

describe('migration SQL lint', () => {
  it.each([
    ['DROP TABLE old_table', 'DROP'],
    ['DROP COLUMN old_column', 'DROP'],
    ['DROP INDEX old_index', 'DROP'],
    ['DROP TRIGGER old_trigger', 'DROP'],
    ['DROP VIEW old_view', 'DROP'],
    ['ALTER TABLE people RENAME TO users', 'RENAME'],
    ['ALTER TABLE people RENAME COLUMN old_name TO name', 'RENAME'],
    ['ALTER TABLE people ADD COLUMN active INTEGER NOT NULL', 'NOT NULL'],
    ['CREATE UNIQUE INDEX people_email ON people(email)', 'UNIQUE INDEX'],
    ['CREATE TRIGGER people_change AFTER INSERT ON people BEGIN SELECT 1; END', 'TRIGGER'],
    ['UPDATE people SET active = 1', 'UPDATE'],
    ['DELETE FROM people WHERE active = 0', 'DELETE'],
  ])('reports a reason for %s', (sql, reason) => {
    expect(lintMigration(sql)).toEqual(expect.arrayContaining([expect.stringContaining(reason)]));
  });

  it('treats safe additions and seed inserts as expand-only', () => {
    for (const sql of [
      'CREATE TABLE new_table (id INTEGER PRIMARY KEY)',
      'ALTER TABLE people ADD COLUMN nickname TEXT',
      "ALTER TABLE people ADD COLUMN state TEXT NOT NULL DEFAULT 'new'",
      'CREATE INDEX people_name ON people(name)',
      "INSERT INTO settings (key, value) VALUES ('theme', 'dark')",
    ]) {
      expect(lintMigration(sql)).toEqual([]);
    }
    expect(lintMigration('CREATE TABLE labels (name TEXT); CREATE UNIQUE INDEX labels_active ON labels(name) WHERE archived_at IS NULL')).toEqual([]);
  });

  it('flags a table rebuild as breaking even when it changes only a CHECK constraint', () => {
    const sql = `
      CREATE TABLE board_shares_new (role TEXT CHECK (role IN ('editor', 'viewer')));
      INSERT INTO board_shares_new SELECT * FROM board_shares;
      DROP TABLE board_shares;
      ALTER TABLE board_shares_new RENAME TO board_shares;
    `;
    expect(lintMigration(sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('table rebuild is always breaking'),
    ]));
  });

  it('strips comments and quoted strings before matching, without case sensitivity', () => {
    const sql = `
      -- DROP TABLE commented_out;
      /* UPDATE sample SET value = 0; CREATE TRIGGER hidden */
      INSERT INTO messages (body) VALUES ('DROP TABLE; DELETE FROM users');
      CREATE TABLE safe_name (value TEXT DEFAULT 'ALTER TABLE x RENAME TO y');
    `;
    expect(lintMigration(sql)).toEqual([]);
    expect(lintMigration('drop table old_name')).toEqual(['DROP removes a database object']);
  });

  it('checks only migrations added after the fixed grandfather counts', () => {
    const directoryGrandfathered = 10;
    const chatGrandfathered = 1;
    expect(directoryGrandfathered).toBeLessThanOrEqual(MIGRATIONS.length);
    expect(chatGrandfathered).toBeLessThanOrEqual(CHAT_MIGRATIONS.length);
    expect(lintEntries(MIGRATIONS, 'directory', directoryGrandfathered)).toEqual([]);
    expect(lintEntries(CHAT_MIGRATIONS, 'chat', chatGrandfathered)).toEqual([]);
  });

  it('proves a plain-string DROP and table rebuild fail with an actionable message', () => {
    const rebuild = `
      CREATE TABLE sample_new (value TEXT CHECK (value <> ''));
      INSERT INTO sample_new SELECT * FROM sample;
      DROP TABLE sample;
      ALTER TABLE sample_new RENAME TO sample;
    `;
    const failures = lintEntries([
      'CREATE TABLE safe (id INTEGER)',
      'DROP TABLE old_table',
      rebuild,
    ], 'synthetic', 1);

    expect(failures).toHaveLength(4);
    expect(failures[0]).toContain('synthetic migration 2: DROP');
    expect(failures[0]).toContain('minReader: 2');
    expect(failures[0]).toContain('minReader: 1');
    expect(failures[1]).toContain('synthetic migration 3: DROP');
    expect(failures[2]).toContain('synthetic migration 3: ALTER TABLE RENAME');
    expect(failures[3]).toContain('synthetic migration 3: table rebuild');
    expect(lintEntries([{ sql: 'DROP TABLE explicitly_declared', minReader: 1 }], 'synthetic', 0)).toEqual([]);
  });
});
