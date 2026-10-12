import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { objectIdOf, deriveKeys, formatManifestName, seal } from '../server/backup.mjs';
import { openDirectory } from '../server/directory.mjs';
import { createRestore } from '../server/restore.mjs';
import { DAY, HOUR, KEY, T0, VERSION_A, VERSION_B, docBytes, type Dir, type Harness } from './backup-harness';

// Shared by the restore tests: a workspace with rooms, history and an accounts database in two states (A is backed up,
// B is what is live when the restore starts), the restore engine over the backup engine of backup-harness, and a way to
// forge backups whose contents the engine itself would never write.

export type Restore = NonNullable<ReturnType<typeof createRestore>>;
export const CONFIRM = 'RESTORE';

/** A volume with plenty of room (3.6 GB blocks, 90% free). */
export const roomy = async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 900_000 });
/** A volume that is `used` full (0..1). */
export const filled = (used: number) => async () => ({ bsize: 4096, blocks: 1_000_000, bavail: Math.round(1_000_000 * (1 - used)) });

/** The room files and everything under history/, as they are on disk: relative path to bytes. The database is left out. */
export function filesOf(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (rel === '' && entry.name !== 'history') continue;
        walk(next);
      } else if (rel !== '' || entry.name.endsWith('.yjs')) {
        out.set(next, fs.readFileSync(path.join(dir, next)));
      }
    }
  };
  walk('');
  return out;
}

/** What a backup run holds besides the database: the files of the manifest, as they are on disk now. */
export async function backedUp(h: Harness, backup: Rig['backup'], manifestName: string): Promise<Map<string, Buffer>> {
  const manifest = await backup.readManifest(manifestName);
  const out = new Map<string, Buffer>();
  for (const f of manifest.files as { path: string }[]) if (f.path !== 'directory.sqlite') out.set(f.path, fs.readFileSync(path.join(h.dir, f.path)));
  return out;
}

const gz = (text: string) => zlib.gzipSync(docBytes(text));

/** The people, teams and boards of state A, and some credentials that a restore must end. */
export function seedA(h: Harness) {
  const d = h.directory!;
  const owner = d.getUserByEmail('owner@example.com')!;
  const member = d.getUserByEmail('member@example.com')!;
  const team = d.createTeam({ name: 'Design', creatorId: owner.id })!;
  d.createBoard({ id: 'b1', title: 'Roadmap', ownerId: owner.id, teamId: team.id });
  d.createBoard({ id: 'b2', title: 'Retro', ownerId: member.id, teamId: null });
  d.setSetting('fixture', 'A');
  d.setSetting('cloud.limits', JSON.stringify({ seatLimit: 5, readOnly: false, banner: 'from A' }));
  d.createSession(owner.id, { ttlMs: 30 * DAY, now: h.clock.now });
  d.createSession(member.id, { ttlMs: 30 * DAY, now: h.clock.now });
  d.createLoginToken({ email: 'member@example.com', ttlMs: DAY, now: h.clock.now });
  d.createAccessToken({ userId: owner.id, name: 'ci', scope: 'read', ttlMs: 30 * DAY, now: h.clock.now });
  d.createInvite({ teamId: team.id, role: 'member', createdBy: owner.id, ttlMs: 30 * DAY, now: h.clock.now });
  h.write('b1.yjs', docBytes('A: board one'));
  h.write('b1~comments.yjs', docBytes('A: comments of one'));
  h.write('b2.yjs', docBytes('A: board two'));
  // real history files: gzipped documents
  h.write(`history/b1/${VERSION_A}.yjs.gz`, gz('A: version one'));
  h.write(`history/b1/${VERSION_B}.yjs.gz`, gz('A: version two'));
  // recent versions, so the history sweep of a relay that starts on this directory keeps them
  const recent = Date.now();
  h.write('history/b1/index.json', JSON.stringify({ v: 1, versions: [VERSION_A, VERSION_B].map((id, i) => ({ id, createdAt: recent - (2 - i) * 60_000, kind: 'auto', label: null, by: null, byName: null, objects: 1, bytes: 10, hash: `h${i}`, from: null })) }));
  return { owner, member, team };
}

/** What has changed by the time the restore starts: other content, another board, a different setting. */
export function becomeB(h: Harness) {
  const d = h.directory!;
  const owner = d.getUserByEmail('owner@example.com')!;
  d.setSetting('fixture', 'B');
  d.setSetting('cloud.limits', JSON.stringify({ seatLimit: 9, readOnly: false, banner: 'from B' }));
  d.createBoard({ id: 'b3', title: 'Only in B', ownerId: owner.id, teamId: null });
  d.createSession(owner.id, { ttlMs: 30 * DAY, now: h.clock.now });
  h.write('b1.yjs', docBytes('B: board one'));
  h.write('b3.yjs', docBytes('B: board three'));
  h.write('history/b3/index.json', JSON.stringify({ v: 1, versions: [] }));
}

export type Rig = ReturnType<typeof rig>;

/**
 * The backup config with the largest snapshot hold. The barrier abandons a copy that outlasts its hold (5 s by default), and a
 * loaded CI runner can take that long for the first backup of a scenario; then there is no manifest to restore from.
 */
const patient = (h: Harness) => {
  const config = h.config() as { snapshotMaxHoldSeconds: number };
  config.snapshotMaxHoldSeconds = 60;
  return config as never;
};

/** The backup engine and the restore engine on the harness's directory, with an exit the test can see. */
export function rig(h: Harness, overrides: Record<string, unknown> = {}) {
  const exits: number[] = [];
  let leave!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (leave = resolve));
  const backup = h.engine({ config: patient(h) });
  const restore = createRestore({
    backup,
    directory: h.directory,
    config: h.config(),
    dataDir: h.dir,
    log: (message: string) => h.logs.push(message),
    now: () => h.clock.now,
    sleep: async () => {},
    statfs: roomy,
    exit: (code: number) => {
      exits.push(code);
      leave(code);
    },
    ...overrides,
  })!;
  return { backup, restore, exits, exited };
}

/** One query on the live database file, read only (the restored database is closed again afterwards). */
export async function raw<T = Record<string, unknown>>(dir: string, sql: string): Promise<T[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'directory.sqlite'), { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/** A setting as the string it was stored as. */
export const setting = (d: Dir, key: string): string | null => {
  const value = d.getSetting(key);
  return value === null ? null : String(value);
};

/** The newest audit rows, with the action as the string it is. */
export const audits = (d: Dir, limit = 100) => d.listAudit(limit).map((row) => ({ ...row, action: String(row.action), actorId: row.actorId as string | null, detail: row.detail as Record<string, any> }));

/** Runs a backup and says what it made. */
export const backupNow = async (engine: { runNow: () => Promise<unknown> }) => {
  const result = (await engine.runNow()) as { ok: boolean; manifest: string; changed?: boolean; error?: string };
  if (!result.ok) throw new Error(`the backup did not run: ${JSON.stringify(result)}`);
  return result;
};

export const ownerOf = (h: Harness) => h.directory!.getUserByEmail('owner@example.com')!;

/** The live data directory opened again after a restore (the engine closed the one the harness holds). */
export const reopen = (h: Harness) => openDirectory(path.join(h.dir, 'directory.sqlite'));

/**
 * Writes a backup the engine would never make: the given files, sealed with the test key, under a manifest the test
 * names. `damage` can change the manifest body before it is sealed.
 */
export function forge(
  h: Harness,
  files: { path: string; data: Buffer }[],
  { at = T0 + HOUR, key = KEY, damage }: { at?: number; key?: Buffer; damage?: (body: Record<string, any>) => void } = {},
) {
  const keys = deriveKeys(key);
  const entries = files.map((f) => {
    const objectId = objectIdOf(f.data, keys);
    h.fake.put(`tabula/objects/${objectId}`, seal(f.data, `obj:${objectId}`, keys));
    return { path: f.path, size: f.data.length, objectId };
  });
  const body: Record<string, any> = {
    version: 1,
    keyId: keys.keyId,
    createdAt: new Date(at).toISOString(),
    appVersion: 'test',
    files: entries,
    totals: { files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) },
  };
  damage?.(body);
  const name = formatManifestName(at);
  h.fake.put(`tabula/manifests/${name}`, seal(Buffer.from(JSON.stringify(body)), `manifest:${name}`, keys));
  return { name, entries };
}

/** The bytes of a database file made by `build`, which gets an empty file to fill. */
export async function sqliteBytes(build: (db: import('node:sqlite').DatabaseSync) => void): Promise<Buffer> {
  const { DatabaseSync } = await import('node:sqlite');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-forge-'));
  const file = path.join(scratch, 'forged.sqlite');
  const db = new DatabaseSync(file);
  try {
    build(db);
  } finally {
    db.close();
  }
  const data = fs.readFileSync(file);
  fs.rmSync(scratch, { recursive: true, force: true });
  return data;
}

/** A copy of the workspace database file of `h` (taken through a backup run), as bytes. */
export async function databaseOf(h: Harness): Promise<Buffer> {
  const e = h.engine({ config: patient(h) });
  const result = await backupNow(e);
  const manifest = await e.readManifest(result.manifest);
  const entry = manifest.files.find((f: { path: string }) => f.path === 'directory.sqlite')!;
  return Buffer.from(await e.readObject(entry.objectId));
}
