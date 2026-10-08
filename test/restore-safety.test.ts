import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { formatManifestName, parseProtections, pruneManifests } from '../server/backup.mjs';
import { RestoreError } from '../server/restore.mjs';
import { DAY, HOUR, MIN, T0, harness, type Harness } from './backup-harness';
import { audits, backedUp, backupNow, becomeB, CONFIRM, filesOf, ownerOf, raw, reopen, rig, seedA, setting } from './restore-harness';

// docs/backups.md, Restoring, "The safety backup". The backup of the live data that comes first, and the protection
// that keeps it out of the pruning for seven days.

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const name = (ms: number) => formatManifestName(ms);

describe('pruneManifests with protected names', () => {
  const limits = { keepHourlyHours: 0, keepDailyDays: 0 };
  const names = [0, 1, 2, 3, 4].map((i) => name(T0 + i * DAY));

  it('is unchanged without protected names (the old three argument call)', () => {
    const { keep, drop } = pruneManifests(names, T0 + 10 * DAY, limits);
    expect([...keep]).toEqual([names[4]]);
    expect([...drop].sort()).toEqual(names.slice(0, 4).sort());
    expect(pruneManifests(names, T0 + 10 * DAY, { ...limits, protectedNames: [] })).toEqual({ keep, drop });
  });

  it('keeps the protected names, whatever the retention says', () => {
    const { keep, drop } = pruneManifests(names, T0 + 10 * DAY, { ...limits, protectedNames: [names[1], names[2]] });
    expect([...keep].sort()).toEqual([names[1], names[2], names[4]].sort());
    expect([...drop].sort()).toEqual([names[0], names[3]].sort());
  });

  it('ignores a protected name that is not in the list and one that is not a manifest name', () => {
    const { keep } = pruneManifests(names, T0 + 10 * DAY, { ...limits, protectedNames: [name(T0 + 99 * DAY), 'notes.txt'] });
    expect([...keep]).toEqual([names[4]]);
    expect(pruneManifests(['notes.txt', names[0]], T0, { ...limits, protectedNames: ['notes.txt'] }).drop).toEqual([]);
  });
});

describe('parseProtections', () => {
  it('keeps the entries that have not run out and says when something was dropped', () => {
    const live = name(T0);
    const gone = name(T0 - DAY);
    const stored = JSON.stringify({ [live]: T0 + DAY, [gone]: T0 - 1, 'notes.txt': T0 + DAY, [name(T0 + HOUR)]: 'soon' });
    expect(parseProtections(stored, T0)).toEqual({ active: { [live]: T0 + DAY }, changed: true });
    expect(parseProtections(JSON.stringify({ [live]: T0 + DAY }), T0)).toEqual({ active: { [live]: T0 + DAY }, changed: false });
    expect(parseProtections(null, T0)).toEqual({ active: {}, changed: false });
  });

  it('throws on a value that is not an object, so a caller can stop', () => {
    expect(() => parseProtections('[1]', T0)).toThrow(/object/);
    expect(() => parseProtections('{broken', T0)).toThrow(/JSON|property/);
    expect(() => parseProtections('3', T0)).toThrow(/object/);
  });
});

async function scenario(env: Record<string, string> = {}) {
  h = await harness({ accounts: true, env });
  seedA(h);
  const r = rig(h);
  const a = await backupNow(r.backup);
  const stateA = await backedUp(h, r.backup, a.manifest as string);
  h.clock.now += HOUR;
  becomeB(h);
  const stateB = filesOf(h.dir);
  h.clock.now += MIN;
  return { ...r, manifest: a.manifest as string, stateA, stateB, actor: ownerOf(h) };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

/** The manifests in the bucket; the engine that restored has been stopped, as the process would be, so a new one reads them. */
const fresh = () => h.engine({ directory: null });
const manifestsNow = async () => (await fresh().listManifests()).map((m) => m.name);

const go = (s: Scenario) => s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });

/** Nothing live changed: the files and the open database are the ones of state B, nothing was staged, moved or journalled. */
function expectUntouched(s: Scenario) {
  expect(filesOf(h.dir).size).toBe(s.stateB.size);
  for (const [file, bytes] of s.stateB) expect(filesOf(h.dir).get(file)!.equals(bytes), `${file}`).toBe(true);
  expect(setting(h.directory!, 'fixture')).toBe('B');
  expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.restore-') || n.startsWith('.pre-restore-') || n.startsWith('restore.json'))).toEqual([]);
  expect(s.exits).toEqual([]);
}

describe('the safety backup', () => {
  it('is taken first, holds the live state, and is protected for seven days', async () => {
    const s = await scenario();
    const before = await manifestsNow();
    expect(before).toEqual([s.manifest]);
    await go(s);
    const after = await manifestsNow();
    expect(after).toHaveLength(2);
    const safety = after.find((n) => n !== s.manifest)!;
    const manifest = await fresh().readManifest(safety);
    // it holds state B: the file that only exists in B is in it
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain('b3.yjs');
    const restored = reopen(h);
    try {
      // the backup that is restored is protected too: the safety backup's own pruning must not take it away
      expect(JSON.parse(setting(restored, 'backup.protected')!)).toEqual({ [safety]: T0 + HOUR + MIN + 7 * DAY, [s.manifest]: T0 + HOUR + MIN + 7 * DAY });
    } finally {
      restored.close();
    }
  });

  it('protects the backup that is restored as well, so a tight retention cannot delete it first', async () => {
    h = await harness({ accounts: true, env: { TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '0' } });
    seedA(h);
    const r = rig(h);
    const a = await backupNow(r.backup);
    h.clock.now += HOUR;
    becomeB(h);
    await r.restore.restoreWorkspace({ manifest: a.manifest as string, confirm: CONFIRM, actor: ownerOf(h) });
    // retention keeps only the newest, but the manifest that was chosen is still there to restore from
    const names = await manifestsNow();
    expect(names).toHaveLength(2);
    expect(names).toContain(a.manifest);
    const restored = reopen(h);
    try {
      expect(Object.keys(JSON.parse(setting(restored, 'backup.protected')!)).sort()).toEqual([...names].sort());
    } finally {
      restored.close();
    }
  });

  it('refuses when it fails, with the reason, and changes nothing', async () => {
    const s = await scenario();
    h.fake.rules.push({ method: 'PUT', status: 403, times: 999 });
    const err = (await go(s).catch((e) => e)) as RestoreError;
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.code).toBe('safety_backup_failed');
    expect(err.extra.detail).toBe('S3 PUT failed (status 403, AccessDenied)');
    expectUntouched(s);
    // the only write besides the record of the attempt: the backup that was to be restored is protected
    expect(Object.keys(JSON.parse(setting(h.directory!, 'backup.protected')!))).toEqual([s.manifest]);
    expect(JSON.parse(setting(h.directory!, 'restore.status')!)).toMatchObject({ kind: 'workspace', result: 'failed', error: 'safety_backup_failed', manifest: s.manifest });
    expect(audits(h.directory!, 20).filter((r) => r.action.startsWith('restore.')).map((r) => r.action).reverse()).toEqual(['restore.started', 'restore.failed']);
    expect(audits(h.directory!, 20).find((r) => r.action === 'restore.failed')).toMatchObject({ actorId: s.actor.id, detail: { kind: 'workspace', manifest: s.manifest, error: 'safety_backup_failed' } });
  });

  it('refuses when the run was stopped', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const real = h.engine();
    const a = await backupNow(real);
    const stub = { ...real, runNow: async () => ({ ok: false, aborted: true }) };
    const r = rig(h, { backup: stub });
    h.clock.now += HOUR;
    becomeB(h);
    const stateB = filesOf(h.dir);
    const err = (await r.restore.restoreWorkspace({ manifest: a.manifest as string, confirm: CONFIRM, actor: ownerOf(h) }).catch((e) => e)) as RestoreError;
    expect(err.code).toBe('safety_backup_failed');
    expect(filesOf(h.dir).size).toBe(stateB.size);
    expect(r.exits).toEqual([]);
  });

  it('waits for a backup that is already running and then takes its own', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const real = h.engine();
    const a = await backupNow(real);
    let calls = 0;
    const waits: number[] = [];
    const stub = { ...real, runNow: async () => (++calls <= 2 ? { ok: false, skipped: 'running' } : backupNow(real)) };
    const r = rig(h, { backup: stub, sleep: async (ms: number) => void waits.push(ms) });
    h.clock.now += HOUR;
    becomeB(h);
    await r.restore.restoreWorkspace({ manifest: a.manifest as string, confirm: CONFIRM, actor: ownerOf(h) });
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 2000]);
    expect(await r.exited).toBe(75);
  });

  it('gives up on a backup that never stops running, and changes nothing', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const real = h.engine();
    const a = await backupNow(real);
    let calls = 0;
    const stub = { ...real, runNow: async () => (++calls, { ok: false, skipped: 'running' }) };
    const r = rig(h, { backup: stub });
    const err = (await r.restore.restoreWorkspace({ manifest: a.manifest as string, confirm: CONFIRM, actor: ownerOf(h) }).catch((e) => e)) as RestoreError;
    expect(err.code).toBe('safety_backup_failed');
    expect(calls).toBe(60);
    expect(r.exits).toEqual([]);
  });
});

describe('the protection in the pruning', () => {
  const keepNothing = { TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '0' };

  it('keeps the safety backup for seven days and lets it go afterwards', async () => {
    const s = await scenario(keepNothing);
    await go(s);
    const safety = (await manifestsNow()).find((n) => n !== s.manifest)!;
    const restoredAt = T0 + HOUR + MIN;

    // the server starts again on the restored data, with its own backup engine
    const restored = reopen(h);
    try {
      const engine = h.engine({ directory: restored });
      h.clock.now = restoredAt + 2 * HOUR;
      expect((await backupNow(engine)).ok).toBe(true);
      let names = (await engine.listManifests()).map((m) => m.name);
      // retention keeps only the newest, yet the safety backup and the backup that was restored are still there
      expect(names).toContain(safety);
      expect(names).toContain(s.manifest);
      expect(names).toHaveLength(3);

      // six days later it is still protected (a later backup changes nothing about that)
      h.clock.now = restoredAt + 6 * DAY;
      h.write('b2.yjs', Buffer.from('changed on day six'));
      expect((await backupNow(engine)).ok).toBe(true);
      names = (await engine.listManifests()).map((m) => m.name);
      expect(names).toContain(safety);
      expect(names).toContain(s.manifest);
      expect(names).toHaveLength(3);
      expect(Object.keys(JSON.parse(setting(restored, 'backup.protected')!)).sort()).toEqual([safety, s.manifest].sort());

      // after seven days it is dropped, from the bucket and from the setting
      h.clock.now = restoredAt + 7 * DAY + MIN;
      h.write('b2.yjs', Buffer.from('changed on day seven'));
      expect((await backupNow(engine)).ok).toBe(true);
      names = (await engine.listManifests()).map((m) => m.name);
      expect(names).not.toContain(safety);
      expect(names).not.toContain(s.manifest);
      expect(names).toHaveLength(1);
      expect(JSON.parse(setting(restored, 'backup.protected')!)).toEqual({});
      expect(engine.status().prune).toMatchObject({ error: null, gcSkipped: null });
    } finally {
      restored.close();
    }
  });

  it('removes the objects of a manifest only once nothing keeps it, so the safety backup stays readable while protected', async () => {
    const s = await scenario(keepNothing);
    await go(s);
    const safety = (await manifestsNow()).find((n) => n !== s.manifest)!;
    const restored = reopen(h);
    try {
      const engine = h.engine({ directory: restored });
      h.clock.now += 3 * HOUR + 2 * HOUR;
      await backupNow(engine);
      h.clock.now += 3 * HOUR;
      h.write('b2.yjs', Buffer.from('changed again'));
      await backupNow(engine);
      const manifest = await engine.readManifest(safety);
      for (const file of manifest.files as { objectId: string }[]) expect((await engine.readObject(file.objectId)).length).toBeGreaterThanOrEqual(0);
    } finally {
      restored.close();
    }
  });

  it('stops deleting when the list of protected backups cannot be read', async () => {
    h = await harness({ accounts: true, env: keepNothing });
    seedA(h);
    const engine = h.engine();
    await backupNow(engine);
    for (let i = 1; i <= 3; i++) {
      h.clock.now += HOUR;
      h.write('b2.yjs', Buffer.from(`change ${i}`));
      await backupNow(engine);
    }
    expect(await engine.listManifests()).toHaveLength(1);
    h.directory!.setSetting('backup.protected', '{broken');
    for (let i = 4; i <= 6; i++) {
      h.clock.now += HOUR;
      h.write('b2.yjs', Buffer.from(`change ${i}`));
      await backupNow(engine);
    }
    expect((await engine.listManifests()).length).toBe(4);
    expect(engine.status().prune).toMatchObject({ gcSkipped: 'unreadable_protection', manifestsDeleted: 0, objectsDeleted: 0 });
    h.directory!.setSetting('backup.protected', '{}');
    h.clock.now += HOUR;
    h.write('b2.yjs', Buffer.from('change 7'));
    await backupNow(engine);
    expect(await engine.listManifests()).toHaveLength(1);
  });

  it('carries the protection of a first restore through a second one', async () => {
    const s = await scenario();
    await go(s);
    const first = (await manifestsNow()).find((n) => n !== s.manifest)!;

    // the server restarts, and an hour later the same backup is restored again
    const restored = reopen(h);
    try {
      h.clock.now += HOUR;
      const second = rig(h, { directory: restored, backup: h.engine({ directory: restored }) });
      h.write('b2.yjs', Buffer.from('written after the first restore'));
      const actor = restored.getUserByEmail('owner@example.com')!;
      await second.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor });
      expect(await second.exited).toBe(75);
    } finally {
      restored.close();
    }
    const kept = JSON.parse((await raw<{ value: string }>(h.dir, "SELECT value FROM settings WHERE key = 'backup.protected'"))[0].value);
    expect(Object.keys(kept)).toHaveLength(3);
    expect(Object.keys(kept)).toEqual(expect.arrayContaining([first, s.manifest]));
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.pre-restore-'))).toHaveLength(2);
    expect(JSON.parse((await raw<{ value: string }>(h.dir, "SELECT value FROM settings WHERE key = 'restore.keep'"))[0].value)).toEqual(
      Object.fromEntries(fs.readdirSync(h.dir).filter((n) => n.startsWith('.pre-restore-')).map((n) => [n, { at: Number(n.slice('.pre-restore-'.length)), mode: 'days' }])),
    );
  });
});
