import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assetHashOf, isBackupPath } from '../server/backup.mjs';
import { RestoreError } from '../server/restore.mjs';
import { HOUR, MIN, T0, harness, type Harness } from './backup-harness';
import { backedUp, backupNow, becomeB, CONFIRM, forge, ownerOf, raw, rig, seedA } from './restore-harness';
import { makeGif, makeJpeg, makePng } from './image-fixtures';

// docs/images.md, Backups, and docs/backups.md: the image files are in the backup and come back with a restore.

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const relOf = (hash: string) => `assets/${hash.slice(0, 2)}/${hash}`;

/** Puts an image file where the store keeps it, and a row for it on `board` when the directory has one. */
function addAsset(bytes: Buffer, board?: string) {
  const hash = sha(bytes);
  h.write(relOf(hash), bytes);
  if (board && h.directory) h.directory.putAsset({ boardId: board, hash, mime: 'image/png', bytes: bytes.length, width: 4, height: 3, createdBy: null, createdAt: T0 });
  return hash;
}
const objectPuts = () => h.fake.count('PUT', /^tabula\/objects\//);

describe('the backup walk', () => {
  describe.each([
    ['without a directory (open mode)', false],
    ['with the accounts directory', true],
  ] as const)('%s', (_name, accounts) => {
    it('backs up every image file, byte for byte', async () => {
      h = await harness({ accounts });
      const a = addAsset(makePng());
      const b = addAsset(makeJpeg({ exif: false }));
      const engine = h.engine();
      expect(await engine.runNow()).toMatchObject({ ok: true, changed: true, files: h.expectedPaths().length + 2 });
      const manifest = await engine.readManifest((await engine.listManifests())[0].name);
      const paths = manifest.files.map((f: { path: string }) => f.path);
      expect(paths).toEqual([...h.expectedPaths(), relOf(a), relOf(b)].sort());
      const images = (manifest.files as { path: string; objectId: string }[]).filter((f) => f.path.startsWith('assets/'));
      expect(images).toHaveLength(2);
      for (const f of images) expect((await engine.readObject(f.objectId)).equals(fs.readFileSync(h.file(f.path)))).toBe(true);
    });

    it('uploads nothing again for images that did not change, and a new one costs one object', async () => {
      h = await harness({ accounts });
      addAsset(makePng());
      const engine = h.engine();
      await h.runAt(engine, T0);
      const first = objectPuts();
      const again = await h.runAt(engine, T0 + HOUR);
      expect(again).toMatchObject({ ok: true, changed: false, uploaded: 0 });
      expect(objectPuts()).toBe(first);
      addAsset(makeGif());
      const added = await h.runAt(engine, T0 + 2 * HOUR);
      expect(added).toMatchObject({ changed: true, uploaded: 1 });
    });
  });

  it('leaves out what is not an image file of the store, and a file that does not match its name', async () => {
    h = await harness({ accounts: true });
    const good = addAsset(makePng());
    const damaged = sha(Buffer.from('what the name promises'));
    h.write(relOf(damaged), 'something else');
    h.write('assets/tmp/0123456789abcdef.tmp', 'half written');
    h.write('assets/index.json', '[]');
    h.write(`assets/${good.slice(0, 2)}/${good}0`, 'a name one digit too long');
    h.write(`assets/${good.slice(0, 2)}q/${good}`, 'a shard directory that is not two hex digits');
    h.write(`assets/00/${'ab'.repeat(32)}`, 'wrong shard for this hash');
    h.write('assets/ab/short', 'not a hash');
    h.write(`assets/${good.slice(0, 2)}/${good}.tmp`, 'a temporary copy');
    const engine = h.engine();
    const result = await engine.runNow();
    expect(result).toMatchObject({ ok: true });
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    expect(manifest.files.map((f: { path: string }) => f.path).filter((p: string) => p.startsWith('assets/'))).toEqual([relOf(good)]);
    expect(h.logs.join('\n')).toContain('does not match its name');
  });

  it('knows which paths are image files', () => {
    const hash = 'ab'.repeat(32);
    expect(assetHashOf(`assets/ab/${hash}`)).toBe(hash);
    expect(isBackupPath(`assets/ab/${hash}`)).toBe(true);
    for (const bad of [`assets/ac/${hash}`, `assets/ab/${hash.toUpperCase()}`, `assets/ab/${hash}/x`, `assets/ab/${hash.slice(1)}`, 'assets/ab', `assets/../${hash}`, `Assets/ab/${hash}`, `assets/ab/${hash}.tmp`]) {
      expect([bad, assetHashOf(bad), isBackupPath(bad)]).toEqual([bad, null, false]);
    }
  });
});

describe('restoring images', () => {
  async function scenario() {
    h = await harness({ accounts: true });
    const world = seedA(h);
    const kept = addAsset(makePng({ width: 5 }), 'b1');
    const r = rig(h);
    const a = await backupNow(r.backup);
    expect(a.ok).toBe(true);
    const stateA = await backedUp(h, r.backup, a.manifest as string);
    h.clock.now += HOUR;
    becomeB(h);
    const later = addAsset(makeJpeg({ width: 9 }), 'b3');
    h.clock.now += MIN;
    return { ...r, ...world, kept, later, manifest: a.manifest as string, stateA, actor: ownerOf(h) };
  }

  const assetFiles = (dir: string) => {
    const out: string[] = [];
    const root = path.join(dir, 'assets');
    if (!fs.existsSync(root)) return out;
    for (const shard of fs.readdirSync(root)) for (const name of fs.readdirSync(path.join(root, shard))) out.push(`${shard}/${name}`);
    return out.sort();
  };

  it('a whole restore brings the images of the backup back, and keeps the later ones aside with the old data', async () => {
    const s = await scenario();
    await s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });
    expect(await s.exited).toBe(75);
    expect(assetFiles(h.dir)).toEqual([`${s.kept.slice(0, 2)}/${s.kept}`]);
    expect(fs.readFileSync(path.join(h.dir, relOf(s.kept))).equals(s.stateA.get(relOf(s.kept))!)).toBe(true);
    expect((await raw<{ hash: string }>(h.dir, 'SELECT hash FROM assets ORDER BY hash')).map((r) => r.hash)).toEqual([s.kept]);
    const aside = fs.readdirSync(h.dir).filter((n) => /^\.pre-restore-\d+$/.test(n));
    expect(aside).toHaveLength(1);
    expect(fs.existsSync(path.join(h.dir, aside[0], relOf(s.later)))).toBe(true);
  });

  it('a backup without images (made before them) leaves the workspace with none, and the old ones aside', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const r = rig(h);
    const a = await backupNow(r.backup);
    h.clock.now += HOUR;
    becomeB(h);
    const later = addAsset(makePng({ width: 7 }), 'b3');
    await r.restore.restoreWorkspace({ manifest: a.manifest as string, confirm: CONFIRM, actor: ownerOf(h) });
    expect(await r.exited).toBe(75);
    expect(fs.existsSync(path.join(h.dir, 'assets'))).toBe(false);
    const aside = fs.readdirSync(h.dir).filter((n) => /^\.pre-restore-\d+$/.test(n));
    expect(fs.existsSync(path.join(h.dir, aside[0], relOf(later)))).toBe(true);
  });

  it('refuses a backup whose image file is not the one its name says, before anything live changes', async () => {
    const s = await scenario();
    const real = await s.backup.readManifest(s.manifest);
    const files = [];
    for (const f of real.files as { path: string; objectId: string }[]) files.push({ path: f.path, data: Buffer.from(await s.backup.readObject(f.objectId)) });
    const bad = files.map((f) => (f.path === relOf(s.kept) ? { ...f, data: Buffer.from('not the picture') } : f));
    const forged = forge(h, bad, { at: T0 + 3 * HOUR });
    const before = fs.readdirSync(h.dir).sort();
    const err = await s.restore.restoreWorkspace({ manifest: forged.name, confirm: CONFIRM, actor: s.actor }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect((err as RestoreError).code).toBe('invalid_backup');
    expect(fs.readdirSync(h.dir).filter((n) => !n.startsWith('.restore-')).sort()).toEqual(before.filter((n) => !n.startsWith('.restore-')));
    expect(assetFiles(h.dir)).toContain(`${s.later.slice(0, 2)}/${s.later}`);
  });

  it('a board copy brings its images: files from the backup, rows for the new board', async () => {
    const s = await scenario();
    fs.rmSync(path.join(h.dir, 'assets', s.kept.slice(0, 2)), { recursive: true, force: true }); // gone from the live store
    const result = await s.restore.restoreBoardCopy({ manifest: s.manifest, boardId: 'b1', actor: s.actor });
    expect(fs.readFileSync(path.join(h.dir, relOf(s.kept))).equals(s.stateA.get(relOf(s.kept))!)).toBe(true);
    const rows = h.directory!.listBoardAssets(result.boardId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ boardId: result.boardId, hash: s.kept, mime: 'image/png', createdBy: s.actor.id });
    expect(h.directory!.listBoardAssets('b1')).toHaveLength(1); // the live board keeps its own row
  });

  it('a board copy does not rewrite a file the live store already has, and a picture the backup lacks does not stop the copy', async () => {
    const s = await scenario();
    const live = path.join(h.dir, relOf(s.kept));
    const stat = fs.statSync(live);
    // a row in the backup's database for a file the backup does not hold
    const hash = sha(Buffer.from('absent'));
    h.directory!.putAsset({ boardId: 'b1', hash, mime: 'image/png', bytes: 6, width: 1, height: 1, createdBy: null, createdAt: T0 });
    const second = await backupNow(s.backup);
    expect(second.ok).toBe(true);
    const result = await s.restore.restoreBoardCopy({ manifest: second.manifest as string, boardId: 'b1', actor: s.actor });
    expect(fs.statSync(live).mtimeMs).toBe(stat.mtimeMs);
    expect(h.directory!.listBoardAssets(result.boardId).map((r: { hash: string }) => r.hash)).toEqual([s.kept]);
  });

  it('a board copy from a backup with no images table still works', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const r = rig(h);
    const a = await backupNow(r.backup);
    const result = await r.restore.restoreBoardCopy({ manifest: a.manifest as string, boardId: 'b1', actor: ownerOf(h) });
    expect(h.directory!.listBoardAssets(result.boardId)).toEqual([]);
  });
});
