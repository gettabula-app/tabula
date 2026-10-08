import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RestoreError, SimulatedCrash } from '../server/restore.mjs';
import { DAY, HOUR, MIN, T0, harness, type Harness } from './backup-harness';
import { audits, backedUp, backupNow, becomeB, CONFIRM, filesOf, ownerOf, raw, reopen, rig, seedA, setting } from './restore-harness';

// docs/backups.md, Restoring. One restore at a time, at most one whole restore in ten minutes, maintenance mode, what
// happens when the swap itself fails, how the process leaves, and when the old data is removed.

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function scenario(overrides: Record<string, unknown> = {}) {
  h = await harness({ accounts: true });
  seedA(h);
  const r = rig(h, overrides);
  const a = await backupNow(r.backup);
  const stateA = await backedUp(h, r.backup, a.manifest as string);
  h.clock.now += HOUR;
  becomeB(h);
  const stateB = filesOf(h.dir);
  h.clock.now += MIN;
  return { ...r, manifest: a.manifest as string, stateA, stateB, actor: ownerOf(h) };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const go = (s: Scenario) => s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });
const codeOf = async (promise: Promise<unknown>) => ((await promise.then(() => null, (e) => e)) as RestoreError)?.code;

/** A promise the test settles by hand. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

describe('one restore at a time', () => {
  it('answers a second whole restore with restore_in_progress while the first is running, and a board copy too', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const real = h.engine();
    const a = await backupNow(real);
    const held = gate<{ ok: boolean }>();
    const stub = { ...real, runNow: () => held.promise };
    const r = rig(h, { backup: stub });
    const first = r.restore.restoreWorkspace({ manifest: a.manifest as string, confirm: CONFIRM, actor: ownerOf(h) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.restore.status().inProgress).toBe('workspace');
    expect(await codeOf(r.restore.restoreWorkspace({ manifest: a.manifest as string, confirm: CONFIRM, actor: ownerOf(h) }))).toBe('restore_in_progress');
    expect(await codeOf(r.restore.restoreBoardCopy({ manifest: a.manifest as string, boardId: 'b1', actor: ownerOf(h) }))).toBe('restore_in_progress');
    held.open({ ok: false });
    expect(await codeOf(first)).toBe('safety_backup_failed');
    expect(r.restore.status().inProgress).toBeNull();
  });

  it('lets a whole restore start again after a failure, once ten minutes have passed', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const real = h.engine();
    const a = await backupNow(real);
    let ok = false;
    const stub = { ...real, runNow: async () => (ok ? backupNow(real) : { ok: false, error: 'S3 PUT failed (status 500)' }) };
    const r = rig(h, { backup: stub });
    const actor = ownerOf(h);
    const attempt = () => r.restore.restoreWorkspace({ manifest: a.manifest as string, confirm: CONFIRM, actor });
    expect(await codeOf(attempt())).toBe('safety_backup_failed');
    ok = true;
    h.clock.now += 5 * MIN;
    const limited = (await attempt().catch((e) => e)) as RestoreError;
    expect(limited.code).toBe('rate_limited');
    expect(limited.extra.retryAfter).toBe(300);
    h.clock.now += 5 * MIN;
    await attempt();
    expect(await r.exited).toBe(75);
  });

  it('keeps the limit across the restart that a restore causes', async () => {
    const s = await scenario();
    await go(s);
    await s.exited;
    const restored = reopen(h);
    try {
      h.clock.now += 3 * MIN;
      const next = rig(h, { directory: restored, backup: h.engine({ directory: restored }) });
      const err = (await next.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: restored.getUserByEmail('owner@example.com')! }).catch((e) => e)) as RestoreError;
      expect(err.code).toBe('rate_limited');
      expect(err.extra.retryAfter).toBe(7 * 60);
    } finally {
      restored.close();
    }
  });

  it('refuses everything once the swap has begun, until the process has left', async () => {
    const s = await scenario();
    await go(s);
    expect(s.restore.status()).toMatchObject({ inProgress: 'workspace', maintenance: true });
    expect(await codeOf(go(s))).toBe('restore_in_progress');
    expect(await codeOf(s.restore.restoreBoardCopy({ manifest: s.manifest, boardId: 'b1', actor: s.actor }))).toBe('restore_in_progress');
  });
});

describe('maintenance mode', () => {
  it('is entered after the checks and before the database is closed, with the backups stopped in between', async () => {
    const order: string[] = [];
    const s = await scenario({
      hooks: {
        enterMaintenance: () => {
          order.push(`maintenance (database ${setting(h.directory!, 'fixture') === 'B' ? 'open' : 'closed'}, staged ${fs.readdirSync(h.dir).some((n) => n.startsWith('.restore-'))})`);
        },
        closeDirectory: () => {
          order.push('close database');
          h.directory!.close();
        },
      },
      crashAt: (point: string) => {
        if (point === 'before-journal') order.push('swap');
      },
    });
    const stop = vi.spyOn(s.backup, 'stop').mockImplementation(async () => void order.push('stop backups'));
    await go(s);
    expect(order).toEqual(['maintenance (database open, staged true)', 'stop backups', 'close database', 'swap']);
    stop.mockRestore();
    expect(s.restore.status().maintenance).toBe(true);
  });

  it('does not enter it when anything before the swap fails', async () => {
    const hook = vi.fn<() => void>();
    const s = await scenario({ hooks: { enterMaintenance: hook } });
    h.fake.rules.push({ method: 'GET', key: /\/objects\//, status: 500, times: 999 });
    expect(await codeOf(go(s))).toBeTruthy();
    expect(hook).not.toHaveBeenCalled();
    expect(s.restore.status().maintenance).toBe(false);
    expect(s.exits).toEqual([]);
  });

  it('restarts the server, changing nothing, when maintenance mode itself fails', async () => {
    const s = await scenario({
      hooks: {
        enterMaintenance: () => {
          throw new Error('cannot close sockets');
        },
      },
    });
    const err = (await go(s).catch((e) => e)) as RestoreError;
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.extra.restarting).toBe(true);
    expect(await s.exited).toBe(75);
    expect(fs.existsSync(path.join(h.dir, 'restore.json'))).toBe(false);
    expect(filesOf(h.dir).size).toBe(s.stateB.size);
    expect(setting(h.directory!, 'fixture')).toBe('B');
  });
});

describe('a swap that fails on its own', () => {
  const failAt = (point: string) => {
    let n = 0;
    return (p: string) => {
      if (p === point && n++ === 0) throw Object.assign(new Error(`disk trouble at ${p}`), { code: 'EIO' });
    };
  };

  it.each(['old-dir-made', 'moved-old-2', 'journal-moved-old', 'moved-new-0', 'moved-new-3'])('is undone when it fails at %s, and the server restarts on the old data', async (point) => {
    const s = await scenario({ crashAt: failAt(point) });
    const err = (await go(s).catch((e) => e)) as RestoreError;
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.code).toBe('restore_failed');
    expect(err.extra.restarting).toBe(true);
    expect(err.message).not.toContain('EIO');
    expect(await s.exited).toBe(75);
    const now = filesOf(h.dir);
    expect(now.size).toBe(s.stateB.size);
    for (const [file, bytes] of s.stateB) expect(now.get(file)!.equals(bytes), `${file}`).toBe(true);
    expect((await raw<{ value: string }>(h.dir, "SELECT value FROM settings WHERE key = 'fixture'"))[0].value).toBe('B');
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'restore.json'), 'utf8'))).toMatchObject({ phase: 'rolled-back', error: 'swap_failed' });
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.restore-') || n.startsWith('.pre-restore-'))).toEqual([]);
  });

  it('is finished, not undone, when it fails after every new file is in place', async () => {
    const s = await scenario({ crashAt: failAt('staging-removed') });
    const result = await go(s);
    expect(result).toMatchObject({ ok: true, restarting: true });
    expect(await s.exited).toBe(75);
    expect((await raw<{ value: string }>(h.dir, "SELECT value FROM settings WHERE key = 'fixture'"))[0].value).toBe('A');
    expect(fs.existsSync(path.join(h.dir, 'restore.json'))).toBe(false);
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.restore-'))).toEqual([]);
  });

  it('does not exit by itself after a crash (the process is gone)', async () => {
    const s = await scenario({
      crashAt: (p: string) => {
        if (p === 'moved-new-1') throw new SimulatedCrash(p);
      },
    });
    await expect(go(s)).rejects.toBeInstanceOf(SimulatedCrash);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.exits).toEqual([]);
  });
});

describe('how the process leaves', () => {
  function timers() {
    const pending: { fn: () => void; ms: number; cleared: boolean }[] = [];
    return {
      pending,
      setTimeout: (fn: () => void, ms: number) => {
        const t = { fn, ms, cleared: false, unref() {} };
        pending.push(t);
        return t;
      },
      clearTimeout: (t: { cleared: boolean }) => void (t.cleared = true),
      fire: (ms?: number) => pending.filter((t) => !t.cleared && (ms === undefined || t.ms === ms)).forEach((t) => ((t.cleared = true), t.fn())),
    };
  }

  it('waits until the response is out, then leaves with 75', async () => {
    const t = timers();
    const s = await scenario({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
    const sent = gate();
    await s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor, responseDone: sent.promise });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.exits).toEqual([]);
    sent.open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    t.fire(0);
    expect(s.exits).toEqual([75]);
  });

  it('leaves after a grace period when the response never finishes', async () => {
    const t = timers();
    const s = await scenario({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
    await s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor, responseDone: new Promise(() => {}) });
    expect(s.exits).toEqual([]);
    t.fire(5000);
    t.fire(0);
    expect(s.exits).toEqual([75]);
  });

  it('leaves once, even when both the response and the grace period fire', async () => {
    const t = timers();
    const s = await scenario({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
    await s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });
    await new Promise((resolve) => setTimeout(resolve, 10));
    t.fire();
    t.fire();
    expect(s.exits).toEqual([75]);
  });

  it('waits for exitDelayMs after the response when asked to', async () => {
    const t = timers();
    const s = await scenario({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, exitDelayMs: 1500 });
    await go(s);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.pending.filter((p) => !p.cleared).map((p) => p.ms)).toEqual([1500]);
    t.fire(1500);
    expect(s.exits).toEqual([75]);
  });
});

describe('the old data', () => {
  const stamp = T0 + 100 * DAY;

  /** A restore engine whose backup has last succeeded at `lastSuccessAt`, a `.pre-restore` directory made at `at`. */
  async function sweepRig(options: { at?: number; mode?: 'days' | 'next-backup'; lastSuccessAt?: number | null; now: number; keep?: boolean; name?: string }) {
    h = await harness({ accounts: true });
    const real = h.engine();
    const stub = { ...real, status: () => ({ ...real.status(), lastSuccessAt: options.lastSuccessAt ?? null }) };
    const r = rig(h, { backup: stub });
    const name = options.name ?? `.pre-restore-${options.at ?? stamp}`;
    fs.mkdirSync(path.join(h.dir, name));
    fs.writeFileSync(path.join(h.dir, name, 'b1.yjs'), 'old data');
    if (options.keep !== false) h.directory!.setSetting('restore.keep', JSON.stringify({ [name]: { at: options.at ?? stamp, mode: options.mode ?? 'days' } }));
    h.clock.now = options.now;
    return { ...r, name, dir: path.join(h.dir, name) };
  }

  it('is not removed before 7 days have passed, and then is', async () => {
    const early = await sweepRig({ now: stamp + 7 * DAY - 1, lastSuccessAt: stamp + HOUR });
    expect((await early.restore.sweepOldData()).removed).toEqual([]);
    expect(fs.existsSync(early.dir)).toBe(true);
    await h.close();
    const due = await sweepRig({ now: stamp + 7 * DAY, lastSuccessAt: stamp + HOUR });
    expect((await due.restore.sweepOldData()).removed).toEqual([due.name]);
    expect(fs.existsSync(due.dir)).toBe(false);
    expect(JSON.parse(setting(h.directory!, 'restore.keep')!)).toEqual({});
    expect(audits(h.directory!, 5).find((r) => r.action === 'restore.old_data_removed')).toMatchObject({ actorId: null, detail: { ageDays: 7, mode: 'days' } });
  });

  it('is never removed before a backup has succeeded after the restore, however old', async () => {
    for (const lastSuccessAt of [null, stamp - HOUR, stamp, 0]) {
      const r = await sweepRig({ now: stamp + 90 * DAY, lastSuccessAt });
      expect((await r.restore.sweepOldData()).removed, `last success ${lastSuccessAt}`).toEqual([]);
      expect(fs.existsSync(r.dir)).toBe(true);
      await h.close();
    }
    const after = await sweepRig({ now: stamp + 90 * DAY, lastSuccessAt: stamp + 1 });
    expect((await after.restore.sweepOldData()).removed).toEqual([after.name]);
  });

  it('is removed after the next backup and at least 24 hours when the disk was nearly full', async () => {
    const tooSoon = await sweepRig({ mode: 'next-backup', now: stamp + DAY - 1, lastSuccessAt: stamp + HOUR });
    expect((await tooSoon.restore.sweepOldData()).removed).toEqual([]);
    await h.close();
    const noBackup = await sweepRig({ mode: 'next-backup', now: stamp + 3 * DAY, lastSuccessAt: stamp - 1 });
    expect((await noBackup.restore.sweepOldData()).removed).toEqual([]);
    await h.close();
    const due = await sweepRig({ mode: 'next-backup', now: stamp + DAY, lastSuccessAt: stamp + HOUR });
    expect((await due.restore.sweepOldData()).removed).toEqual([due.name]);
    expect(audits(h.directory!, 5).find((r) => r.action === 'restore.old_data_removed')).toMatchObject({ detail: { ageDays: 1, mode: 'next-backup' } });
  });

  it('treats a directory with no record as a 7 day one', async () => {
    const lonely = await sweepRig({ keep: false, now: stamp + 2 * DAY, lastSuccessAt: stamp + HOUR });
    expect((await lonely.restore.sweepOldData()).removed).toEqual([]);
    h.clock.now = stamp + 7 * DAY;
    expect((await lonely.restore.sweepOldData()).removed).toEqual([lonely.name]);
  });

  it('treats an unreadable record as a 7 day one', async () => {
    const r = await sweepRig({ now: stamp + 2 * DAY, lastSuccessAt: stamp + HOUR, mode: 'next-backup' });
    h.directory!.setSetting('restore.keep', '{broken');
    expect((await r.restore.sweepOldData()).removed).toEqual([]);
  });

  it.each(['.pre-restore-abc', '.pre-restore-', '.pre-restore-1790000000000x', '.pre-restore-1790000000000.bak', 'pre-restore-1790000000000', '.pre-restore-123', '.pre-restore-17900000000000000000', '.pre-restore-1790000000000 ', '.Pre-Restore-1790000000000', '.pre-restore--1790000000000'])(
    'never touches a directory called %j',
    async (odd) => {
      const r = await sweepRig({ name: odd, now: stamp + 365 * DAY, lastSuccessAt: stamp + 300 * DAY });
      expect((await r.restore.sweepOldData()).removed).toEqual([]);
      expect(fs.readFileSync(path.join(r.dir, 'b1.yjs'), 'utf8')).toBe('old data');
    },
  );

  it('refuses a directory whose age cannot be told: a time in the future, or from before Tabula', async () => {
    for (const at of [T0 + 5 * DAY, 1_000_000_000_000, 9_999_999_999_999]) {
      const r = await sweepRig({ at, now: T0, lastSuccessAt: T0 - 1 });
      // the stamp is in the name; the record may say anything
      expect((await r.restore.sweepOldData()).removed, `stamp ${at}`).toEqual([]);
      expect(fs.existsSync(r.dir)).toBe(true);
      await h.close();
    }
  });

  it('does not remove a file that has the name of a directory', async () => {
    h = await harness({ accounts: true });
    const r = rig(h, { backup: { ...h.engine(), status: () => ({ lastSuccessAt: stamp + HOUR }) } });
    h.clock.now = stamp + 30 * DAY;
    fs.writeFileSync(path.join(h.dir, `.pre-restore-${stamp}`), 'a file');
    expect((await r.restore.sweepOldData()).removed).toEqual([]);
    expect(fs.readFileSync(path.join(h.dir, `.pre-restore-${stamp}`), 'utf8')).toBe('a file');
  });

  it.skipIf(process.platform === 'win32')('never follows a link: a link with the name of an old directory is left alone, and so is what it points at', async () => {
    h = await harness({ accounts: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'precious.txt'), 'do not delete');
      const r = rig(h, { backup: { ...h.engine(), status: () => ({ lastSuccessAt: stamp + HOUR }) } });
      h.clock.now = stamp + 30 * DAY;
      fs.symlinkSync(outside, path.join(h.dir, `.pre-restore-${stamp}`), 'dir');
      expect((await r.restore.sweepOldData()).removed).toEqual([]);
      expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('do not delete');
      expect(fs.lstatSync(path.join(h.dir, `.pre-restore-${stamp}`)).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes only the directory, not a link inside it that leads elsewhere', async () => {
    h = await harness({ accounts: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'precious.txt'), 'do not delete');
      const r = rig(h, { backup: { ...h.engine(), status: () => ({ lastSuccessAt: stamp + HOUR }) } });
      fs.mkdirSync(path.join(h.dir, `.pre-restore-${stamp}`));
      try {
        fs.symlinkSync(outside, path.join(h.dir, `.pre-restore-${stamp}`, 'link'), 'dir');
      } catch {
        return;
      }
      h.clock.now = stamp + 8 * DAY;
      expect((await r.restore.sweepOldData()).removed).toEqual([`.pre-restore-${stamp}`]);
      expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('do not delete');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not sweep while a restore is running', async () => {
    const r = await sweepRig({ now: stamp + 30 * DAY, lastSuccessAt: stamp + HOUR });
    const real = h.engine();
    const first = await backupNow(real);
    const held = gate<{ ok: boolean }>();
    const busy = rig(h, { backup: { ...real, runNow: () => held.promise, status: () => ({ lastSuccessAt: stamp + HOUR }) } });
    const restoring = busy.restore.restoreWorkspace({ manifest: first.manifest as string, confirm: CONFIRM, actor: ownerOf(h) }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(busy.restore.status().inProgress).toBe('workspace');
    expect((await busy.restore.sweepOldData()).removed).toEqual([]);
    expect(fs.existsSync(r.dir)).toBe(true);
    held.open({ ok: false });
    await restoring;
    expect((await busy.restore.sweepOldData()).removed).toEqual([r.name]);
  });

  it('is swept by a timer: a minute after the start, then every hour, never keeping the process alive', async () => {
    const pending: { fn: () => unknown; ms: number; unref: ReturnType<typeof vi.fn> }[] = [];
    const r = await sweepRig({ now: stamp + 30 * DAY, lastSuccessAt: stamp + HOUR });
    const timed = rig(h, {
      backup: { ...h.engine(), status: () => ({ lastSuccessAt: stamp + HOUR }) },
      setTimeout: (fn: () => unknown, ms: number) => {
        const t = { fn, ms, unref: vi.fn<() => void>() };
        pending.push(t);
        return t;
      },
      clearTimeout: () => {},
    });
    timed.restore.start();
    expect(pending.map((p) => p.ms)).toEqual([60_000]);
    expect(pending[0].unref).toHaveBeenCalled();
    await pending[0].fn();
    expect(fs.existsSync(r.dir)).toBe(false);
    expect(pending.map((p) => p.ms)).toEqual([60_000, 3_600_000]);
    timed.restore.stop();
  });
});

describe('the status of the last restore', () => {
  it('is empty before any restore and shows the last result, time and manifest after, never content', async () => {
    const s = await scenario();
    expect(s.restore.status()).toMatchObject({ inProgress: null, maintenance: false, last: null, protectedBackups: [], oldData: [] });
    h.fake.rules.push({ method: 'PUT', status: 500, times: 999 });
    await codeOf(go(s));
    expect(s.restore.status().last).toEqual({ kind: 'workspace', result: 'failed', at: T0 + HOUR + MIN, manifest: s.manifest, error: 'safety_backup_failed' });
    h.fake.rules.length = 0;
    h.clock.now += 11 * MIN;
    await go(s);
    const status = s.restore.status();
    expect(status.last).toMatchObject({ kind: 'workspace', result: 'done', manifest: s.manifest, keepOldFor: '7 days' });
    expect(Object.keys(status.last!).sort()).toEqual(['at', 'boards', 'bytes', 'files', 'keepOldFor', 'kind', 'manifest', 'result']);
    expect(JSON.stringify(status)).not.toMatch(/objectId|[0-9a-f]{64}/);
  });
});
