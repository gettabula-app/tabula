import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN, T0, harness, type Harness } from './backup-harness';

// docs/backups.md. The schedule: first run after one to five minutes, then every interval, never two at once, never a
// throw out of a timer, and a stop that lets go of everything.

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** A scheduler the test drives by hand; every timer is unref'd like the real ones. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { ms: number; fn: () => unknown; unref: ReturnType<typeof vi.fn<() => void>> }>();
  const unrefs: ReturnType<typeof vi.fn<() => void>>[] = [];
  return {
    setTimeout: (fn: () => unknown, ms: number): any => {
      const id = next++;
      const unref = vi.fn<() => void>();
      unrefs.push(unref);
      pending.set(id, { ms, fn, unref });
      return { id, unref };
    },
    clearTimeout: (handle: { id: number }) => void pending.delete(handle.id),
    get size() {
      return pending.size;
    },
    get delays() {
      return [...pending.values()].map((t) => t.ms);
    },
    /** Fires the oldest timer and waits for what it started. */
    async fire() {
      const [id, timer] = [...pending][0];
      pending.delete(id);
      await timer.fn();
    },
    unrefs,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('the schedule', () => {
  it('does nothing until it is started', async () => {
    h = await harness();
    const timers = fakeTimers();
    h.engine({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    expect(timers.size).toBe(0);
    expect(h.fake.log).toEqual([]);
  });

  it.each([
    [0, 60_000],
    [0.5, 180_000],
    [0.999999, 299_999],
  ])('starts the first run between one and five minutes after start (random %f)', async (random, delay) => {
    h = await harness();
    const timers = fakeTimers();
    const engine = h.engine({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => random });
    engine.start();
    expect(timers.delays[0]).toBeGreaterThanOrEqual(60_000);
    expect(timers.delays[0]).toBeLessThan(300_000);
    expect(Math.abs(timers.delays[0] - delay)).toBeLessThanOrEqual(1);
    expect(engine.status().nextRunAt).toBe(T0 + timers.delays[0]);
    expect(timers.unrefs[0]).toHaveBeenCalled();
    expect(h.fake.log).toEqual([]);
  });

  it('runs when the timer fires and schedules the next run one interval later', async () => {
    h = await harness({ env: { TABULA_BACKUP_INTERVAL_MINUTES: '15' } });
    const timers = fakeTimers();
    const engine = h.engine({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    engine.start();
    await timers.fire();
    expect(engine.status()).toMatchObject({ lastSuccessAt: T0, consecutiveFailures: 0, lastManifest: '20261008T193000Z.json.enc' });
    expect(timers.delays).toEqual([15 * MIN]);
    expect(engine.status().nextRunAt).toBe(T0 + 15 * MIN);
    h.clock.now += 15 * MIN;
    await timers.fire();
    expect(h.fake.count('PUT', /manifests/)).toBe(1);
    expect(engine.status().lastSuccessAt).toBe(T0 + 15 * MIN);
    expect(timers.delays).toEqual([15 * MIN]);
  });

  it('starting twice schedules once', async () => {
    h = await harness();
    const timers = fakeTimers();
    const engine = h.engine({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    engine.start();
    engine.start();
    expect(timers.size).toBe(1);
  });

  it('skips a tick that arrives while a run is in progress, and keeps the schedule', async () => {
    h = await harness();
    const timers = fakeTimers();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    const engine = h.engine({
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      fetch: async (url: string, init: RequestInit) => { await gate; return real(url, init); },
    });
    engine.start();
    const manual = engine.runNow();
    await settle();
    expect(engine.status().running).toBe(true);
    await timers.fire();
    expect(timers.size).toBe(1);
    expect(h.fake.count('PUT', /manifests/)).toBe(0);
    release();
    expect(await manual).toMatchObject({ ok: true });
    expect(h.fake.count('PUT', /manifests/)).toBe(1);
    expect(engine.status().consecutiveFailures).toBe(0);
  });

  it('a failing run in the timer throws nothing, is recorded, and is tried again', async () => {
    h = await harness({ accounts: true });
    const timers = fakeTimers();
    const engine = h.engine({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    h.fake.rules.push({ status: 403, times: 99 });
    engine.start();
    await expect(timers.fire()).resolves.toBeUndefined();
    expect(engine.status()).toMatchObject({ consecutiveFailures: 1, lastSuccessAt: null });
    expect(engine.status().lastFailureError).toBe('S3 GET failed (status 403, AccessDenied)');
    expect(timers.size).toBe(1);
    h.fake.rules.length = 0;
    h.clock.now += 60 * MIN;
    await timers.fire();
    expect(engine.status()).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: T0 + 60 * MIN });
  });

  it('an engine whose every dependency throws still never throws out of the timer', async () => {
    h = await harness();
    const timers = fakeTimers();
    const engine = h.engine({
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      backoffMs: [],
      fetch: () => { throw new Error('synchronous failure'); },
      log: () => { throw new Error('the logger is broken'); },
      directory: { getSetting: () => { throw new Error('no settings'); }, setSetting: () => { throw new Error('no settings'); }, audit: () => { throw new Error('no audit'); } },
    });
    engine.start();
    await expect(timers.fire()).resolves.toBeUndefined();
    expect(engine.status().consecutiveFailures).toBe(1);
    expect(timers.size).toBe(1);
  });

  it('stop cancels the timer, aborts a run in progress without counting a failure, and refuses to run again', async () => {
    h = await harness({ accounts: true });
    const timers = fakeTimers();
    const real = globalThis.fetch;
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => (entered = r));
    const engine = h.engine({
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      fetch: (url: string, init: RequestInit) => {
        if (!/manifests/.test(url) || init.method !== 'GET') return real(url, init);
        entered();
        return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      },
    });
    engine.start();
    const running = engine.runNow();
    await inFlight;
    expect(engine.status().running).toBe(true);
    await engine.stop();
    expect(await running).toEqual({ ok: false, aborted: true });
    expect(engine.status()).toMatchObject({ running: false, consecutiveFailures: 0, lastError: null, lastFailureAt: null, nextRunAt: null });
    expect(timers.size).toBe(0);
    expect(await engine.runNow()).toEqual({ ok: false, aborted: true });
    engine.start();
    expect(timers.size).toBe(0);
    expect(h.directory!.listAudit(10).filter((r) => String(r.action).startsWith('backup.'))).toEqual([]);
  });

  it('stop in the middle of an upload leaves objects but no manifest, and no temporary copy', async () => {
    h = await harness({ accounts: true });
    const real = globalThis.fetch;
    let puts = 0;
    let engine: ReturnType<Harness['engine']>;
    engine = h.engine({
      fetch: async (url: string, init: RequestInit) => {
        if (init.method === 'PUT' && ++puts === 3) void engine.stop();
        return real(url, init);
      },
    });
    const result = await engine.runNow();
    expect(result).toEqual({ ok: false, aborted: true });
    expect(h.fake.keys(/manifests/)).toEqual([]);
    expect(h.fake.keys(/objects/).length).toBeGreaterThan(0);
    expect(h.fake.keys(/objects/).length).toBeLessThan(h.expectedPaths().length);
    await engine.stop();
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(h.dir).filter((n) => n.startsWith('directory.sqlite.backup-'))).toEqual([]);
  });

  it('stop while the schedule waits is immediate', async () => {
    h = await harness();
    const timers = fakeTimers();
    const engine = h.engine({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    engine.start();
    await engine.stop();
    expect(timers.size).toBe(0);
    expect(engine.status().nextRunAt).toBeNull();
  });
});
