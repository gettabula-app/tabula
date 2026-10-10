import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { createBackup, loadBackupConfig } from '../server/backup.mjs';
import { createCloud } from '../server/cloud.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { CREDS, KEY, MIN, T0, docBytes, envFor, harness, type Harness } from './backup-harness';

// docs/backups.md, When it runs. The settle backup (a backup shortly after the activity stops), the final backup of a
// graceful shutdown, and their settings: the real engine against the fake S3, with timers and the clock in the test's hands.

let h: Harness;
afterEach(async () => {
  await h?.close();
});

type Pending = { id: number; ms: number; fn: () => unknown };

/** A scheduler the test drives by hand. Timers are told apart by the function they run (the engine's tick and onSettle) or by their delay. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, Pending>();
  const named = (name: string) => [...pending.values()].filter((t) => t.fn.name === name);
  return {
    setTimeout: (fn: () => unknown, ms: number): any => {
      const id = next++;
      pending.set(id, { id, ms, fn });
      return { id, unref() {} };
    },
    clearTimeout: (handle: { id: number }) => void pending.delete(handle.id),
    get size() {
      return pending.size;
    },
    get interval() {
      return named('tick').map((t) => t.ms);
    },
    get settle() {
      return named('onSettle').map((t) => t.ms);
    },
    async fire(pick: (t: Pending) => boolean) {
      const timer = [...pending.values()].find(pick);
      if (!timer) throw new Error('no such timer');
      pending.delete(timer.id);
      await timer.fn();
    },
    fireSettle() {
      return this.fire((t) => t.fn.name === 'onSettle');
    },
    fireInterval() {
      return this.fire((t) => t.fn.name === 'tick');
    },
    fireDelay(ms: number) {
      return this.fire((t) => t.ms === ms);
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(5);
  }
}

type Engine = ReturnType<Harness['engine']>;
const idle = (engine: Engine) => until(() => !engine.status().running);
const manifests = (hh: Harness) => hh.fake.keys(/manifests/);
// Retention keeps the newest manifest of an hour, so a second one written in the same hour replaces the first: count the writes.
const manifestPuts = (hh: Harness) => hh.fake.count('PUT', /manifests/);

/** A fetch that holds the requests matching `holds` until release(); `reached` resolves when the first one is held. */
function gate(holds: (url: string, init: RequestInit) => boolean) {
  let release: () => void = () => {};
  const open = new Promise<void>((resolve) => (release = resolve));
  let reached: () => void = () => {};
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const real = globalThis.fetch;
  return {
    arrived,
    release,
    fetch: async (url: string, init: RequestInit) => {
      if (holds(url, init)) {
        reached();
        await open;
      }
      return real(url, init);
    },
  };
}
const holdManifestPut = (url: string, init: RequestInit) => init.method === 'PUT' && /manifests/.test(url);

function rig(options: Record<string, unknown> = {}) {
  const timers = fakeTimers();
  const engine = h.engine({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, ...options });
  return { timers, engine };
}

describe('noteChange', () => {
  it('does nothing before the engine is started, after it is stopped, and when settling and the shutdown backup are both off', async () => {
    h = await harness();
    const a = rig();
    a.engine.noteChange();
    expect(a.engine.status().dirty).toBe(false);
    expect(a.timers.size).toBe(0);

    a.engine.start();
    await a.engine.stop();
    a.engine.noteChange();
    expect(a.engine.status().dirty).toBe(false);
    expect(a.timers.size).toBe(0);

    await h.close();
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '0', TABULA_BACKUP_SHUTDOWN_SECONDS: '0' } });
    const off = rig();
    off.engine.start();
    off.engine.noteChange();
    expect(off.engine.status()).toMatchObject({ dirty: false, settleSeconds: 0 });
    expect(off.timers.settle).toEqual([]);
    expect(h.fake.log).toEqual([]);
  });

  it('is nothing at all without a configuration', () => {
    expect(createBackup({ config: null, dataDir: '/nowhere' })).toBeNull();
  });

  it('marks the workspace dirty without a settle timer when only the shutdown backup is on', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '0' } });
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    expect(engine.status()).toMatchObject({ dirty: true, settleSeconds: 0 });
    expect(timers.settle).toEqual([]);
    expect(timers.interval).toHaveLength(1);
  });

  it('never throws, whatever its dependencies do', async () => {
    h = await harness();
    let broken = false;
    const timers = fakeTimers();
    const engine = h.engine({
      setTimeout: (fn: () => unknown, ms: number) => {
        if (broken) throw new Error('no timers');
        return timers.setTimeout(fn, ms);
      },
      clearTimeout: timers.clearTimeout,
    });
    engine.start();
    broken = true;
    expect(() => engine.noteChange()).not.toThrow();
    expect(h.fake.log).toEqual([]);
  });

  it('is cheap: ten thousand calls leave one settle timer and no request', async () => {
    h = await harness();
    const { engine, timers } = rig();
    engine.start();
    for (let i = 0; i < 10_000; i++) engine.noteChange();
    expect(timers.settle).toEqual([120_000]);
    expect(h.fake.log).toEqual([]);
  });
});

describe('the settle backup', () => {
  it('runs the configured time after the last change, and not before', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    expect(timers.settle).toEqual([30_000]);
    expect(engine.status()).toMatchObject({ dirty: true, lastTrigger: null, settleSeconds: 30 });
    expect(h.fake.log).toEqual([]);

    h.clock.now += 30_000;
    await timers.fireSettle();
    await idle(engine);
    expect(manifests(h)).toHaveLength(1);
    expect(engine.status()).toMatchObject({ dirty: false, lastTrigger: 'settle', consecutiveFailures: 0, lastManifest: expect.stringMatching(/\.json\.enc$/) });
    expect(timers.settle).toEqual([]);
  });

  it('waits for quiet: every change starts the wait again', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    for (const seconds of [10, 20, 29]) {
      h.clock.now = T0 + seconds * 1000;
      engine.noteChange();
      expect(timers.settle).toEqual([30_000]);
    }
    expect(h.fake.log).toEqual([]);
    h.clock.now = T0 + 59_000;
    await timers.fireSettle();
    await idle(engine);
    expect(manifests(h)).toHaveLength(1);
  });

  it('backs up a workspace that never goes quiet ten minutes after its first change', async () => {
    h = await harness();
    const { engine, timers } = rig();
    engine.start();
    const delays: number[] = [];
    for (let minute = 0; minute <= 9; minute++) {
      h.clock.now = T0 + minute * MIN;
      engine.noteChange();
      delays.push(timers.settle[0]);
    }
    expect(delays).toEqual([...Array(9).fill(120_000), 60_000]);
    h.clock.now = T0 + 9.5 * MIN;
    engine.noteChange();
    expect(timers.settle).toEqual([30_000]);

    h.clock.now = T0 + 10 * MIN;
    engine.noteChange();
    expect(timers.settle).toEqual([0]);
    await timers.fireSettle();
    await idle(engine);
    expect(manifests(h)).toHaveLength(1);
    expect(engine.status().lastTrigger).toBe('settle');
  });

  it('allows a settle time longer than ten minutes to be its own cap', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '1800' } });
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    expect(timers.settle).toEqual([1_800_000]);
    h.clock.now = T0 + 20 * MIN;
    engine.noteChange();
    expect(timers.settle).toEqual([10 * MIN]);
    h.clock.now = T0 + 29 * MIN;
    engine.noteChange();
    expect(timers.settle).toEqual([60_000]);
  });

  it('asks the bucket for nothing when nothing changed', async () => {
    h = await harness();
    const { engine, timers } = rig();
    engine.start();
    expect(timers.settle).toEqual([]);
    expect(h.fake.log).toEqual([]);
    // and once a settle run has backed everything up, nothing is armed again
    engine.noteChange();
    await timers.fireSettle();
    await idle(engine);
    const requests = h.fake.log.length;
    expect(timers.settle).toEqual([]);
    await sleep(30);
    expect(h.fake.log).toHaveLength(requests);
  });

  it('writes no manifest when a settle run finds nothing different', async () => {
    h = await harness();
    const { engine, timers } = rig();
    await engine.runNow();
    expect(manifests(h)).toHaveLength(1);
    engine.start();
    engine.noteChange();
    h.clock.now += 5 * MIN;
    await timers.fireSettle();
    await idle(engine);
    expect(manifests(h)).toHaveLength(1);
    expect(engine.status()).toMatchObject({ dirty: false, lastTrigger: 'settle' });
  });

  it('backs up again after a change made while a run was going, and keeps the mark until then', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const held = gate(holdManifestPut);
    const { engine, timers } = rig({ fetch: held.fetch });
    engine.start();
    engine.noteChange();
    h.clock.now += 30_000;
    await timers.fireSettle();
    await held.arrived;
    expect(engine.status().running).toBe(true);

    const typed = docBytes('typed during the run');
    h.write('b2.yjs', typed);
    engine.noteChange();
    held.release();
    await idle(engine);
    expect(manifestPuts(h)).toBe(1);
    expect(engine.status()).toMatchObject({ dirty: true, lastTrigger: 'settle' });
    expect(timers.settle).toHaveLength(1);

    h.clock.now += 30_000;
    await timers.fireSettle();
    await idle(engine);
    expect(manifestPuts(h)).toBe(2);
    expect(engine.status()).toMatchObject({ dirty: false, lastTrigger: 'settle' });
    const newest = (await engine.listManifests())[0];
    const files = (await engine.readManifest(newest.name)).files;
    const b2 = files.find((f: { path: string }) => f.path === 'b2.yjs');
    expect((await engine.readObject(b2.objectId)).equals(typed)).toBe(true);
  });

  it('does not start a second run when the timer fires during one, and arms again when the run ends', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const held = gate(holdManifestPut);
    const { engine, timers } = rig({ fetch: held.fetch });
    engine.start();
    const manual = engine.runNow();
    await held.arrived;
    engine.noteChange();
    h.clock.now += 30_000;
    await timers.fireSettle();
    expect(h.fake.count('PUT', /manifests/)).toBe(0);
    expect(timers.settle).toEqual([]);

    held.release();
    expect(await manual).toMatchObject({ ok: true });
    expect(manifests(h)).toHaveLength(1);
    expect(engine.status()).toMatchObject({ dirty: true, lastTrigger: 'manual' });
    expect(timers.settle).toHaveLength(1);
    h.clock.now += 30_000;
    await timers.fireSettle();
    await idle(engine);
    expect(engine.status()).toMatchObject({ dirty: false, lastTrigger: 'settle' });
  });

  it('clears the mark only when nothing was noted since the run started', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const { engine } = rig();
    engine.start();
    engine.noteChange();
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(engine.status().dirty).toBe(false);

    const held = gate(holdManifestPut);
    const second = rig({ fetch: held.fetch });
    second.engine.start();
    h.write('b1.yjs', docBytes('edited'));
    second.engine.noteChange();
    const run = second.engine.runNow();
    await held.arrived;
    second.engine.noteChange();
    held.release();
    await run;
    expect(second.engine.status().dirty).toBe(true);
    await second.engine.runNow();
    expect(second.engine.status().dirty).toBe(false);
  });

  it('keeps the mark after a failed run and tries again with a longer wait each time, however often changes arrive', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const { engine, timers } = rig();
    h.fake.rules.push({ status: 403, times: 999 });
    engine.start();
    engine.noteChange();

    h.clock.now += 30_000;
    await timers.fireSettle();
    await idle(engine);
    expect(engine.status()).toMatchObject({ dirty: true, consecutiveFailures: 1, lastTrigger: 'settle' });
    expect(timers.settle).toEqual([30_000]);

    h.clock.now += 30_000;
    await timers.fireSettle();
    await idle(engine);
    expect(engine.status()).toMatchObject({ dirty: true, consecutiveFailures: 2 });
    expect(timers.settle).toEqual([60_000]);

    // a new change does not pull the retry forward
    engine.noteChange();
    expect(timers.settle).toEqual([60_000]);

    h.fake.rules.length = 0;
    h.clock.now += 60_000;
    await timers.fireSettle();
    await idle(engine);
    expect(engine.status()).toMatchObject({ dirty: false, consecutiveFailures: 0, lastTrigger: 'settle' });
    expect(manifests(h)).toHaveLength(1);
    expect(timers.settle).toEqual([]);
    engine.noteChange();
    expect(timers.settle).toEqual([30_000]);
  });

  it('stops waiting longer at half an hour', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '600' } });
    const { engine, timers } = rig();
    h.fake.rules.push({ status: 403, times: 999 });
    engine.start();
    engine.noteChange();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.clock.now += (timers.settle[0] ?? 0) + 1;
      await timers.fireSettle();
      await idle(engine);
      delays.push(timers.settle[0]);
    }
    expect(delays).toEqual([600_000, 1_200_000, 1_800_000, 1_800_000]);
  });

  it('leaves the interval schedule alone: the first run, then every interval, whatever else happens', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const { engine, timers } = rig();
    engine.start();
    expect(timers.interval).toEqual([60_000]);
    expect(engine.status().nextRunAt).toBe(T0 + 60_000);

    engine.noteChange();
    h.clock.now += 30_000;
    await timers.fireSettle();
    await idle(engine);
    expect(timers.interval).toEqual([60_000]);
    expect(engine.status().nextRunAt).toBe(T0 + 60_000);

    h.clock.now = T0 + 60_000;
    await timers.fireInterval();
    expect(engine.status()).toMatchObject({ lastTrigger: 'interval', consecutiveFailures: 0 });
    expect(timers.interval).toEqual([60 * MIN]);
    expect(engine.status().nextRunAt).toBe(T0 + 60_000 + 60 * MIN);

    // the heartbeat runs although nothing was noted: it finds what no signal told it about
    const before = h.fake.log.length;
    h.write('b2.yjs', docBytes('changed behind its back'));
    h.clock.now += 60 * MIN;
    await timers.fireInterval();
    expect(h.fake.log.length).toBeGreaterThan(before);
    expect(manifests(h)).toHaveLength(2);
    expect(timers.interval).toEqual([60 * MIN]);
  });

  it('is cleared by an interval run that covers the change, and the settle timer goes with it', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    expect(timers.settle).toHaveLength(1);
    await timers.fireInterval();
    expect(engine.status()).toMatchObject({ dirty: false, lastTrigger: 'interval' });
    expect(timers.settle).toEqual([]);
  });

  it('names the trigger of the latest run in the status', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const { engine, timers } = rig();
    expect(engine.status().lastTrigger).toBeNull();
    engine.start();
    await engine.runNow();
    expect(engine.status().lastTrigger).toBe('manual');
    await timers.fireInterval();
    expect(engine.status().lastTrigger).toBe('interval');
    engine.noteChange();
    await timers.fireSettle();
    await idle(engine);
    expect(engine.status().lastTrigger).toBe('settle');
    engine.noteChange();
    await engine.finish({ budgetMs: 5000 });
    expect(engine.status().lastTrigger).toBe('shutdown');
  });

  it('adds nothing secret to the status', async () => {
    h = await harness({ accounts: true });
    const { engine } = rig();
    engine.start();
    engine.noteChange();
    await engine.runNow();
    const text = JSON.stringify(engine.status());
    for (const secret of [CREDS.secretKey, CREDS.accessKey, KEY.toString('hex'), KEY.toString('base64'), 'Signature', 'AWS4']) expect(text).not.toContain(secret);
    expect(engine.status()).toMatchObject({ settleSeconds: 120, dirty: false, lastTrigger: 'manual' });
  });

  it('writes no audit row for a settle timer, and one for a settle run that did something', async () => {
    h = await harness({ accounts: true, env: { TABULA_BACKUP_SETTLE_SECONDS: '30' } });
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    expect(h.directory!.listAudit(10).filter((r) => String(r.action).startsWith('backup.'))).toEqual([]);
    h.clock.now += 30_000;
    await timers.fireSettle();
    await idle(engine);
    expect(h.directory!.listAudit(10).filter((r) => String(r.action).startsWith('backup.')).map((r) => r.action)).toEqual(['backup.run']);
    // a second settle run that finds nothing different is in the status but not in the audit log
    engine.noteChange();
    h.clock.now += 30_000;
    await timers.fireSettle();
    await idle(engine);
    expect(h.directory!.listAudit(10).filter((r) => String(r.action).startsWith('backup.'))).toHaveLength(1);
  });
});

describe('finish', () => {
  it('returns at once and asks the bucket for nothing when nothing changed', async () => {
    h = await harness();
    const { engine, timers } = rig();
    engine.start();
    expect(await engine.finish({ budgetMs: 4000 })).toEqual({ ran: false, ok: true, timedOut: false });
    expect(h.fake.log).toEqual([]);
    expect(timers.size).toBe(0);
  });

  it('takes exactly one final backup when something changed, and the manifest is there', async () => {
    h = await harness();
    const { engine, timers } = rig();
    engine.start();
    const typed = docBytes('typed just before the stop');
    h.write('b2.yjs', typed);
    engine.noteChange();
    const result = await engine.finish({ budgetMs: 4000 });
    expect(result).toEqual({ ran: true, ok: true, timedOut: false });
    expect(manifests(h)).toHaveLength(1);
    expect(h.fake.count('PUT', /manifests/)).toBe(1);
    expect(engine.status()).toMatchObject({ dirty: false, lastTrigger: 'shutdown', consecutiveFailures: 0 });
    const files = (await engine.readManifest((await engine.listManifests())[0].name)).files;
    const b2 = files.find((f: { path: string }) => f.path === 'b2.yjs');
    expect((await engine.readObject(b2.objectId)).equals(typed)).toBe(true);
    // its own timer is gone, and so are the schedule and the settle timer
    expect(timers.size).toBe(0);
    engine.noteChange();
    expect(timers.size).toBe(0);
  });

  it('does nothing when the budget is 0 or missing, and when the engine is stopped', async () => {
    h = await harness();
    const a = rig();
    a.engine.start();
    a.engine.noteChange();
    expect(await a.engine.finish({ budgetMs: 0 })).toMatchObject({ ran: false });
    expect(await rig().engine.finish()).toMatchObject({ ran: false });
    expect(h.fake.log).toEqual([]);

    const b = rig();
    b.engine.start();
    b.engine.noteChange();
    await b.engine.stop();
    expect(await b.engine.finish({ budgetMs: 4000 })).toMatchObject({ ran: false });
    expect(h.fake.log).toEqual([]);
  });

  it('is the same promise when called twice', async () => {
    h = await harness();
    const { engine } = rig();
    engine.start();
    engine.noteChange();
    const first = engine.finish({ budgetMs: 4000 });
    expect(engine.finish({ budgetMs: 4000 })).toBe(first);
    await first;
    expect(manifests(h)).toHaveLength(1);
  });

  it('returns at the budget when the bucket is slow, aborts the run, and leaves no manifest', async () => {
    h = await harness();
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    // two objects go up, then the bucket stops answering
    h.fake.rules.push({ method: 'PUT', key: /objects/, skip: 2, hang: true, times: 999 });
    const done = engine.finish({ budgetMs: 4000 });
    await until(() => h.fake.count('PUT', /objects/) >= 3);
    expect(engine.status().running).toBe(true);
    let returned = false;
    void done.then(() => (returned = true));
    await sleep(30);
    expect(returned).toBe(false);

    await timers.fireDelay(4000);
    expect(await done).toEqual({ ran: true, ok: false, timedOut: true });
    await idle(engine);
    expect(manifests(h)).toEqual([]);
    expect(h.fake.keys(/objects/).length).toBeGreaterThan(0);
    expect(engine.status()).toMatchObject({ running: false, dirty: true, consecutiveFailures: 0, lastError: null });
    expect(h.logs.join('\n')).toContain('did not finish in time');
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it('keeps to the budget in real time', async () => {
    h = await harness();
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    h.fake.rules.push({ hang: true, times: 999 });
    const done = engine.finish({ budgetMs: 300 });
    // the run has reached the bucket (whatever request it makes first hangs by the rule above) and is still going
    await until(() => h.fake.log.length > 0);
    expect(engine.status().running).toBe(true);
    await timers.fireDelay(300);
    expect(await done).toEqual({ ran: true, ok: false, timedOut: true });
    await idle(engine);
    expect(h.fake.log.length).toBeGreaterThan(0);
    await engine.stop();
    expect(manifests(h)).toEqual([]);
  });

  it('waits for a run in progress, does not abort it, and does not run again when nothing was noted since it started', async () => {
    h = await harness();
    const held = gate(holdManifestPut);
    const { engine, timers } = rig({ fetch: held.fetch });
    engine.start();
    engine.noteChange();
    const manual = engine.runNow();
    await held.arrived;
    const done = engine.finish({ budgetMs: 4000 });
    let returned = false;
    void done.then(() => (returned = true));
    await sleep(30);
    expect(returned).toBe(false);

    held.release();
    expect(await manual).toMatchObject({ ok: true });
    expect(await done).toEqual({ ran: false, ok: true, timedOut: false });
    expect(manifestPuts(h)).toBe(1);
    expect(engine.status()).toMatchObject({ dirty: false, lastTrigger: 'manual', consecutiveFailures: 0 });
    expect(timers.size).toBe(0);
  });

  it('runs once more after a run in progress when something was noted during it', async () => {
    h = await harness();
    const held = gate(holdManifestPut);
    const { engine } = rig({ fetch: held.fetch });
    engine.start();
    engine.noteChange();
    const manual = engine.runNow();
    await held.arrived;
    h.write('b2.yjs', docBytes('typed while the run was going'));
    engine.noteChange();
    const done = engine.finish({ budgetMs: 4000 });
    held.release();
    expect(await manual).toMatchObject({ ok: true });
    expect(await done).toEqual({ ran: true, ok: true, timedOut: false });
    expect(manifestPuts(h)).toBe(2);
    expect(engine.status()).toMatchObject({ dirty: false, lastTrigger: 'shutdown' });
  });

  it('aborts a run in progress that does not end inside the budget, without counting a failure', async () => {
    h = await harness();
    const held = gate(() => true);
    const { engine, timers } = rig({ fetch: held.fetch });
    engine.start();
    engine.noteChange();
    const manual = engine.runNow();
    await held.arrived;
    const done = engine.finish({ budgetMs: 4000 });
    await timers.fireDelay(4000);
    expect(await done).toMatchObject({ timedOut: true, ok: false });
    held.release();
    expect(await manual).toEqual({ ok: false, aborted: true });
    expect(manifests(h)).toEqual([]);
    expect(engine.status()).toMatchObject({ running: false, consecutiveFailures: 0, lastFailureAt: null });
  });

  it('retries a run that failed with changes in it, and reports it when that fails too', async () => {
    h = await harness();
    const { engine } = rig();
    engine.start();
    engine.noteChange();
    h.fake.rules.push({ status: 403, times: 1 });
    await engine.runNow();
    expect(engine.status()).toMatchObject({ dirty: true, consecutiveFailures: 1 });
    expect(await engine.finish({ budgetMs: 4000 })).toEqual({ ran: true, ok: true, timedOut: false });
    expect(manifests(h)).toHaveLength(1);

    const failing = rig();
    failing.engine.start();
    failing.engine.noteChange();
    h.fake.rules.push({ status: 403, times: 99 });
    expect(await failing.engine.finish({ budgetMs: 4000 })).toEqual({ ran: true, ok: false, timedOut: false });
    expect(failing.engine.status()).toMatchObject({ dirty: true, lastTrigger: 'shutdown', consecutiveFailures: 1 });
  });

  it('never throws, even when everything it depends on does', async () => {
    h = await harness();
    const engine = h.engine({
      backoffMs: [],
      fetch: () => {
        throw new Error('synchronous failure');
      },
      log: () => {
        throw new Error('the logger is broken');
      },
    });
    engine.start();
    engine.noteChange();
    await expect(engine.finish({ budgetMs: 1000 })).resolves.toMatchObject({ ran: true, ok: false });
    await expect(engine.finish({ budgetMs: Number.NaN })).resolves.toBeDefined();
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it('keeps a settle or interval timer from starting a run while it works', async () => {
    h = await harness();
    const held = gate(holdManifestPut);
    const { engine, timers } = rig({ fetch: held.fetch });
    engine.start();
    engine.noteChange();
    const done = engine.finish({ budgetMs: 4000 });
    await held.arrived;
    expect(timers.interval).toEqual([]);
    expect(timers.settle).toEqual([]);
    held.release();
    await done;
    expect(manifests(h)).toHaveLength(1);
  });
});

describe('the settings', () => {
  const SECRET = 'canary-value-7f3a9c12';
  const base = (extra: Record<string, string> = {}) => envFor({ url: 'https://s3.example.com' } as never, extra);
  const load = (env: Record<string, string>) => loadBackupConfig(env, () => {});
  const messageOf = (env: Record<string, string>) => {
    try {
      load(env);
    } catch (err) {
      return (err as Error).message;
    }
    return null;
  };

  it('defaults to 120 seconds and 4 seconds, and shows both in the config', () => {
    expect(load(base())).toMatchObject({ settleSeconds: 120, shutdownSeconds: 4 });
    expect(JSON.parse(JSON.stringify(load(base())))).toMatchObject({ settleSeconds: 120, shutdownSeconds: 4 });
  });

  it.each([
    { name: 'TABULA_BACKUP_SETTLE_SECONDS', field: 'settleSeconds', fallback: 120, max: 3600, good: ['0', '1', '45', '3600'], bad: ['-1', '3601', '10000', '1.5', ' 7 x', 'soon', '1e3', '0x10', '1000000'] },
    { name: 'TABULA_BACKUP_SHUTDOWN_SECONDS', field: 'shutdownSeconds', fallback: 4, max: 25, good: ['0', '1', '4', '25'], bad: ['-1', '26', '99', '2.5', 'quick', '1e1', '0x4', '1000000'] },
  ])('$name: whole numbers in range are read, anything else is an error that names the variable', ({ name, field, fallback, max, good, bad }) => {
    const read = (value: string) => (load(base({ [name]: value }))! as unknown as Record<string, number>)[field];
    for (const value of good) expect(read(value)).toBe(Number(value));
    for (const value of bad) expect([value, messageOf(base({ [name]: value }))]).toEqual([value, `${name} must be a whole number from 0 to ${max}`]);
    // an empty value is the same as not set
    expect(read('')).toBe(fallback);
  });

  it('never echoes the value of a malformed setting', () => {
    for (const name of ['TABULA_BACKUP_SETTLE_SECONDS', 'TABULA_BACKUP_SHUTDOWN_SECONDS']) {
      const message = messageOf(base({ [name]: SECRET }));
      expect(message).toContain(name);
      expect(message).not.toContain(SECRET);
    }
  });

  it('reads the old MIRA_ spelling', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base({ TABULA_BACKUP_SETTLE_SECONDS: '30', TABULA_BACKUP_SHUTDOWN_SECONDS: '9' }))) env[k.replace('TABULA_', 'MIRA_')] = v;
    expect(load(env)).toMatchObject({ settleSeconds: 30, shutdownSeconds: 9 });
    expect(messageOf({ ...env, MIRA_BACKUP_SETTLE_SECONDS: SECRET })).toBe('TABULA_BACKUP_SETTLE_SECONDS must be a whole number from 0 to 3600');
  });

  it('turns the settle backup off with 0 and keeps the shutdown backup on its own switch', async () => {
    h = await harness({ env: { TABULA_BACKUP_SETTLE_SECONDS: '0' } });
    const { engine, timers } = rig();
    engine.start();
    engine.noteChange();
    expect(timers.settle).toEqual([]);
    expect(await engine.finish({ budgetMs: 4000 })).toEqual({ ran: true, ok: true, timedOut: false });
    expect(manifests(h)).toHaveLength(1);
  });
});

describe('the API tells the engine about writes', () => {
  const TOKEN = 'c'.repeat(48);
  const servers: http.Server[] = [];
  const opened: ReturnType<typeof openDirectory>[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
    for (const d of opened.splice(0)) d.close();
  });

  async function serve(onChange: () => void) {
    const config = loadConfig({ PORT: '8787', TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', TABULA_CLOUD_TOKEN: TOKEN, TABULA_CLOUD_URL: 'https://cloud.example.com', TABULA_CLOUD_WORKSPACE_ID: 'ws_settle' });
    const directory = openDirectory(':memory:');
    opened.push(directory);
    const events = new EventEmitter();
    const cloud = createCloud({ config: config.cloud, directory, events, log: () => {} });
    const mailer = { async send() {} };
    const auth = createAuth({ directory, config, mailer, seatsAvailable: cloud?.seatsAvailable });
    const api = createApi({ directory, auth, config, roomExists: () => false, events, cloud: cloud as never, mailer, onChange });
    const server = http.createServer((req, res) => {
      void api.handle(req, res).then((handled: boolean) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (method: string, urlPath: string, body?: unknown, token: string | null = TOKEN) => {
      const res = await fetch(base + urlPath, {
        method,
        headers: { ...(method === 'GET' ? {} : { 'x-tabula': '1' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await res.text();
      return res.status;
    };
  }

  it('counts a call that wrote and succeeded, and nothing else', async () => {
    let changes = 0;
    const call = await serve(() => changes++);
    expect(await call('GET', '/api/internal/usage')).toBe(200);
    expect(await call('HEAD', '/api/internal/usage')).toBeLessThan(400);
    expect(changes).toBe(0);
    expect(await call('PUT', '/api/internal/limits', { banner: 'Hello' })).toBe(200);
    expect(changes).toBe(1);
    // refused, wrong, unauthenticated and unknown calls are not changes
    expect(await call('PUT', '/api/internal/limits', { nonsense: true })).toBe(400);
    expect(await call('PUT', '/api/internal/limits', { banner: 'x' }, 'x'.repeat(48))).toBe(401);
    expect(await call('PUT', '/api/internal/nothing', {})).toBe(404);
    expect(await call('DELETE', '/api/internal/usage')).toBe(405);
    expect(changes).toBe(1);
  });
});
