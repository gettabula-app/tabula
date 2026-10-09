import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isBackupPath } from '../server/backup.mjs';
import { openChat } from '../server/chat.mjs';
import { HOUR, MIN, T0, harness, type Harness } from './backup-harness';
import { makePng } from './image-fixtures';
import { CONFIRM, backupNow, becomeB, ownerOf, rig, seedA } from './restore-harness';

// docs/chat.md, "A separate database file": chat.sqlite is copied by the backup walk with the same VACUUM INTO
// treatment as directory.sqlite, and a restore puts it back with the rest of the workspace.

let h: Harness;
const scratch: string[] = [];
let stores: ReturnType<typeof openChat>[] = [];

afterEach(async () => {
  for (const s of stores) s.close();
  stores = [];
  await h?.close();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const chatIn = (dir: string) => {
  const store = openChat(path.join(dir, 'chat.sqlite'));
  stores.push(store);
  return store;
};
const say = (store: ReturnType<typeof openChat>, body: string, clientId: string) =>
  store.insertMessage({ kind: 'board', ref: 'b1', authorId: 'u1', authorName: 'Ana', body, clientId }).message;

/** The chat database of a manifest, written to a scratch file and opened read only. */
async function snapshotOf(engine: ReturnType<Harness['engine']>, manifestName: string) {
  const manifest = await engine.readManifest(manifestName);
  const entry = manifest.files.find((f: { path: string }) => f.path === 'chat.sqlite');
  if (!entry) return null;
  const bytes: Buffer = await engine.readObject(entry.objectId);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-chat-backup-'));
  scratch.push(dir);
  const file = path.join(dir, 'chat.sqlite');
  fs.writeFileSync(file, bytes);
  return { bytes, file };
}

const bodies = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT body FROM chat_messages ORDER BY id').all() as { body: string }[]).map((r) => r.body);
  } finally {
    db.close();
  }
};

describe('chat.sqlite in the backups', () => {
  it('is a path the backup writes and a restore accepts', () => {
    expect(isBackupPath('chat.sqlite')).toBe(true);
    for (const p of ['chat.sqlite-wal', 'chat.sqlite-shm', 'chat.sqlite.backup-0000000000000000.tmp', 'history/chat.sqlite']) expect(isBackupPath(p)).toBe(false);
  });

  it('is in the snapshot as a consistent copy while the server has it open, and no temporary file is left', async () => {
    h = await harness({ accounts: true });
    const store = chatIn(h.dir);
    say(store, 'hello there', 'client-0001');
    say(store, 'second', 'client-0002');
    h.write('chat.sqlite.backup-0123456789abcdef.tmp', 'left by a crashed run');
    const engine = h.engine();
    const run = await backupNow(engine);
    expect(run.ok).toBe(true);
    const manifest = await engine.readManifest(run.manifest);
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual([...h.expectedPaths(), 'chat.sqlite'].sort());
    expect(manifest.files.map((f: { path: string }) => f.path)).not.toContain('chat.sqlite-wal');

    const snap = (await snapshotOf(engine, run.manifest))!;
    expect(snap.bytes.toString('latin1', 0, 15)).toBe('SQLite format 3');
    expect(bodies(snap.file)).toEqual(['hello there', 'second']);
    const db = new DatabaseSync(snap.file, { readOnly: true });
    try {
      expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    } finally {
      db.close();
    }
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('chat.sqlite.backup-'))).toEqual([]);
  });

  it('uploads nothing for an unchanged chat database, and the next copy no longer holds a deleted message', async () => {
    h = await harness({ accounts: true });
    const store = chatIn(h.dir);
    say(store, 'keep this', 'client-0001');
    const gone = say(store, 'a phrase that must disappear', 'client-0002');
    const engine = h.engine();
    const first = await backupNow(engine);
    h.clock.now += HOUR;
    const second = await backupNow(engine);
    expect(second).toMatchObject({ ok: true, changed: false });

    store.deleteMessage(gone.id, 'u1');
    h.clock.now += HOUR;
    const third = await backupNow(engine);
    expect(third).toMatchObject({ ok: true, changed: true });
    const before = (await snapshotOf(engine, first.manifest))!;
    const after = (await snapshotOf(engine, third.manifest))!;
    expect(before.bytes.includes('a phrase that must disappear')).toBe(true);
    expect(after.bytes.includes('a phrase that must disappear')).toBe(false);
    expect(bodies(after.file)).toEqual(['keep this', '']);
  });

  it('is left out while chat has never been used', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    const run = await backupNow(engine);
    expect(await snapshotOf(engine, run.manifest)).toBeNull();
  });
});

describe('a whole restore with chat', () => {
  it('brings back the conversation of the backup and keeps the live one aside', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const live = chatIn(h.dir);
    say(live, 'said before the backup', 'client-000A');
    const r = rig(h);
    const a = await backupNow(r.backup);
    h.clock.now += HOUR;
    becomeB(h);
    say(live, 'said after the backup', 'client-000B');
    h.clock.now += MIN;
    // the relay closes chat.sqlite when a restore takes over (enterMaintenance)
    live.close();
    stores = [];

    await r.restore.restoreWorkspace({ manifest: a.manifest, confirm: CONFIRM, actor: ownerOf(h) });
    expect(await r.exited).toBe(75);
    expect(bodies(path.join(h.dir, 'chat.sqlite'))).toEqual(['said before the backup']);
    const old = fs.readdirSync(h.dir).find((n) => /^\.pre-restore-\d+$/.test(n))!;
    expect(bodies(path.join(h.dir, old, 'chat.sqlite'))).toEqual(['said before the backup', 'said after the backup']);
  });

  it('leaves no chat behind when the backup was made before chat existed', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const r = rig(h);
    const a = await backupNow(r.backup);
    h.clock.now += HOUR;
    const live = chatIn(h.dir);
    say(live, 'newer than the backup', 'client-000C');
    live.close();
    stores = [];
    h.clock.now += MIN;

    await r.restore.restoreWorkspace({ manifest: a.manifest, confirm: CONFIRM, actor: ownerOf(h) });
    expect(await r.exited).toBe(75);
    expect(fs.existsSync(path.join(h.dir, 'chat.sqlite'))).toBe(false);
  });
});

describe('images and chat in the same backup', () => {
  it('backs up both, uploads nothing again while neither changes, and a restore brings both back', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const png = makePng({ width: 6 });
    const hash = crypto.createHash('sha256').update(png).digest('hex');
    const rel = `assets/${hash.slice(0, 2)}/${hash}`;
    h.write(rel, png);
    h.directory!.putAsset({ boardId: 'b1', hash, mime: 'image/png', bytes: png.length, width: 6, height: 3, createdBy: null, createdAt: T0 });
    const live = chatIn(h.dir);
    say(live, 'a message next to a picture', 'client-00AA');
    say(live, 'and a second one', 'client-00AB');
    const r = rig(h);

    const first = await backupNow(r.backup);
    expect(first.ok).toBe(true);
    const paths = (await r.backup.readManifest(first.manifest)).files.map((f: { path: string }) => f.path);
    expect(paths).toContain(rel);
    expect(paths).toContain('chat.sqlite');

    const puts = h.fake.count('PUT', /^tabula\/objects\//);
    h.clock.now += HOUR;
    const second = (await backupNow(r.backup)) as Awaited<ReturnType<typeof backupNow>> & { uploaded?: number };
    expect(second).toMatchObject({ ok: true, changed: false, uploaded: 0 });
    expect(h.fake.count('PUT', /^tabula\/objects\//)).toBe(puts);

    // Both are lost from the live data before the restore, so what comes back can only come from the backup.
    h.clock.now += HOUR;
    becomeB(h);
    live.close();
    stores = [];
    for (const name of ['chat.sqlite', 'chat.sqlite-wal', 'chat.sqlite-shm']) fs.rmSync(path.join(h.dir, name), { force: true });
    fs.rmSync(path.join(h.dir, 'assets'), { recursive: true, force: true });
    h.clock.now += MIN;

    await r.restore.restoreWorkspace({ manifest: first.manifest, confirm: CONFIRM, actor: ownerOf(h) });
    expect(await r.exited).toBe(75);
    expect(fs.readFileSync(path.join(h.dir, rel)).equals(png)).toBe(true);
    expect(bodies(path.join(h.dir, 'chat.sqlite'))).toEqual(['a message next to a picture', 'and a second one']);
  });
});
