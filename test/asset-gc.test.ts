import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as Y from 'yjs';
import { DatabaseSync } from 'node:sqlite';
import { ASSETS_MIGRATION, createAssetIndex, createAssetStore, createJsonAssetIndex } from '../server/assets.mjs';
import { GRACE_MS, createAssetGc, hashesIn } from '../server/assets-gc.mjs';
import { makeGif, makePng } from './image-fixtures';

// docs/images.md, History and garbage collection: an image file is kept while a live room or a retained version of the
// board that owns it refers to it, and a row is never removed before its grace period is over.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let dir: string;
let clock: { now: number };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-gc-'));
  clock = { now: NOW };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A room document with an image object per hash (and whatever else the test puts in). */
function room(hashes: string[], extra: (objects: Y.Map<Y.Map<unknown>>) => void = () => undefined): Uint8Array {
  const doc = new Y.Doc();
  const objects = doc.getMap<Y.Map<unknown>>('objects');
  hashes.forEach((asset, i) => objects.set(`i${i}`, new Y.Map(Object.entries({ id: `i${i}`, type: 'image', asset, mime: 'image/png', nw: 1, nh: 1, x: 0, y: 0, w: 1, h: 1 }))));
  extra(objects);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}
const writeVersion = (board: string, id: string, bytes: Uint8Array) => {
  fs.mkdirSync(path.join(dir, 'history', board), { recursive: true });
  fs.writeFileSync(path.join(dir, 'history', board, `${id}.yjs.gz`), zlib.gzipSync(bytes));
};

function setup(kind: 'sqlite' | 'json' = 'sqlite') {
  const assetsDir = path.join(dir, 'assets');
  const db = new DatabaseSync(':memory:');
  db.exec(ASSETS_MIGRATION);
  const index = kind === 'sqlite'
    ? createAssetIndex({
      get: (sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as never[])) as never,
      all: (sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as never[])) as never,
      run: (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as never[])) as never,
    })
    : createJsonAssetIndex(assetsDir);
  const store = createAssetStore({ dir: assetsDir, index, limits: { maxBytes: 1e7, boardQuota: 1e9, totalQuota: 0 }, now: () => clock.now });
  const rooms = new Map<string, Uint8Array | null | Error>();
  const log = vi.fn<(message: string) => void>();
  const gc = createAssetGc({
    index, pathOf: store.pathOf, assetsDir, dataDir: dir, now: () => clock.now, log,
    readLive: (id: string) => {
      const r = rooms.get(id);
      if (r instanceof Error) throw r;
      return r ?? null;
    },
  });
  /** An image uploaded to `board` `ageDays` ago. */
  const add = (board: string, bytes: Buffer, ageDays = 10, type = 'image/png') => {
    const before = clock.now;
    clock.now = NOW - ageDays * DAY;
    const { row } = store.put({ boardId: board, bytes, declaredType: type });
    clock.now = before;
    return row.hash;
  };
  return { index, store, rooms, gc, add, log, file: (hash: string) => store.pathOf(hash) };
}

describe.each(['sqlite', 'json'] as const)('collecting over the %s index', (kind) => {
  it('keeps what the live room shows and removes what nothing shows, with the file', () => {
    const s = setup(kind);
    const keep = s.add('b1', makePng({ width: 5 }));
    const drop = s.add('b1', makePng({ width: 6 }));
    s.rooms.set('b1', room([keep]));
    const summary = s.gc.run();
    expect(summary).toMatchObject({ rows: 1, files: 1, boards: 1 });
    expect(summary.bytes).toBeGreaterThan(0);
    expect(s.store.stat('b1', keep)).not.toBeNull();
    expect(s.store.stat('b1', drop)).toBeNull();
    expect(fs.existsSync(s.file(keep))).toBe(true);
    expect(fs.existsSync(s.file(drop))).toBe(false);
  });

  it('keeps a row younger than the grace period even when nothing refers to it yet', () => {
    const s = setup(kind);
    const fresh = s.add('b1', makePng({ width: 5 }), 1);
    const edge = s.add('b1', makePng({ width: 6 }), GRACE_MS / DAY - 0.01);
    s.rooms.set('b1', room([]));
    expect(s.gc.run()).toMatchObject({ rows: 0, files: 0 });
    expect(s.store.stat('b1', fresh)).not.toBeNull();
    expect(s.store.stat('b1', edge)).not.toBeNull();
    clock.now += 7 * DAY;
    expect(s.gc.run().rows).toBe(2);
  });

  it('keeps an image a retained version still shows, and lets go when the versions are gone', () => {
    const s = setup(kind);
    const old = s.add('b1', makePng({ width: 5 }));
    const gone = s.add('b1', makePng({ width: 6 }));
    s.rooms.set('b1', room([]));
    writeVersion('b1', 'AAAAAAAAAAAAAAAA', room([old]));
    expect(s.gc.run().rows).toBe(1);
    expect(s.store.stat('b1', old)).not.toBeNull();
    expect(s.store.stat('b1', gone)).toBeNull();
    fs.rmSync(path.join(dir, 'history'), { recursive: true });
    expect(s.gc.run().rows).toBe(1);
    expect(s.store.stat('b1', old)).toBeNull();
  });

  it('finds the image again after a restore of a version: undo and history needed the bytes', () => {
    const s = setup(kind);
    const h = s.add('b1', makePng({ width: 5 }));
    s.rooms.set('b1', room([h]));
    writeVersion('b1', 'AAAAAAAAAAAAAAAA', room([h]));
    s.rooms.set('b1', room([])); // the picture was deleted from the board
    s.gc.run();
    expect(s.store.read('b1', h)).not.toBeNull();
    s.rooms.set('b1', room([h])); // restored from the version
    s.gc.run();
    expect(s.store.read('b1', h)?.bytes.length).toBeGreaterThan(0);
  });

  it('keeps the file while another board still has a row for it', () => {
    const s = setup(kind);
    const bytes = makeGif();
    const hash = s.add('b1', bytes, 10, 'image/gif');
    s.add('b2', bytes, 10, 'image/gif');
    s.rooms.set('b1', room([]));
    s.rooms.set('b2', room([hash]));
    expect(s.gc.run()).toMatchObject({ rows: 1, files: 0 });
    expect(s.store.stat('b1', hash)).toBeNull();
    expect(fs.existsSync(s.file(hash))).toBe(true);
    s.rooms.set('b2', room([]));
    expect(s.gc.run()).toMatchObject({ rows: 1, files: 1 });
    expect(fs.existsSync(s.file(hash))).toBe(false);
  });

  it('leaves a board alone when its room or a version cannot be read', () => {
    const s = setup(kind);
    const a = s.add('b1', makePng({ width: 5 }));
    const b = s.add('b2', makePng({ width: 6 }));
    s.rooms.set('b1', new Error('disk'));
    s.rooms.set('b2', room([]));
    fs.mkdirSync(path.join(dir, 'history', 'b2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'history', 'b2', 'BBBBBBBBBBBBBBBB.yjs.gz'), 'not gzip at all');
    expect(s.gc.run()).toMatchObject({ rows: 0, files: 0 });
    expect(s.store.stat('b1', a)).not.toBeNull();
    expect(s.store.stat('b2', b)).not.toBeNull();
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('its images are kept'));
  });

  it('removes an old row of a board that has no room at all', () => {
    const s = setup(kind);
    const h = s.add('ghost', makePng({ width: 5 }));
    expect(s.gc.run().rows).toBe(1);
    expect(s.store.stat('ghost', h)).toBeNull();
  });

  it('removes a stray file with no row once it is older than the grace period, and touches nothing else', () => {
    const s = setup(kind);
    const bytes = makePng({ width: 9 });
    const hash = sha(bytes);
    const stray = s.file(hash);
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, bytes);
    const tmp = path.join(dir, 'assets', 'tmp', 'x.tmp');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, 'half');
    const other = path.join(dir, 'assets', hash.slice(0, 2), 'notes.txt');
    fs.writeFileSync(other, 'keep me');
    expect(s.gc.run().files).toBe(0); // brand new: it may be a file whose row is being written
    const old = (NOW - 8 * DAY) / 1000;
    fs.utimesSync(stray, old, old);
    expect(s.gc.run().files).toBe(1);
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.existsSync(tmp)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('reports what it did once, and nothing when there was nothing to do', () => {
    const s = setup(kind);
    expect(s.gc.run()).toEqual({ rows: 0, bytes: 0, files: 0, boards: 0 });
    s.add('b1', makePng({ width: 5 }));
    expect(s.gc.run().rows).toBe(1);
    expect(s.log).toHaveBeenCalledWith(expect.stringMatching(/removed 1 unused image row \(\d+ bytes\) and 1 file/));
    expect(s.gc.run().rows).toBe(0);
  });
});

describe('hashesIn', () => {
  it('reads the hash of every image object and nothing else', () => {
    const good = 'ab'.repeat(32);
    const bytes = room([good, 'pending:abc', '../../x', 'AB'.repeat(32)], (objects) => {
      objects.set('s', new Y.Map(Object.entries({ id: 's', type: 'sticky', asset: 'cd'.repeat(32) })));
      objects.set('c', new Y.Map(Object.entries({ id: 'c', type: 'image', asset: 7 })));
    });
    expect([...hashesIn(bytes)]).toEqual([good]);
  });

  it('refuses a document it cannot read', () => {
    expect(() => hashesIn(Buffer.from('garbage'))).toThrow(/.+/);
  });
});
