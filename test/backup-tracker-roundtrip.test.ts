import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackup, createKeyring, loadBackupConfig, seal, unseal } from '../server/backup.mjs';
import { sanitizeTrackerBlock } from '../server/tracker/backup-check.mjs';
import { openDirectory } from '../server/directory.mjs';
import { createTicket } from '../server/tracker/tickets.mjs';
import { KEY, T0, harness, type Harness } from './backup-harness';

let h: Harness | undefined;
const roots: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const keyring = createKeyring([KEY]);

/** Rewrites the sealed manifest in place with `edit` applied to its JSON, as a damaged or older writer would have left it. */
function rewriteManifest(read: (key: string) => Buffer, write: (key: string, body: Buffer) => void, key: string, name: string, edit: (body: Record<string, unknown>) => void) {
  const { plaintext } = unseal(read(key), `manifest:${name}`, keyring);
  const body = JSON.parse(plaintext.toString('utf8'));
  edit(body);
  write(key, seal(Buffer.from(JSON.stringify(body)), `manifest:${name}`, keyring.current));
}

describe('the manifest tracker block never makes a backup unlistable', () => {
  it('S3 target: an old manifest without the field and a malformed block both list and read, the rest intact', async () => {
    const rig = await harness({ accounts: true, seed: false });
    h = rig;
    const directory = rig.directory!;
    const owner = directory.db.prepare("SELECT id, name, role FROM users WHERE role = 'owner' LIMIT 1").get()!;
    createTicket({ directory, actor: { id: owner.id, name: owner.name, role: owner.role }, title: 'Round trip', now: T0 });
    const engine = rig.engine();
    expect(await rig.runAt(engine, T0)).toMatchObject({ ok: true, changed: true });
    const [{ name }] = await engine.listManifests();
    const written = await engine.readManifest(name);
    expect(written.tracker).toMatchObject({ summary: { tickets: 1 }, findings: [] });
    const key = rig.fake.keys(/manifests\//)[0];
    const read = (k: string) => rig.fake.objects.get(k)!.body;
    const write = (k: string, body: Buffer) => rig.fake.put(k, body);

    rewriteManifest(read, write, key, name, (body) => { delete body.tracker; });
    expect((await engine.readManifest(name)).tracker).toBeNull();

    for (const bad of [{ checkedAt: -1 }, 'text', [], { checkedAt: 5, summary: { tickets: 'many' }, findings: 'none' }, { checkedAt: 5, summary: null, findings: [{ code: 'BAD CODE', count: 1 }] }]) {
      rewriteManifest(read, write, key, name, (body) => { body.tracker = bad; });
      const listed = await engine.listManifests();
      expect(listed.map((m: { name: string }) => m.name)).toEqual([name]);
      const manifest = await engine.readManifest(name);
      expect(manifest.files).toEqual(written.files);
      expect(manifest.totals).toEqual(written.totals);
      // a block with a usable checkedAt but no usable summary is kept as advisory with check_failed; the others are null
      expect(manifest.tracker === null || manifest.tracker.summary === null).toBe(true);
      expect(manifest.tracker?.findings.some((f: { code: string }) => f.code === 'check_failed') ?? true).toBe(true);
    }
  });

  it('directory target: the block is written, read back and survives the same tampering', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-backup-tracker-dir-'));
    roots.push(root);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    const directory = openDirectory(path.join(dataDir, 'directory.sqlite'));
    closers.push(() => { try { directory.close(); } catch { /* already closed */ } });
    const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' })!;
    createTicket({ directory, actor: { id: owner.id, name: owner.name, role: owner.role }, title: 'Dir round trip', now: T0 });
    const loaded = loadBackupConfig({ TABULA_BACKUP_TARGET: 'dir', TABULA_BACKUP_KEY: KEY.toString('base64'), TABULA_BACKUP_VERIFY_HOURS: '0' }, () => {})!;
    const backup = createBackup({ config: loaded, dataDir, directory, now: () => T0, log: () => {}, random: () => 0, backoffMs: [0] })!;
    closers.push(() => backup.stop());
    const run = await backup.runNow();
    expect(run).toMatchObject({ ok: true, changed: true });
    const [{ name }] = await backup.listManifests();
    expect((await backup.readManifest(name)).tracker).toMatchObject({ summary: { tickets: 1 }, findings: [] });
    const file = path.join(dataDir, 'backup-export', 'tabula', 'manifests', name);
    const read = () => fs.readFileSync(file);
    const write = (_k: string, body: Buffer) => fs.writeFileSync(file, body);
    rewriteManifest(read, write, file, name, (body) => { body.tracker = { checkedAt: 'x', findings: 3 }; });
    const manifest = await backup.readManifest(name);
    expect(manifest.tracker).toBeNull();
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain('directory.sqlite');
  });
});

describe('sanitizeTrackerBlock', () => {
  const summary = {
    schema: 12, trackers: 1, tickets: 1, archived: 0, events: 1, maxEventId: 1, comments: 0, aliases: 0,
    links: 0, kanbanLinks: 0, outboxPending: 0, notifications: 0, ftsRows: 1,
  };

  it('skips a counter with a null scope or prefix, writes a numeric prefix as text and caps the counters at 100', () => {
    const counters = [
      { scope: 'trk_default', prefix: null, next: 2, maxNumber: 1 },
      { scope: null, prefix: 'TAB', next: 2, maxNumber: 1 },
      { scope: 'trk_a', prefix: 7, next: 3, maxNumber: 2 },
      ...Array.from({ length: 150 }, (_, i) => ({ scope: `s${i}`, prefix: 'P', next: 1, maxNumber: 0 })),
    ];
    const block = sanitizeTrackerBlock({ checkedAt: 1, summary: { ...summary, counters }, findings: [] })!;
    expect(block.summary!.counters).toHaveLength(100);
    expect(block.summary!.counters[0]).toEqual({ scope: 'trk_a', prefix: '7', next: 3, maxNumber: 2 });
    expect(block.summary!.counters.some((c: { scope: unknown; prefix: unknown }) => c.scope === null || c.prefix === null)).toBe(false);
    // what the writer produces is a fixed point of the parser's normalisation
    expect(sanitizeTrackerBlock(JSON.parse(JSON.stringify(block)))).toEqual(block);
  });

  it('never throws on anything', () => {
    for (const value of [undefined, null, 1, 'x', [], {}, { checkedAt: 1 }, { checkedAt: 1, findings: [null, 3, { code: 1 }] }, { checkedAt: 1, summary: { counters: 3 }, findings: [] }]) {
      expect(() => sanitizeTrackerBlock(value)).not.toThrow();
    }
  });
});
