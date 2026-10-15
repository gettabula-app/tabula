import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHAT_MIGRATIONS, openChat } from '../server/chat.mjs';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { maxReaderOf, migrate } from '../server/schema.mjs';

type Migration = string | { sql: string; minReader: number };
type Store = {
  name: string;
  fileName: string;
  migrations: Migration[];
  open: (file: string) => { close: () => void; schemaReport: () => unknown };
};

const stores: Store[] = [
  { name: 'directory', fileName: 'directory.sqlite', migrations: MIGRATIONS, open: openDirectory },
  { name: 'chat.sqlite', fileName: 'chat.sqlite', migrations: CHAT_MIGRATIONS, open: openChat },
];
const tempDirs: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-schema-matrix-'));
  tempDirs.push(dir);
  return dir;
}

function realDatabase(store: Store) {
  const dir = tempDir();
  const file = path.join(dir, store.fileName);
  const opened = store.open(file);
  opened.close();
  return file;
}

function databaseForList(store: Store, migrations: Migration[]) {
  const file = path.join(tempDir(), store.fileName);
  const db = new DatabaseSync(file);
  try {
    migrate(db, migrations, store.name);
  } finally {
    db.close();
  }
  return file;
}

function copyDatabase(source: string, store: Store) {
  const file = path.join(tempDir(), store.fileName);
  fs.copyFileSync(source, file);
  return file;
}

function makeNewer(file: string, store: Store, entry: Migration) {
  const db = new DatabaseSync(file);
  try {
    migrate(db, [...store.migrations, entry], store.name);
  } finally {
    db.close();
  }
}

function snapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      userVersion: db.prepare('PRAGMA user_version').get(),
      meta: db.prepare('SELECT key, value FROM schema_meta ORDER BY key').all(),
      master: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
    };
  } finally {
    db.close();
  }
}

function appTables(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta' ORDER BY name")
      .all()
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

for (const store of stores) {
  describe(`${store.name} schema generations`, () => {
    it('lets the immediately previous build open an expand-only database unchanged and read its old tables', () => {
      const full = realDatabase(store);
      const copy = copyDatabase(full, store);
      const before = snapshot(copy);
      const previous = store.migrations.slice(0, -1);
      const db = new DatabaseSync(copy);
      let state;
      try {
        state = migrate(db, previous, store.name);
      } finally {
        db.close();
      }
      expect(state).toEqual({ version: store.migrations.length, minReader: maxReaderOf(store.migrations), legacy: false });
      expect(snapshot(copy)).toEqual(before);

      // Chat has one migration, so generation zero has no tables to read; the state assertion above checks min_reader 0 is readable.
      const oldTables = appTables(databaseForList(store, previous));
      expect(oldTables.length === 0).toBe(store.name === 'chat.sqlite');
      const readDb = new DatabaseSync(copy, { readOnly: true });
      try {
        for (const table of oldTables) {
          const name = table.replaceAll('"', '""');
          expect(readDb.prepare(`SELECT count(*) AS count FROM "${name}"`).get()).toHaveProperty('count');
        }
      } finally {
        readDb.close();
      }
    });

    it('refuses a newer breaking database and opens a newer expand-only database untouched', () => {
      const full = realDatabase(store);
      const breakingFile = copyDatabase(full, store);
      makeNewer(breakingFile, store, {
        sql: 'CREATE TABLE future_x (id INTEGER)',
        minReader: store.migrations.length + 1,
      });
      const current = store.open;
      expect(() => current(breakingFile)).toThrow(/was written by a newer Tabula \(schema/);
      const previousDb = new DatabaseSync(breakingFile);
      try {
        expect(() => migrate(previousDb, store.migrations.slice(0, -1), store.name)).toThrow(/was written by a newer Tabula \(schema/);
      } finally {
        previousDb.close();
      }

      const expandedFile = copyDatabase(full, store);
      makeNewer(expandedFile, store, 'CREATE TABLE future_y (id INTEGER)');
      const before = snapshot(expandedFile);
      const opened = store.open(expandedFile);
      try {
        expect(opened.schemaReport()).toMatchObject({
          build: { schema: store.migrations.length },
          disk: { schema: store.migrations.length + 1, minReader: store.migrations.length, legacy: false },
        });
      } finally {
        opened.close();
      }
      expect(snapshot(expandedFile)).toEqual(before);
    });

    it('records a legacy database strictly at its user_version', () => {
      const legacyFile = copyDatabase(realDatabase(store), store);
      const db = new DatabaseSync(legacyFile);
      try {
        db.exec('DROP TABLE schema_meta');
      } finally {
        db.close();
      }

      const opened = store.open(legacyFile);
      try {
        expect(opened.schemaReport()).toMatchObject({
          disk: { schema: store.migrations.length, minReader: store.migrations.length, legacy: false },
        });
      } finally {
        opened.close();
      }

      const stillLegacyFile = copyDatabase(realDatabase(store), store);
      const stillLegacy = new DatabaseSync(stillLegacyFile);
      try {
        stillLegacy.exec('DROP TABLE schema_meta');
        expect(() => migrate(stillLegacy, store.migrations.slice(0, -1), store.name)).toThrow(/was written by a newer Tabula \(schema/);
      } finally {
        stillLegacy.close();
      }
    });
  });
}

describe('directory tracker rollback floor', () => {
  it('keeps schema 21 readable and writable by the v5.0.1 schema 11 reader', () => {
    expect(MIGRATIONS).toHaveLength(21);
    expect(MIGRATIONS[14]).toMatchObject({ minReader: 11 });
    expect(MIGRATIONS[15]).toMatchObject({ minReader: 11 });
    expect(MIGRATIONS[16]).toMatchObject({ minReader: 11 });
    expect(MIGRATIONS[17]).toMatchObject({ minReader: 11 });
    expect(MIGRATIONS[18]).toMatchObject({ minReader: 11 });
    // migration 20 (OAuth ticket ceiling, TAB-365) is an annotated expand-only string, like migration 12
    expect(String(MIGRATIONS[19])).toMatch(/-- minReader: 11\s[\s\S]*ALTER TABLE oauth_grants ADD COLUMN tracker/);
    // migration 21 (last editor metadata, TAB-375) only adds nullable board columns.
    expect(String(MIGRATIONS[20])).toMatch(/-- minReader: 11\s[\s\S]*ALTER TABLE boards ADD COLUMN last_edited_by TEXT;[\s\S]*ALTER TABLE boards ADD COLUMN last_edited_kind TEXT;[\s\S]*ALTER TABLE boards ADD COLUMN last_edited_at INTEGER;/);
    expect(maxReaderOf(MIGRATIONS)).toBe(11);
    const file = realDatabase(stores[0]);
    const before = snapshot(file);
    const oldReader = new DatabaseSync(file);
    try {
      const state = migrate(oldReader, MIGRATIONS.slice(0, 11), 'directory v5.0.1');
      expect(state).toMatchObject({ version: MIGRATIONS.length, minReader: 11, legacy: false });
      oldReader.prepare("INSERT INTO users (id, email, name, role, created_at) VALUES ('rollback-user', 'rollback@example.com', 'Rollback', 'member', 1)").run();
      oldReader.prepare("UPDATE users SET name = 'Rollback reader' WHERE id = 'rollback-user'").run();
      expect(oldReader.prepare("SELECT name FROM users WHERE id = 'rollback-user'").get()).toEqual({ name: 'Rollback reader' });
      expect(oldReader.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_projection_outbox'").get()).toBeDefined();
      expect(oldReader.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_tokens'").get()).toBeDefined();
      expect(oldReader.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_daily_usage'").get()).toBeDefined();
      oldReader.prepare(
        `INSERT INTO kanban_tracker_links
          (id, board_id, kanban_id, workflow_id, created_at, created_by, idempotency_key)
         VALUES ('rollback-link', 'rollback-board', 'rollback-kanban', 'wf_default', 1, 'rollback-user', 'rollback-key-123')`,
      ).run();
      oldReader.prepare(
        `INSERT INTO kanban_state_mappings (kanban_link_id, lane_id, state_id, created_at, updated_at)
         VALUES ('rollback-link', 'rollback-lane', 'st_todo', 1, 1)`,
      ).run();
      oldReader.prepare(
        `INSERT INTO tickets
          (id, prefix, number, key, title, state_id, tracker_id, created_at, updated_at, created_by_type, created_by_id, updated_seq)
         VALUES ('rollback-ticket', 'TAB', 998, 'TAB-998', 'Rollback ticket', 'st_todo', 'trk_default', 1, 1, 'user', 'rollback-user', 1)`,
      ).run();
      oldReader.prepare(
        `INSERT INTO ticket_links
          (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type, created_by_id)
         VALUES ('rollback-card-link', 'rollback-ticket', 'rollback-board', 'rollback-kanban', 'rollback-card', 1, 'user', 'rollback-user')`,
      ).run();
      oldReader.prepare(
        `INSERT INTO ticket_links
          (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type, created_by_id)
         VALUES ('rollback-card-link-other-board', 'rollback-ticket', 'rollback-board-2', 'rollback-kanban-2', 'rollback-card-2', 1, 'user', 'rollback-user')`,
      ).run();
      oldReader.prepare(
        `INSERT INTO ticket_projection_outbox
          (ticket_id, board_id, kanban_id, card_id, event_seq, operation, projection_json, created_at, next_attempt_at)
         VALUES ('rollback-ticket', 'rollback-board', 'rollback-kanban', 'rollback-card', 1, 'upsert', '{}', 1, 1)`,
      ).run();
      expect(oldReader.prepare('SELECT card_id FROM ticket_projection_outbox WHERE ticket_id = ?').get('rollback-ticket')).toEqual({ card_id: 'rollback-card' });
    } finally {
      oldReader.close();
    }
    expect(snapshot(file)).toEqual(before);
    const readOnly = new DatabaseSync(file, { readOnly: true });
    try {
      expect(readOnly.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    } finally {
      readOnly.close();
    }
  });

  it('lets 20- and 19-migration readers open schema 21 and keep the new board columns intact', () => {
    const file = realDatabase(stores[0]);
    const seed = new DatabaseSync(file);
    try {
      seed.prepare("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('editor-owner', 'editor@example.com', 'Editor', 'member', 0, 1)").run();
      seed.prepare(
        `INSERT INTO boards
          (id, title, owner_id, team_id, created_at, updated_at, deleted_at, last_edited_by, last_edited_kind, last_edited_at)
         VALUES ('editor-board', 'Original', 'editor-owner', NULL, 1, 1, NULL, 'editor-owner', 'person', 1234)`,
      ).run();
    } finally {
      seed.close();
    }
    const before = snapshot(file);
    const schemaDb = new DatabaseSync(file, { readOnly: true });
    try {
      const columns = schemaDb.prepare('PRAGMA table_info(boards)').all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      expect(columns.filter((column) => column.name.startsWith('last_edited_')).map(({ name, type, notnull, dflt_value }) => ({
        name,
        type,
        notnull,
        dflt_value,
      }))).toEqual([
        { name: 'last_edited_by', type: 'TEXT', notnull: 0, dflt_value: null },
        { name: 'last_edited_kind', type: 'TEXT', notnull: 0, dflt_value: null },
        { name: 'last_edited_at', type: 'INTEGER', notnull: 0, dflt_value: null },
      ]);
    } finally {
      schemaDb.close();
    }

    for (const readerMigrations of [MIGRATIONS.slice(0, 20), MIGRATIONS.slice(0, 19)]) {
      // each reader starts from the seeded row: the first reader's write must not leak into the second reader's check
      const reset = new DatabaseSync(file);
      try {
        reset.prepare("UPDATE boards SET title = 'Original', updated_at = 1 WHERE id = 'editor-board'").run();
      } finally {
        reset.close();
      }
      const oldReader = new DatabaseSync(file);
      try {
        const state = migrate(oldReader, readerMigrations, 'directory older reader');
        expect(state).toMatchObject({ version: 21, minReader: 11, legacy: false });
        expect(oldReader.prepare('SELECT title, updated_at, last_edited_by, last_edited_kind, last_edited_at FROM boards WHERE id = ?').get('editor-board')).toEqual({
          title: 'Original',
          updated_at: 1,
          last_edited_by: 'editor-owner',
          last_edited_kind: 'person',
          last_edited_at: 1234,
        });

        oldReader.prepare('UPDATE boards SET title = ?, updated_at = ? WHERE id = ?').run('Older reader write', 5678, 'editor-board');
        expect(oldReader.prepare('SELECT title, updated_at, last_edited_by, last_edited_kind, last_edited_at FROM boards WHERE id = ?').get('editor-board')).toEqual({
          title: 'Older reader write',
          updated_at: 5678,
          last_edited_by: 'editor-owner',
          last_edited_kind: 'person',
          last_edited_at: 1234,
        });
        expect(oldReader.prepare('PRAGMA user_version').get()).toEqual({ user_version: 21 });
        expect((oldReader.prepare('PRAGMA table_info(boards)').all() as { name: string }[]).map((column) => column.name))
          .toContain('last_edited_at');
      } finally {
        oldReader.close();
      }
    }

    expect(snapshot(file)).toEqual(before);
  });
});
