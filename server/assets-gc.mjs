// Garbage collection of image files (docs/images.md, History and garbage collection): mark and sweep.
//
// An image row (board, hash) is kept while ANY reference to its hash exists in that board's live room or in one of its
// retained versions: undo, restore and history all need the bytes, and deleting an image object deletes nothing. A row
// that nothing references, and that is older than the grace period (so a picture whose object has not synced yet
// survives), is removed; a file with no row left is removed with it. Anything that cannot be read leaves its board alone:
// the collector deletes only what it has positively seen to be unreferenced.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as Y from 'yjs';
import { HASH_RE } from './assets.mjs';

export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The image hashes a room document refers to: the `asset` of every object of type `image`. */
export function hashesIn(update) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    const found = new Set();
    doc.getMap('objects').forEach((o) => {
      if (!(o instanceof Y.Map) || o.get('type') !== 'image') return;
      const asset = o.get('asset');
      if (typeof asset === 'string' && HASH_RE.test(asset)) found.add(asset);
    });
    return found;
  } finally {
    doc.destroy();
  }
}

/**
 * @param {object} deps
 * @param {{ listAssetBoards(): string[], listBoardAssets(b: string): any[], deleteAsset(b: string, h: string): void, assetBoards(h: string): string[] }} deps.index
 * @param {(hash: string) => string} deps.pathOf where the file of a hash lives
 * @param {string} deps.assetsDir the folder of the shards
 * @param {string} deps.dataDir
 * @param {(boardId: string) => Uint8Array | null} deps.readLive the board's room as it is now (open or saved), or null when there is none
 * @param {() => number} [deps.now]
 * @param {number} [deps.graceMs]
 * @param {(message: string) => void} [deps.log]
 * @param {(summary: { rows: number, bytes: number, files: number, boards: number }) => void} [deps.onDone]
 */
export function createAssetGc({ index, pathOf, assetsDir, dataDir, readLive, now = Date.now, graceMs = GRACE_MS, log = () => undefined, onDone = () => undefined }) {
  /** Hashes referenced by the versions of a board, or null when one cannot be read (then the board is left alone). */
  function versionHashes(boardId) {
    const dir = path.join(dataDir, 'history', boardId);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.yjs.gz'));
    } catch (err) {
      if (err?.code === 'ENOENT') return new Set();
      return null;
    }
    const all = new Set();
    for (const f of files) {
      try {
        for (const h of hashesIn(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))))) all.add(h);
      } catch {
        return null;
      }
    }
    return all;
  }

  function run() {
    const t = now();
    const summary = { rows: 0, bytes: 0, files: 0, boards: 0 };
    const dropped = new Set();
    for (const boardId of index.listAssetBoards()) {
      if (!BOARD_ID_RE.test(boardId)) continue;
      const rows = index.listBoardAssets(boardId);
      const old = rows.filter((r) => t - r.createdAt > graceMs);
      if (!old.length) continue;
      let live;
      try {
        const bytes = readLive(boardId);
        live = bytes ? hashesIn(bytes) : new Set();
      } catch (err) {
        log(`asset gc: room ${boardId} could not be read (${err?.message ?? err}); its images are kept`);
        continue;
      }
      const kept = versionHashes(boardId);
      if (!kept) {
        log(`asset gc: a version of board ${boardId} could not be read; its images are kept`);
        continue;
      }
      let removed = 0;
      for (const r of old) {
        if (live.has(r.hash) || kept.has(r.hash)) continue;
        index.deleteAsset(boardId, r.hash);
        dropped.add(r.hash);
        summary.rows++;
        summary.bytes += r.bytes;
        removed++;
      }
      if (removed) summary.boards++;
    }
    // files nobody has a row for any more: the ones just released, and strays from a crash (past the grace period)
    for (const hash of dropped) summary.files += removeIfUnused(hash, 0);
    summary.files += sweepStrays();
    if (summary.rows || summary.files) log(`asset gc: removed ${summary.rows} unused image row${summary.rows === 1 ? '' : 's'} (${summary.bytes} bytes) and ${summary.files} file${summary.files === 1 ? '' : 's'}`);
    onDone(summary);
    return summary;
  }

  function removeIfUnused(hash, minAgeMs) {
    if (!HASH_RE.test(hash) || index.assetBoards(hash).length) return 0;
    const file = pathOf(hash);
    try {
      if (minAgeMs && now() - fs.statSync(file).mtimeMs <= minAgeMs) return 0;
      fs.unlinkSync(file);
      return 1;
    } catch {
      return 0;
    }
  }

  function sweepStrays() {
    let n = 0;
    let shards = [];
    try {
      shards = fs.readdirSync(assetsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name));
    } catch {
      return 0;
    }
    for (const shard of shards) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(assetsDir, shard.name));
      } catch {
        continue;
      }
      for (const name of names) {
        if (HASH_RE.test(name) && name.startsWith(shard.name)) n += removeIfUnused(name, graceMs);
      }
    }
    return n;
  }

  return { run };
}
