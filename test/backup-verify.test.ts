import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createBackup, deriveKeys, loadBackupConfig, seal } from '../server/backup.mjs';
import { CREDS, DAY, HOUR, KEY, KEY_OTHER, MIN, T0, docBytes, envFor, harness, type Engine, type Harness } from './backup-harness';

// docs/backups.md, Checking the backups (TAB-126). Every cleanup compares what the kept manifests name with the bucket
// listing; a deep verify reads and decrypts a slice of the newest backup now and then; whatever is missing or damaged
// is put again by the next run when a file still has that content. The real engine against the fake S3, with the
// clock in the test's hands.

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const OBJECTS = /^tabula\/objects\//;
const OVERHEAD = 33;
const keyOf = (id: string) => `tabula/objects/${id}`;
const objectPuts = () => h.fake.count('PUT', OBJECTS);
const objectGets = () => h.fake.count('GET', OBJECTS);

type Entry = { path: string; size: number; objectId: string };
/**
 * The deep verify runs after a run, outside it (it never holds a run up). These tests look at what it found, so a run
 * here resolves once the deep verify it started has ended too.
 */
function verifying(engine: Engine): Engine {
  const runNow = engine.runNow.bind(engine);
  engine.runNow = (async (trigger?: Parameters<Engine['runNow']>[0]) => {
    const result = await runNow(trigger);
    await engine.deepIdle();
    return result;
  }) as Engine['runNow'];
  return engine;
}

const newest = async (engine: Engine) => engine.readManifest((await engine.listManifests())[0].name);
const entryOf = async (engine: Engine, rel: string) => ((await newest(engine)).files as Entry[]).find((f) => f.path === rel)!;
const uniqueObjects = async (engine: Engine) => new Set(((await newest(engine)).files as Entry[]).map((f) => f.objectId)).size;
const flip = (id: string) => {
  const stored = h.fake.objects.get(keyOf(id))!;
  const body = Buffer.from(stored.body);
  body[body.length - 20] ^= 1;
  h.fake.objects.set(keyOf(id), { body, lastModified: stored.lastModified });
};
const truncate = (id: string, by = 3) => {
  const stored = h.fake.objects.get(keyOf(id))!;
  h.fake.objects.set(keyOf(id), { body: stored.body.subarray(0, stored.body.length - by), lastModified: stored.lastModified });
};
const runs = (hh: Harness) => hh.directory!.listAudit(50).filter((r) => r.action === 'backup.run');
const everythingSaid = (engine: Engine, extra: unknown[] = []) =>
  JSON.stringify([engine.status(), h.directory?.getSetting('backup.status') ?? null, h.logs, h.directory?.listAudit(500) ?? [], ...extra]);

/** Holds the first read of an object once armed, until release(); an abort ends the held request like a real one. */
function holdObjectGets() {
  const real = globalThis.fetch;
  let armed = false;
  let reached: () => void = () => {};
  let release: () => void = () => {};
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const open = new Promise<void>((resolve) => (release = resolve));
  return {
    fetch: async (url: string, init: RequestInit) => {
      if (armed && init.method === 'GET' && url.includes('/objects/')) {
        reached();
        await new Promise<void>((resolve, reject) => {
          void open.then(resolve);
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      return real(url, init);
    },
    arm: () => {
      armed = true;
      return arrived;
    },
    release: () => release(),
  };
}

describe('the cleanup checks the bucket against the kept manifests', () => {
  it('finds an object that vanished, counts it without naming it, and puts it back at the next run', async () => {
    h = await harness({ accounts: true });
    const engine = verifying(h.engine());
    await engine.runNow();
    expect(engine.status()).toMatchObject({ verifiedAt: T0, verifyChecked: h.expectedPaths().length, missingObjects: 0, wrongSizeObjects: 0, unrepairableObjects: 0 });

    const victim = await entryOf(engine, 'b2.yjs');
    h.fake.objects.delete(keyOf(victim.objectId));
    h.clock.now += HOUR;
    const puts = objectPuts();
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false, uploaded: 0 });
    expect(objectPuts()).toBe(puts);
    expect(engine.status()).toMatchObject({ verifiedAt: T0 + HOUR, missingObjects: 1, wrongSizeObjects: 0, unrepairableObjects: 0, lastError: null, consecutiveFailures: 0 });
    expect(engine.status().prune).toMatchObject({ gcSkipped: null, error: null, objectsDeleted: 0 });
    expect(h.fake.objects.has(keyOf(victim.objectId))).toBe(false);
    const said = everythingSaid(engine);
    expect(said).not.toContain(victim.objectId);
    expect(said).not.toMatch(/[0-9a-f]{64}/);

    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false, uploaded: 1 });
    expect(h.fake.objects.get(keyOf(victim.objectId))!.body.length).toBe(victim.size + OVERHEAD);
    expect((await engine.readObject(victim.objectId)).length).toBe(victim.size);
    expect(engine.status()).toMatchObject({ verifiedAt: T0 + 2 * HOUR, missingObjects: 0, wrongSizeObjects: 0, unrepairableObjects: 0 });
    const [repair] = runs(h);
    expect(repair.detail).toMatchObject({ changed: false, uploaded: 1, repaired: 1 });
    expect(everythingSaid(engine)).not.toMatch(/[0-9a-f]{64}/);

    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, uploaded: 0 });
    expect(runs(h)).toHaveLength(2);
  });

  it('finds an object with the wrong size the same way', async () => {
    h = await harness({ accounts: true });
    const engine = verifying(h.engine());
    await engine.runNow();
    const victim = await entryOf(engine, 'b1.yjs');
    truncate(victim.objectId);
    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, uploaded: 0 });
    expect(engine.status()).toMatchObject({ missingObjects: 0, wrongSizeObjects: 1, unrepairableObjects: 0, lastError: null });
    expect(h.fake.objects.get(keyOf(victim.objectId))!.body.length).toBe(victim.size + OVERHEAD - 3);

    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, uploaded: 1 });
    expect(h.fake.objects.get(keyOf(victim.objectId))!.body.length).toBe(victim.size + OVERHEAD);
    expect(engine.status()).toMatchObject({ missingObjects: 0, wrongSizeObjects: 0 });
    expect(runs(h)[0].detail).toMatchObject({ uploaded: 1, repaired: 1 });
  });

  it('keeps reporting an object only an old manifest names and no file has, and never deletes it while it is named', async () => {
    h = await harness();
    const engine = verifying(h.engine());
    await engine.runNow();
    const [oldB1, oldB2] = [await entryOf(engine, 'b1.yjs'), await entryOf(engine, 'b2.yjs')];
    h.write('b1.yjs', docBytes('board one, second'));
    h.write('b2.yjs', docBytes('board two, second'));
    h.clock.now += 3 * HOUR;
    await engine.runNow();
    expect(await engine.listManifests()).toHaveLength(2);

    h.fake.objects.delete(keyOf(oldB1.objectId));
    truncate(oldB2.objectId);
    h.fake.objects.get(keyOf(oldB2.objectId))!.lastModified = T0 - 10 * DAY;
    h.clock.now += 3 * HOUR;
    const puts = objectPuts();
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false, uploaded: 0 });
    expect(engine.status()).toMatchObject({ missingObjects: 1, wrongSizeObjects: 1, unrepairableObjects: 2, lastError: null });
    expect(engine.status().prune).toMatchObject({ gcSkipped: null, objectsDeleted: 0 });
    expect(h.fake.objects.has(keyOf(oldB2.objectId))).toBe(true);

    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, uploaded: 0 });
    expect(objectPuts()).toBe(puts);
    expect(engine.status()).toMatchObject({ missingObjects: 1, wrongSizeObjects: 1, unrepairableObjects: 2 });
    expect(h.fake.objects.has(keyOf(oldB2.objectId))).toBe(true);

    // The old manifest ages out: nothing names the objects any more, so nothing is reported and the leftover is cleaned up.
    h.clock.now += 31 * DAY;
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(await engine.listManifests()).toHaveLength(1);
    expect(engine.status()).toMatchObject({ missingObjects: 0, wrongSizeObjects: 0, unrepairableObjects: 0 });
    expect(h.fake.objects.has(keyOf(oldB2.objectId))).toBe(false);
  });

  it('puts back an object an old manifest names when a file has that content again', async () => {
    h = await harness();
    const engine = verifying(h.engine());
    await engine.runNow();
    const oldB2 = await entryOf(engine, 'b2.yjs');
    const original = Buffer.from(await engine.readObject(oldB2.objectId));
    h.write('b2.yjs', docBytes('board two, second'));
    h.clock.now += 3 * HOUR;
    await engine.runNow();
    h.fake.objects.delete(keyOf(oldB2.objectId));
    h.clock.now += HOUR;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ missingObjects: 1, unrepairableObjects: 1 });

    h.write('b2.yjs', original);
    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, uploaded: 1 });
    expect(engine.status()).toMatchObject({ missingObjects: 0, unrepairableObjects: 0 });
    expect(h.fake.objects.has(keyOf(oldB2.objectId))).toBe(true);
  });

  it('reports what it knows when a kept manifest cannot be read, and still deletes nothing', async () => {
    h = await harness();
    const engine = verifying(h.engine());
    await engine.runNow();
    h.write('b2.yjs', docBytes('board two, second'));
    h.clock.now += 3 * HOUR;
    await engine.runNow();
    const [, older] = await engine.listManifests();
    const stored = h.fake.objects.get(`tabula/manifests/${older.name}`)!;
    stored.body[40] ^= 1;
    const victim = await entryOf(engine, 'b1.yjs');
    h.fake.objects.delete(keyOf(victim.objectId));
    const orphan = `tabula/objects/${'ab'.repeat(32)}`;
    h.fake.objects.set(orphan, { body: Buffer.from('orphan'), lastModified: T0 - 5 * DAY });

    h.clock.now += 3 * HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(engine.status().prune).toMatchObject({ gcSkipped: 'unreadable_manifest', objectsDeleted: 0 });
    expect(h.fake.objects.has(orphan)).toBe(true);
    expect(engine.status()).toMatchObject({ verifiedAt: h.clock.now, missingObjects: 1, wrongSizeObjects: 0, verifyChecked: await uniqueObjects(engine) });
  });

  it('leaves the numbers alone when the cleanup cannot even list the bucket', async () => {
    h = await harness();
    const engine = verifying(h.engine());
    await engine.runNow();
    const victim = await entryOf(engine, 'b2.yjs');
    h.fake.objects.delete(keyOf(victim.objectId));
    h.clock.now += HOUR;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ missingObjects: 1, verifiedAt: T0 + HOUR });
    h.fake.rules.push({ method: 'GET', key: /^$/, skip: 2, status: 500, times: 99 });
    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(engine.status().prune).toMatchObject({ error: expect.any(String) });
    expect(engine.status()).toMatchObject({ missingObjects: 1, verifiedAt: T0 + HOUR });
  });

  it('keeps an object suspect when its repair fails, and repairs it at a later run', async () => {
    h = await harness({ accounts: true });
    const engine = verifying(h.engine());
    await engine.runNow();
    const victim = await entryOf(engine, 'b2.yjs');
    h.fake.objects.delete(keyOf(victim.objectId));
    h.clock.now += HOUR;
    await engine.runNow();
    h.fake.rules.push({ method: 'PUT', key: OBJECTS, status: 403, times: 99 });
    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: false });
    expect(engine.status()).toMatchObject({ consecutiveFailures: 1, missingObjects: 1 });
    h.fake.rules.length = 0;
    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, uploaded: 1 });
    expect(engine.status()).toMatchObject({ missingObjects: 0, consecutiveFailures: 0 });
  });

  it('repairs an object that went missing while the process was down, as before', async () => {
    h = await harness();
    await verifying(h.engine()).runNow();
    const [victim] = h.fake.keys(OBJECTS);
    h.fake.objects.delete(victim);
    h.clock.now += HOUR;
    const restarted = verifying(h.engine());
    expect(await restarted.runNow()).toMatchObject({ ok: true, uploaded: 1 });
    expect(restarted.status()).toMatchObject({ missingObjects: 0 });
  });

  it('survives a restart: the stored numbers are read back, and the engine never shows its own bookkeeping', async () => {
    h = await harness({ accounts: true });
    const first = verifying(h.engine());
    await first.runNow();
    const victim = await entryOf(first, 'b2.yjs');
    h.fake.objects.delete(keyOf(victim.objectId));
    h.clock.now += HOUR;
    await first.runNow();
    const again = verifying(h.engine());
    expect(again.status()).toMatchObject({ verifiedAt: T0 + HOUR, missingObjects: 1, verifyChecked: h.expectedPaths().length });
    for (const internal of ['deepSince', 'deepCursor', 'deepCycleOk']) expect(again.status()).not.toHaveProperty(internal);
    expect(JSON.parse(String(h.directory!.getSetting('backup.status')))).toHaveProperty('deepSince');
  });
});

describe('the deep verify', () => {
  const env = (extra: Record<string, string> = {}) => ({ TABULA_BACKUP_VERIFY_HOURS: '24', ...extra });

  it('reads the objects a day after the first run, finds a flipped byte, and the next run puts the object back', async () => {
    h = await harness({ accounts: true, env: env() });
    const engine = verifying(h.engine());
    await engine.runNow();
    const n = await uniqueObjects(engine);
    expect(objectGets()).toBe(0);
    expect(engine.status()).toMatchObject({ deepVerifiedAt: null, deepChecked: 0, deepDamaged: 0, deepCovered: 0 });

    const victim = await entryOf(engine, 'b2.yjs');
    flip(victim.objectId);
    h.clock.now += 25 * HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false });
    expect(objectGets()).toBe(n);
    expect(engine.status()).toMatchObject({ deepVerifiedAt: T0 + 25 * HOUR, deepChecked: n, deepDamaged: 1, deepSkipped: 0, deepCovered: 1, missingObjects: 0, wrongSizeObjects: 0, lastError: null });
    expect(h.logs.join('\n')).toContain('the deep check found 1 damaged object(s)');
    await expect(engine.readObject(victim.objectId)).rejects.toMatchObject({ code: 'tamper' });

    const gets = objectGets();
    h.clock.now += 10 * MIN;
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false, uploaded: 1 });
    expect(objectGets()).toBe(gets);
    expect((await engine.readObject(victim.objectId)).length).toBe(victim.size);
    expect(engine.status()).toMatchObject({ deepDamaged: 0, deepVerifiedAt: T0 + 25 * HOUR, missingObjects: 0 });
    expect(runs(h)[0].detail).toMatchObject({ uploaded: 1, repaired: 1 });
  });

  it('finds an object swapped for another one under its name, which the listing cannot see', async () => {
    h = await harness({ accounts: true, env: env() });
    // The same size, so the listing cannot tell them apart.
    h.write('b1.yjs', crypto.randomBytes(64));
    h.write('b2.yjs', crypto.randomBytes(64));
    const engine = verifying(h.engine());
    await engine.runNow();
    const [a, b] = [await entryOf(engine, 'b1.yjs'), await entryOf(engine, 'b2.yjs')];
    expect(a.size).toBe(b.size);
    h.fake.objects.set(keyOf(a.objectId), { body: Buffer.from(h.fake.objects.get(keyOf(b.objectId))!.body), lastModified: T0 });
    h.clock.now += 24 * HOUR;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ missingObjects: 0, wrongSizeObjects: 0, deepDamaged: 1 });
    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ uploaded: 1 });
    expect((await engine.readObject(a.objectId)).length).toBe(a.size);
    expect(engine.status().deepDamaged).toBe(0);
  });

  it('finds an object that decrypts but is not what its name says, and one that is too large', async () => {
    h = await harness({ env: env() });
    const engine = verifying(h.engine());
    await engine.runNow();
    const [a, b] = [await entryOf(engine, 'b1.yjs'), await entryOf(engine, 'b2.yjs')];
    const keys = deriveKeys(KEY);
    const wrongContent = crypto.randomBytes(a.size);
    h.fake.objects.set(keyOf(a.objectId), { body: seal(wrongContent, `obj:${a.objectId}`, keys), lastModified: T0 });
    h.fake.objects.set(keyOf(b.objectId), { body: Buffer.concat([h.fake.objects.get(keyOf(b.objectId))!.body, Buffer.alloc(40)]), lastModified: T0 });
    h.clock.now += 24 * HOUR;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ wrongSizeObjects: 1, deepDamaged: 2, missingObjects: 0 });
  });

  it('finds an object that is gone although the listing showed it', async () => {
    h = await harness({ env: env() });
    const real = globalThis.fetch;
    let hide: string | null = null;
    const engine = verifying(h.engine({
      fetch: async (url: string, init: RequestInit) =>
        hide && init.method === 'GET' && url.includes(hide) ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }) : real(url, init),
    }));
    await engine.runNow();
    // The listing is stale for a moment: the cleanup sees the object, the read does not.
    hide = (await entryOf(engine, 'b2.yjs')).objectId;
    h.clock.now += 24 * HOUR;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ deepDamaged: 1, missingObjects: 0 });
  });

  it('counts a provider that fails as skipped, not damaged, tries again at the next check, and never fails the run', async () => {
    h = await harness({ accounts: true, env: env() });
    const engine = verifying(h.engine());
    await engine.runNow();
    const n = await uniqueObjects(engine);
    h.clock.now += 25 * HOUR;
    h.fake.rules.push({ method: 'GET', key: OBJECTS, status: 500, times: 99 });
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(engine.status()).toMatchObject({ deepDamaged: 0, deepSkipped: 1, deepChecked: 0, deepVerifiedAt: null, lastError: null, consecutiveFailures: 0, lastSuccessAt: T0 + 25 * HOUR });
    expect(h.logs.join('\n')).toContain('the deep check stopped early (S3 GET failed (status 500, InternalError))');

    h.fake.rules.length = 0;
    h.fake.rules.push({ method: 'GET', key: OBJECTS, status: 403, times: 99 });
    h.clock.now += 5 * MIN;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ deepDamaged: 0, deepSkipped: 1, deepChecked: 0, deepVerifiedAt: null });

    h.fake.rules.length = 0;
    h.clock.now += 5 * MIN;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ deepDamaged: 0, deepSkipped: 0, deepChecked: n, deepCovered: 1, deepVerifiedAt: h.clock.now });
  });

  it('never reads more than its budget, moves on from where it stopped, and wraps round', async () => {
    h = await harness({ seed: false, env: env({ TABULA_BACKUP_VERIFY_MAX_MB: '1' }) });
    for (let i = 0; i < 5; i++) h.write(`r${i}.yjs`, crypto.randomBytes(400_000));
    const engine = verifying(h.engine());
    await engine.runNow();
    const sealed = 400_000 + OVERHEAD;
    const all = h.fake.keys(OBJECTS);
    expect(all).toHaveLength(5);

    const covered: number[] = [];
    const checked: number[] = [];
    const seen = new Set<string>();
    for (let pass = 0; pass < 4; pass++) {
      h.clock.now += 25 * HOUR;
      const before = h.fake.log.length;
      await engine.runNow();
      const read = h.fake.log.slice(before).filter((l) => l.method === 'GET' && OBJECTS.test(l.key)).map((l) => l.key);
      expect(read.length * sealed).toBeLessThanOrEqual(1024 * 1024);
      if (pass < 3) for (const key of read) seen.add(key);
      covered.push(engine.status().deepCovered);
      checked.push(engine.status().deepChecked);
    }
    expect(checked).toEqual([2, 2, 1, 2]);
    expect(covered).toEqual([0.4, 0.8, 1, 0.4]);
    expect([...seen].sort()).toEqual(all);
  });

  it('skips an object that is larger than the whole budget, and says so', async () => {
    h = await harness({ seed: false, env: env({ TABULA_BACKUP_VERIFY_MAX_MB: '1' }) });
    h.write('big.yjs', crypto.randomBytes(1_100_000));
    h.write('s1.yjs', crypto.randomBytes(1000));
    h.write('s2.yjs', crypto.randomBytes(1000));
    const engine = verifying(h.engine());
    await engine.runNow();
    const big = await entryOf(engine, 'big.yjs');
    h.clock.now += 25 * HOUR;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ deepChecked: 2, deepSkipped: 1, deepDamaged: 0, deepVerifiedAt: h.clock.now });
    expect(engine.status().deepCovered).toBeCloseTo(2 / 3);
    expect(h.fake.log.some((l) => l.method === 'GET' && l.key.endsWith(big.objectId))).toBe(false);
  });

  it('continues where it stopped after a restart, and keeps its place out of the status', async () => {
    h = await harness({ seed: false, accounts: true, env: env({ TABULA_BACKUP_VERIFY_MAX_MB: '1' }) });
    for (let i = 0; i < 5; i++) h.write(`r${i}.yjs`, crypto.randomBytes(400_000));
    await verifying(h.engine()).runNow();
    const readSince = (from: number) => h.fake.log.slice(from).filter((l) => l.method === 'GET' && OBJECTS.test(l.key)).map((l) => l.key);

    h.clock.now += 25 * HOUR;
    let from = h.fake.log.length;
    const a = verifying(h.engine());
    await a.runNow();
    const firstRead = readSince(from);
    const { deepChecked } = a.status();
    expect(deepChecked).toBe(firstRead.length);
    expect(deepChecked).toBeGreaterThan(0);
    expect(deepChecked).toBeLessThan(6);
    const stored = JSON.parse(String(h.directory!.getSetting('backup.status')));
    expect(stored).toMatchObject({ deepCursor: deepChecked, deepCycleOk: deepChecked });
    expect(JSON.stringify(stored)).not.toMatch(/[0-9a-f]{64}/);

    h.clock.now += 25 * HOUR;
    from = h.fake.log.length;
    const b = verifying(h.engine());
    await b.runNow();
    const secondRead = readSince(from);
    expect(secondRead.length).toBeGreaterThan(0);
    for (const key of secondRead) expect(firstRead).not.toContain(key);
    expect(b.status().deepCovered).toBeCloseTo(Math.min(1, (firstRead.length + secondRead.length) / 6));
  });

  it('runs at most once per VERIFY_HOURS, and not in the first run after a start unless it is due', async () => {
    h = await harness({ accounts: true, env: env() });
    const engine = verifying(h.engine());
    await engine.runNow();
    const n = await uniqueObjects(engine);
    h.clock.now += 23 * HOUR;
    await engine.runNow();
    expect(objectGets()).toBe(0);
    h.clock.now += HOUR;
    await engine.runNow();
    expect(objectGets()).toBe(n);
    h.clock.now += HOUR;
    await engine.runNow();
    h.clock.now += 22 * HOUR;
    await engine.runNow();
    expect(objectGets()).toBe(n);
    h.clock.now += HOUR;
    await engine.runNow();
    expect(objectGets()).toBe(2 * n);
    expect(engine.status().deepVerifiedAt).toBe(h.clock.now);

    // A restarted engine goes by the stored time: not due an hour later, due a day later.
    h.clock.now += HOUR;
    const restarted = verifying(h.engine());
    await restarted.runNow();
    expect(objectGets()).toBe(2 * n);
    h.clock.now += 24 * HOUR;
    await restarted.runNow();
    expect(objectGets()).toBe(3 * n);
  });

  it('is off with 0', async () => {
    h = await harness({ env: env({ TABULA_BACKUP_VERIFY_HOURS: '0' }) });
    const engine = verifying(h.engine());
    await engine.runNow();
    for (let i = 0; i < 3; i++) {
      h.clock.now += 40 * DAY;
      await engine.runNow();
    }
    expect(objectGets()).toBe(0);
    expect(engine.status()).toMatchObject({ deepVerifiedAt: null, deepChecked: 0 });
  });

  it('is not part of the final backup of a shutdown', async () => {
    h = await harness({ env: env() });
    const engine = verifying(h.engine());
    await engine.runNow();
    engine.start();
    h.clock.now += 30 * HOUR;
    h.write('b2.yjs', docBytes('changed before the stop'));
    engine.noteChange();
    expect(await engine.finish({ budgetMs: 4000 })).toEqual({ ran: true, ok: true, timedOut: false });
    expect(engine.status()).toMatchObject({ lastTrigger: 'shutdown', deepVerifiedAt: null });
    expect(objectGets()).toBe(0);
  });

  it('stops when a shutdown starts while it is reading, and the run is still a success', async () => {
    h = await harness({ env: env() });
    const gate = holdObjectGets();
    const engine = verifying(h.engine({ fetch: gate.fetch }));
    await engine.runNow();
    expect(await uniqueObjects(engine)).toBeGreaterThan(2);
    h.clock.now += 25 * HOUR;
    const arrived = gate.arm();
    const run = engine.runNow();
    await arrived;
    const finishing = engine.finish({ budgetMs: 4000 });
    // the read in progress is cut short at once: it never reaches the bucket, and nothing waits for the gate
    expect(await run).toMatchObject({ ok: true });
    await finishing;
    gate.release();
    expect(objectGets()).toBe(0);
    expect(engine.status()).toMatchObject({ lastSuccessAt: T0 + 25 * HOUR, deepVerifiedAt: null, lastError: null });
  });

  it('gives way at once to a run asked for while it is reading (a restore\'s safety backup), and carries on later', async () => {
    h = await harness({ env: env() });
    const gate = holdObjectGets();
    // not wrapped: a run here resolves when the run is done, the deep verify goes on after it
    const engine = h.engine({ fetch: gate.fetch });
    await engine.runNow();
    h.clock.now += 25 * HOUR;
    const arrived = gate.arm();
    expect(await engine.runNow()).toMatchObject({ ok: true });
    await arrived;
    // the deep verify is now waiting on the bucket; a safety backup must not wait for it
    h.write('b2.yjs', docBytes('changed just before a restore'));
    const safety = await engine.runNow('manual');
    expect(safety).toMatchObject({ ok: true, uploaded: 1 });
    // the interrupted check is not started again by the run that interrupted it: nothing is left waiting on the bucket
    expect(await Promise.race([engine.deepIdle().then(() => 'idle'), new Promise((r) => setTimeout(() => r('waiting'), 500))])).toBe('idle');
    await engine.deepIdle();
    expect(engine.status()).toMatchObject({ deepVerifiedAt: null, deepDamaged: 0, lastError: null });
    expect(objectGets()).toBe(0);
    // with the bucket answering again, the next run's check reads the backup after all
    gate.release();
    expect(await engine.runNow()).toMatchObject({ ok: true });
    await engine.deepIdle();
    expect(engine.status().deepVerifiedAt).toBe(h.clock.now);
    expect(objectGets()).toBeGreaterThan(0);
  });

  it('never costs a shutdown its final backup when it is reading at that moment', async () => {
    h = await harness({ env: env() });
    const gate = holdObjectGets();
    const engine = h.engine({ fetch: gate.fetch });
    await engine.runNow();
    engine.start();
    h.clock.now += 25 * HOUR;
    const arrived = gate.arm();
    expect(await engine.runNow()).toMatchObject({ ok: true });
    await arrived;
    h.write('b2.yjs', docBytes('changed during the deep verify'));
    engine.noteChange();
    expect(await engine.finish({ budgetMs: 4000 })).toEqual({ ran: true, ok: true, timedOut: false });
    expect(engine.status()).toMatchObject({ lastTrigger: 'shutdown', deepVerifiedAt: null });
    gate.release();
    await engine.stop();
  });

  it('is aborted by stop(), which still resolves', async () => {
    h = await harness({ env: env() });
    const gate = holdObjectGets();
    const engine = verifying(h.engine({ fetch: gate.fetch }));
    await engine.runNow();
    h.clock.now += 25 * HOUR;
    const arrived = gate.arm();
    const run = engine.runNow();
    await arrived;
    await expect(engine.stop()).resolves.toBeUndefined();
    expect(await run).toMatchObject({ ok: true });
    expect(engine.status()).toMatchObject({ deepVerifiedAt: null, deepDamaged: 0, lastSuccessAt: T0 + 25 * HOUR });
    expect(objectGets()).toBe(0);
  });

  it('counts a damaged object whose file changed since as unrepairable until its manifest ages out', async () => {
    h = await harness({ env: env() });
    const engine = verifying(h.engine());
    await engine.runNow();
    const victim = await entryOf(engine, 'b2.yjs');
    flip(victim.objectId);
    h.clock.now += 25 * HOUR;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ deepDamaged: 1, unrepairableObjects: 0 });

    h.write('b2.yjs', docBytes('board two, second'));
    h.clock.now += 10 * MIN;
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: true });
    expect(engine.status()).toMatchObject({ deepDamaged: 1, unrepairableObjects: 1, missingObjects: 0 });
    expect(h.fake.objects.has(keyOf(victim.objectId))).toBe(true);

    h.clock.now += 31 * DAY;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ deepDamaged: 0, unrepairableObjects: 0 });
    expect(h.fake.objects.has(keyOf(victim.objectId))).toBe(false);
  });

  it('keeps showing damage it found before a restart, and finds it again within a full rotation', async () => {
    h = await harness({ accounts: true, env: env() });
    const first = verifying(h.engine());
    await first.runNow();
    const victim = await entryOf(first, 'b2.yjs');
    flip(victim.objectId);
    h.clock.now += 25 * HOUR;
    await first.runNow();
    expect(first.status().deepDamaged).toBe(1);

    // The new process cannot name the object, so it does not repair it, and it does not claim all is well either.
    h.clock.now += 5 * MIN;
    const second = verifying(h.engine());
    expect(second.status().deepDamaged).toBe(1);
    expect(await second.runNow()).toMatchObject({ ok: true, uploaded: 0 });
    expect(second.status().deepDamaged).toBe(1);

    h.clock.now += 25 * HOUR;
    await second.runNow();
    expect(second.status()).toMatchObject({ deepDamaged: 1, deepCovered: 1 });
    h.clock.now += 5 * MIN;
    expect(await second.runNow()).toMatchObject({ uploaded: 1 });
    expect(second.status().deepDamaged).toBe(0);
  });

  it('has a finished rotation for a backup with nothing in it', async () => {
    h = await harness({ seed: false, env: env() });
    const engine = verifying(h.engine());
    await engine.runNow();
    h.clock.now += 25 * HOUR;
    await engine.runNow();
    expect(engine.status()).toMatchObject({ deepChecked: 0, deepCovered: 1, deepVerifiedAt: h.clock.now, deepDamaged: 0 });
  });
});

describe('the settings', () => {
  const load = (extra: Record<string, string> = {}) => loadBackupConfig({ ...envFor({ url: 'http://127.0.0.1:9000' } as never), ...extra }, () => {})!;
  const message = (extra: Record<string, string>) => {
    try {
      load(extra);
    } catch (err) {
      return (err as Error).message;
    }
    return null;
  };

  it('reads the defaults', () => {
    expect(load()).toMatchObject({ verifyHours: 24, verifyMaxMb: 64 });
    expect(load({ TABULA_BACKUP_VERIFY_HOURS: '', TABULA_BACKUP_VERIFY_MAX_MB: '' })).toMatchObject({ verifyHours: 24, verifyMaxMb: 64 });
  });

  it.each([
    { name: 'TABULA_BACKUP_VERIFY_HOURS', field: 'verifyHours', min: 0, max: 720, good: ['0', '1', '24', '720'], bad: ['-1', '721', '99999', '1.5', 'daily', '1e1', '0x10', '1000000', ' 5 x'] },
    { name: 'TABULA_BACKUP_VERIFY_MAX_MB', field: 'verifyMaxMb', min: 1, max: 4096, good: ['1', '64', '4096'], bad: ['0', '-1', '4097', '64.5', 'big', '1e2', '0x40', '1000000'] },
  ])('$name: whole numbers in range are read, anything else is an error that names the variable and not the value', ({ name, field, min, max, good, bad }) => {
    for (const value of good) expect((load({ [name]: value }) as unknown as Record<string, number>)[field]).toBe(Number(value));
    for (const value of bad) expect([value, message({ [name]: value })]).toEqual([value, `${name} must be a whole number from ${min} to ${max}`]);
    const secret = CREDS.secretKey;
    expect(message({ [name]: secret })).not.toContain(secret);
  });

  it('reads the old MIRA_ spelling', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envFor({ url: 'http://127.0.0.1:9000' } as never, { TABULA_BACKUP_VERIFY_HOURS: '6', TABULA_BACKUP_VERIFY_MAX_MB: '8' }))) env[k.replace('TABULA_', 'MIRA_')] = v;
    expect(loadBackupConfig(env, () => {})).toMatchObject({ verifyHours: 6, verifyMaxMb: 8 });
    expect(() => loadBackupConfig({ ...env, MIRA_BACKUP_VERIFY_MAX_MB: '0' }, () => {})).toThrow('TABULA_BACKUP_VERIFY_MAX_MB must be a whole number from 1 to 4096');
  });
});

describe('nothing the check says holds a secret or an object id', () => {
  it('through missing, damaged and unreadable objects and a provider that echoes the secrets', async () => {
    h = await harness({ accounts: true, env: { TABULA_BACKUP_VERIFY_HOURS: '24', TABULA_BACKUP_KEY_PREVIOUS: KEY_OTHER.toString('hex') } });
    const hostile = `secret=${CREDS.secretKey} access=${CREDS.accessKey} key=${KEY.toString('hex')} ${KEY.toString('base64')}`;
    const real = globalThis.fetch;
    let hostileGets = false;
    const errors: string[] = [];
    const engine = verifying(h.engine({
      fetch: async (url: string, init: RequestInit) => {
        if (hostileGets && init.method === 'GET' && url.includes('/objects/')) {
          return new Response(`<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>${hostile}</Message></Error>`, { status: 403 });
        }
        return real(url, init);
      },
    }));
    await engine.runNow();
    const manifest = await newest(engine);
    const ids = (manifest.files as Entry[]).map((f) => f.objectId);

    h.fake.objects.delete(keyOf(ids[0]));
    truncate(ids[1]);
    flip(ids[2]);
    h.clock.now += 25 * HOUR;
    await engine.runNow();
    h.clock.now += HOUR;
    await engine.runNow();
    hostileGets = true;
    await engine.readObject(ids[3]).catch((err: Error) => errors.push(`${err.name}: ${err.message}`));
    h.clock.now += 25 * HOUR;
    await engine.runNow();
    hostileGets = false;

    const text = everythingSaid(engine, [errors]);
    expect(h.logs.join('\n')).toContain('the deep check stopped early');
    expect(text.length).toBeGreaterThan(2000);
    const keys = deriveKeys(KEY);
    for (const secret of [CREDS.secretKey, CREDS.accessKey, KEY.toString('hex'), KEY.toString('base64'), KEY.toString('base64url'), keys.encKey.toString('hex'), keys.nameKey.toString('hex'), ...ids]) {
      expect(text.includes(secret), `output contains ${secret.slice(0, 10)}...`).toBe(false);
    }
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toContain('Signature=');
  });
});

describe('the engine without a directory and with an outdated config object', () => {
  it('works on a config that has no verify settings (the defaults apply)', async () => {
    h = await harness();
    const base = h.config();
    const bare = Object.create(base, { verifyHours: { value: undefined }, verifyMaxMb: { value: undefined } });
    const engine = verifying(createBackup({ config: bare, dataDir: h.dir, log: () => {}, now: () => h.clock.now, backoffMs: [0], random: () => 0 })!);
    expect(await engine.runNow()).toMatchObject({ ok: true });
    h.clock.now += 25 * HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(engine.status().deepVerifiedAt).toBe(h.clock.now);
    await engine.stop();
  });
});
