// The asset store behind images on a board (docs/images.md). Bytes live in files named by the SHA-256 of what is stored,
// under <DATA_DIR>/assets/<aa>/<hash>; what a board may read, and how much it has used, lives in an index of rows
// (board id, hash, type, size). A hash is only ever readable through a board that owns a row for it.
//
// The index has two forms with one interface: a table of the directory database (accounts mode) and a small JSON file
// (open mode, which has no database). Everything in this file is synchronous apart from the file system calls.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_TYPES, readImageInfo, sizeOk, sniffType } from './image-header.mjs';
import { ImageError, stripImage } from './image-strip.mjs';

export const HASH_RE = /^[0-9a-f]{64}$/;
export const MB = 1024 * 1024;

export class AssetError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const ASSETS_MIGRATION = `
  CREATE TABLE assets (
    board_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, hash)
  );
  CREATE INDEX assets_hash ON assets(hash);
`;

const toRow = (r) => ({ boardId: r.board_id, hash: r.hash, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height, createdBy: r.created_by ?? null, createdAt: r.created_at });

/** The index in the directory database. `get`, `all` and `run` are the directory's statement helpers. */
export function createAssetIndex({ get, all, run }) {
  return {
    getAsset: (boardId, hash) => {
      const r = get('SELECT * FROM assets WHERE board_id = ? AND hash = ?', boardId, hash);
      return r ? toRow(r) : null;
    },
    putAsset: (row) => {
      run('INSERT OR IGNORE INTO assets (board_id, hash, mime, bytes, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        row.boardId, row.hash, row.mime, row.bytes, row.width, row.height, row.createdBy, row.createdAt);
    },
    boardAssetBytes: (boardId) => Number(get('SELECT COALESCE(SUM(bytes), 0) AS n FROM assets WHERE board_id = ?', boardId).n),
    assetsTotalBytes: () => Number(get('SELECT COALESCE(SUM(bytes), 0) AS n FROM (SELECT DISTINCT hash, bytes FROM assets)').n),
    assetBoards: (hash) => all('SELECT board_id FROM assets WHERE hash = ?', hash).map((r) => r.board_id),
    listBoardAssets: (boardId) => all('SELECT * FROM assets WHERE board_id = ?', boardId).map(toRow),
  };
}

/** The index of open mode: one JSON file, held in memory, rewritten whole through a temporary file on every new row. */
export function createJsonAssetIndex(dir) {
  const file = path.join(dir, 'index.json');
  /** @type {Map<string, object>} */
  const rows = new Map();
  try {
    for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) rows.set(`${r.boardId}:${r.hash}`, r);
  } catch {
    /* no index yet, or an unreadable one: start empty, the files on disk are untouched */
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...rows.values()]));
    fs.renameSync(tmp, file);
  };
  return {
    getAsset: (boardId, hash) => rows.get(`${boardId}:${hash}`) ?? null,
    putAsset: (row) => {
      const key = `${row.boardId}:${row.hash}`;
      if (rows.has(key)) return;
      rows.set(key, row);
      save();
    },
    boardAssetBytes: (boardId) => [...rows.values()].reduce((n, r) => n + (r.boardId === boardId ? r.bytes : 0), 0),
    assetsTotalBytes: () => {
      const seen = new Map();
      for (const r of rows.values()) seen.set(r.hash, r.bytes);
      return [...seen.values()].reduce((n, b) => n + b, 0);
    },
    assetBoards: (hash) => [...rows.values()].filter((r) => r.hash === hash).map((r) => r.boardId),
    listBoardAssets: (boardId) => [...rows.values()].filter((r) => r.boardId === boardId),
  };
}

/** `{ maxBytes, boardQuota, totalQuota }` as the store reads them; totalQuota 0 means none. */
export function createAssetStore({ dir, index, limits, now = Date.now }) {
  const pathOf = (hash) => path.join(dir, hash.slice(0, 2), hash);

  function checkType(declared, bytes) {
    const type = String(declared ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) throw new AssetError(400, 'unsupported_type', 'Only PNG, JPEG, GIF and WebP images are supported');
    const sniffed = sniffType(bytes);
    if (sniffed !== type) throw new AssetError(400, 'bad_image', 'The file is not the kind of image it says it is');
    return type;
  }

  function writeFileOnce(hash, bytes) {
    const file = pathOf(hash);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpDir = path.join(dir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${crypto.randomBytes(12).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  return {
    dir,
    limits,
    pathOf,

    /**
     * Validates, strips and stores an upload for a board. Returns `{ row, created }`: created is false when the board
     * already had this content. Throws AssetError for everything the caller did wrong.
     */
    put({ boardId, bytes, declaredType, userId = /** @type {string | null} */ (null) }) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new AssetError(400, 'bad_image', 'The upload is empty');
      if (bytes.length > limits.maxBytes) throw new AssetError(413, 'payload_too_large', 'The image is too large');
      const type = checkType(declaredType, bytes);
      const before = readImageInfo(bytes, type);
      if (!before) throw new AssetError(400, 'bad_image', 'The image could not be read');
      if (!sizeOk(before.width, before.height)) throw new AssetError(413, 'too_many_pixels', 'The image has too many pixels');
      let clean;
      try {
        clean = stripImage(bytes, type);
      } catch (err) {
        if (err instanceof ImageError) throw new AssetError(400, 'bad_image', 'The image could not be read');
        throw err;
      }
      const info = readImageInfo(clean, type);
      if (!info || info.width !== before.width || info.height !== before.height) throw new AssetError(400, 'bad_image', 'The image could not be read');
      const hash = crypto.createHash('sha256').update(clean).digest('hex');
      const existing = index.getAsset(boardId, hash);
      if (existing) return { row: existing, created: false };
      const used = index.boardAssetBytes(boardId);
      if (used + clean.length > limits.boardQuota) throw new AssetError(402, 'storage_full', 'This board has used its image storage. Remove images you no longer need, or ask your administrator.');
      if (limits.totalQuota > 0 && index.assetsTotalBytes() + clean.length > limits.totalQuota) throw new AssetError(402, 'storage_full', 'This server has used its image storage. Ask your administrator.');
      writeFileOnce(hash, clean);
      const row = { boardId, hash, mime: type, bytes: clean.length, width: info.width, height: info.height, createdBy: userId, createdAt: now() };
      index.putAsset(row);
      return { row, created: true };
    },

    /**
     * Gives `boardId` a row for content another board owns, without any bytes moving. `mayReadFrom(otherBoardId)` says
     * whether the caller can read that other board. Returns the row, or null when there is nothing the caller may claim.
     */
    claim({ boardId, hash, mayReadFrom, userId = /** @type {string | null} */ (null) }) {
      if (!HASH_RE.test(hash)) return null;
      const own = index.getAsset(boardId, hash);
      if (own) return { row: own, created: false };
      const source = index.assetBoards(hash).filter((id) => id !== boardId).find((id) => mayReadFrom(id));
      if (source === undefined) return null;
      const from = index.getAsset(source, hash);
      if (!from || !fs.existsSync(pathOf(hash))) return null;
      if (index.boardAssetBytes(boardId) + from.bytes > limits.boardQuota) throw new AssetError(402, 'storage_full', 'This board has used its image storage. Remove images you no longer need, or ask your administrator.');
      const row = { ...from, boardId, createdBy: userId, createdAt: now() };
      index.putAsset(row);
      return { row, created: true };
    },

    /** The row and the bytes of an asset a board owns, or null. A hash that exists only for other boards is null too. */
    read(boardId, hash) {
      if (!HASH_RE.test(hash)) return null;
      const row = index.getAsset(boardId, hash);
      if (!row) return null;
      try {
        return { row, bytes: fs.readFileSync(pathOf(hash)) };
      } catch {
        return null;
      }
    },

    stat(boardId, hash) {
      if (!HASH_RE.test(hash)) return null;
      return index.getAsset(boardId, hash);
    },

    boardBytes: (boardId) => index.boardAssetBytes(boardId),
  };
}

// ---------------------------------------------------------------- rate limit

/** At most `perMinute` uploads and `bytesPerMinute` bytes per key in any fixed minute. In memory, like the sign-in limiter. */
export function createUploadLimiter({ perMinute = 60, bytesPerMinute = 20 * MB, now = Date.now } = {}) {
  const windows = new Map();
  return {
    /** Counts the upload; returns false when it is over a limit (and then counts nothing). */
    take(key, bytes) {
      const t = now();
      const minute = Math.floor(t / 60_000);
      if (windows.size > 5000) {
        for (const [k, w] of windows) if (w.minute !== minute) windows.delete(k);
      }
      let w = windows.get(key);
      if (!w || w.minute !== minute) {
        w = { minute, count: 0, bytes: 0 };
        windows.set(key, w);
      }
      if (w.count + 1 > perMinute || w.bytes + bytes > bytesPerMinute) return false;
      w.count += 1;
      w.bytes += bytes;
      return true;
    },
  };
}

// ---------------------------------------------------------------- responses

/** Headers of an asset response (docs/images.md, Security 2). The type is the stored one; the name is never the upload's. */
export function assetHeaders(row) {
  return {
    'content-type': row.mime,
    'content-length': row.bytes,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'content-disposition': 'inline; filename="image"',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, max-age=31536000, immutable',
    etag: `"${row.hash}"`,
  };
}

/** Reads a request body of at most `limit` bytes. Rejects at once on a declared length over the limit and stops buffering
 * when a body without one goes over it; the caller answers 413 and closes the connection. */
export function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const tooLarge = () => new AssetError(413, 'payload_too_large', 'The image is too large');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      done(reject, tooLarge());
      return;
    }
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        done(reject, tooLarge());
      } else if (!settled) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks)));
    req.on('error', (err) => done(reject, err));
    req.on('close', () => done(reject, new AssetError(400, 'bad_request', 'The request was aborted')));
  });
}
