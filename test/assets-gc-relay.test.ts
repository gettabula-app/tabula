import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDirectory } from '../server/directory.mjs';
import { createHarness, type Account } from './mcp-harness';
import { makePng } from './image-fixtures';

// docs/images.md, History and garbage collection, in a running relay: a few moments after start it removes the images no
// board shows any more (after their grace period) and writes one audit row.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const DAY = 24 * 60 * 60 * 1000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-relay-'));
const png = (width: number) => makePng({ width });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const rel = (hash: string) => path.join('assets', hash.slice(0, 2), hash);
const unused = png(5);
const young = png(6);
const shown = png(7);
const unreadable = png(8);
const corrupt = png(9);

const h = createHarness({ accounts: true, dir, env: { TABULA_TEST_ASSET_GC_DELAY_MS: '300' } });
let owner: Account;
const until = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  // a workspace on disk before the relay starts: three images of a board that has no room, one of them recent,
  // and one that a saved room shows
  const d = openDirectory(path.join(dir, 'directory.sqlite'));
  const row = (board: string, bytes: Buffer, age: number) => {
    const hash = sha(bytes);
    fs.mkdirSync(path.join(dir, 'assets', hash.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel(hash)), bytes);
    d.putAsset({ boardId: board, hash, mime: 'image/png', bytes: bytes.length, width: 7, height: 3, createdBy: null, createdAt: Date.now() - age });
  };
  row('ghost', unused, 10 * DAY);
  row('ghost', young, 1 * DAY);
  row('kept', shown, 10 * DAY);
  row('unreadable', unreadable, 10 * DAY);
  row('corrupt', corrupt, 10 * DAY);
  d.close();
  fs.mkdirSync(path.join(dir, 'unreadable.yjs'));
  fs.writeFileSync(path.join(dir, 'corrupt.yjs'), 'damaged room bytes');
  const Y = await import('yjs');
  const doc = new Y.Doc();
  doc.getMap('objects').set('i', new Y.Map(Object.entries({ id: 'i', type: 'image', asset: sha(shown), mime: 'image/png', nw: 7, nh: 3, x: 0, y: 0, w: 1, h: 1 })));
  fs.writeFileSync(path.join(dir, 'kept.yjs'), Y.encodeStateAsUpdate(doc));
  await h.start();
  owner = await h.signInOwner();
});
afterAll(() => h.cleanup());

describe('the collector in the relay', () => {
  it('removes an unreferenced old image and keeps a recent one and one a room shows', async () => {
    await until(() => !fs.existsSync(path.join(dir, rel(sha(unused)))));
    expect(fs.existsSync(path.join(dir, rel(sha(young))))).toBe(true);
    expect(fs.existsSync(path.join(dir, rel(sha(shown))))).toBe(true);
  });

  it('writes one audit row with the counts, which reads as a sentence', async () => {
    const rows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=200&action=assets.gc')).body.entries as { action: string; detail: Record<string, number> }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ rows: 1, files: 1 });
    expect(rows[0].detail.bytes).toBe(unused.length);
  });

  it('keeps images when the saved room cannot be read or decoded', async () => {
    await until(() => !fs.existsSync(path.join(dir, rel(sha(unused)))));
    expect((await h.api(owner.cookie, 'GET', '/api/me')).status).toBe(200);
    expect(fs.existsSync(path.join(dir, rel(sha(unreadable))))).toBe(true);
    expect(fs.existsSync(path.join(dir, rel(sha(corrupt))))).toBe(true);
  });
});
