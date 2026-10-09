import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHAT_MIGRATIONS } from '../server/chat.mjs';
import { formatManifestName } from '../server/backup.mjs';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { RestoreError, createRestore } from '../server/restore.mjs';
import { migrate } from '../server/schema.mjs';
import { sqliteBytes } from './restore-harness';

// Exercise createRestore's staging and schema checks with the same manifest/object interface without opening an S3 socket.
const T0 = Date.UTC(2026, 9, 8, 19, 30, 0);
const tempDirs: string[] = [];
const liveDirectories: ReturnType<typeof openDirectory>[] = [];
const restores: NonNullable<ReturnType<typeof createRestore>>[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore.stop();
  for (const directory of liveDirectories.splice(0)) directory.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-restore-schema-'));
  tempDirs.push(dir);
  return dir;
}

async function directoryBytes(migrations: (string | { sql: string; minReader: number })[] = MIGRATIONS, legacyAhead = false) {
  return sqliteBytes((db) => {
    migrate(db, migrations, 'directory');
    db.prepare('INSERT INTO users (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('restore-owner', 'owner@example.test', 'Owner', 'owner', 0, T0);
    if (legacyAhead) db.exec(`DROP TABLE schema_meta; PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  });
}

async function chatBytes(migrations: (string | { sql: string; minReader: number })[]) {
  return sqliteBytes((db) => migrate(db, migrations, 'chat.sqlite'));
}

function scenario(files: { path: string; data: Buffer }[]) {
  const dataDir = tempDir();
  const live = openDirectory(path.join(dataDir, 'directory.sqlite'));
  liveDirectories.push(live);
  const actor = live.createUser({ email: 'live@example.test', name: 'Live Owner', role: 'owner' })!;
  const stored = new Map(files.map((file, index) => [`object-${index}`, file.data]));
  const manifestName = formatManifestName(T0 + 60_000);
  const safetyName = formatManifestName(T0 + 120_000);
  const manifest = {
    version: 1,
    keyId: 'test',
    appVersion: 'test',
    createdAt: new Date(T0).toISOString(),
    files: files.map((file, index) => ({ path: file.path, objectId: `object-${index}`, size: file.data.length })),
    totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.data.length, 0) },
  };
  const backup = {
    readManifest: async (name: string) => {
      if (name !== manifestName) throw new Error('missing manifest');
      return manifest;
    },
    readObject: async (objectId: string) => {
      const data = stored.get(objectId);
      if (!data) throw new Error('missing object');
      return data;
    },
    runNow: async () => ({ ok: true, manifest: safetyName }),
    stop: async () => {},
    status: () => ({ lastSuccessAt: T0 }),
  };
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const restore = createRestore({
    backup: backup as never,
    directory: live,
    dataDir,
    now: () => T0 + 10 * 60_000,
    statfs: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 900_000 }),
    sleep: async () => {},
    // the engine closes the live database before the swap; an open file cannot be renamed on Windows
    hooks: { closeDirectory: async () => live.close() },
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++timerId;
      if (ms === 0) queueMicrotask(fn);
      else timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    exit: () => {},
    log: () => {},
  })!;
  restores.push(restore);
  return { dataDir, actor, manifestName, restore };
}

async function code(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (reason) => reason);
  expect(error).toBeInstanceOf(RestoreError);
  return error as RestoreError;
}

describe('restore schema compatibility', () => {
  it('accepts a backup whose directory database has a newer expand-only migration', async () => {
    const bytes = await directoryBytes([...MIGRATIONS, 'CREATE TABLE future_y (id INTEGER)']);
    const s = scenario([{ path: 'directory.sqlite', data: bytes }]);

    await expect(s.restore.restoreWorkspace({ manifest: s.manifestName, confirm: 'RESTORE', actor: s.actor }))
      .resolves.toMatchObject({ ok: true, restarting: true });
    const db = new DatabaseSync(path.join(s.dataDir, 'directory.sqlite'), { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_y'").get()).toEqual({ name: 'future_y' });
    } finally {
      db.close();
    }
  });

  it('accepts a backup whose chat database has a newer expand-only migration', async () => {
    const chat = await chatBytes([...CHAT_MIGRATIONS, 'CREATE TABLE future_y (id INTEGER)']);
    const directory = await directoryBytes();
    const s = scenario([
      { path: 'directory.sqlite', data: directory },
      { path: 'chat.sqlite', data: chat },
    ]);

    await expect(s.restore.restoreWorkspace({ manifest: s.manifestName, confirm: 'RESTORE', actor: s.actor }))
      .resolves.toMatchObject({ ok: true, restarting: true });
    const db = new DatabaseSync(path.join(s.dataDir, 'chat.sqlite'), { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_y'").get()).toEqual({ name: 'future_y' });
    } finally {
      db.close();
    }
  });

  it('refuses a breaking newer directory database with schema_too_new', async () => {
    const bytes = await directoryBytes([
      ...MIGRATIONS,
      { sql: 'CREATE TABLE future_x (id INTEGER)', minReader: MIGRATIONS.length + 1 },
    ]);
    const s = scenario([{ path: 'directory.sqlite', data: bytes }]);
    const error = await code(s.restore.restoreWorkspace({ manifest: s.manifestName, confirm: 'RESTORE', actor: s.actor }));
    expect(error.code).toBe('schema_too_new');
  });

  it('refuses a breaking newer chat database with schema_too_new', async () => {
    const directory = await directoryBytes();
    const chat = await chatBytes([
      ...CHAT_MIGRATIONS,
      { sql: 'CREATE TABLE future_x (id INTEGER)', minReader: CHAT_MIGRATIONS.length + 1 },
    ]);
    const s = scenario([
      { path: 'directory.sqlite', data: directory },
      { path: 'chat.sqlite', data: chat },
    ]);
    const error = await code(s.restore.restoreWorkspace({ manifest: s.manifestName, confirm: 'RESTORE', actor: s.actor }));
    expect(error.code).toBe('schema_too_new');
  });

  it('still refuses a legacy backup forged ahead without schema_meta', async () => {
    const bytes = await directoryBytes(MIGRATIONS, true);
    const s = scenario([{ path: 'directory.sqlite', data: bytes }]);
    const error = await code(s.restore.restoreWorkspace({ manifest: s.manifestName, confirm: 'RESTORE', actor: s.actor }));
    expect(error.code).toBe('schema_too_new');
  });
});
