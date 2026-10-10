// Version history of boards (docs/history.md): full-state snapshots of a board room, kept next to the room files as
//   <DATA_DIR>/history/<boardId>/index.json  and  <DATA_DIR>/history/<boardId>/<versionId>.yjs.gz
// The relay calls onSave() whenever it saves a board room. The accounts API gets routes(); open mode gets handleOpen().
// Everything is synchronous, like Room.save() itself, so snapshots cannot race and shutdown cannot lose one.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { renameSyncRetry } from './fs-retry.mjs';
import { csrfOk as sharedCsrfOk } from './auth.mjs';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const LIMITS = {
  /** Automatic versions are at least this far apart. */
  intervalMs: 10 * MINUTE_MS,
  /** A version written because everyone left is at least this far after the newest one. */
  idleGapMs: MINUTE_MS,
  /** Automatic versions: all kept up to this age, then the newest per hour up to hourlyMs, then the newest per day up to keepMs. */
  denseMs: DAY_MS,
  hourlyMs: 7 * DAY_MS,
  keepMs: 30 * DAY_MS,
  /** Stored bytes of all versions that are not named, per board. */
  budgetBytes: 64 * 1024 * 1024,
  maxNamed: 100,
  /** begin-restore waits this long for the restoring client's edit to be saved. */
  restorePendingMs: 2 * MINUTE_MS,
  /** The previous state is kept as a version when the objects drop by this many and to this share or less. */
  bigDrop: 10,
  bigDropRatio: 0.7,
  /** Version files that no index entry names are removed after this long. */
  orphanMs: HOUR_MS,
  sweepMs: HOUR_MS,
};

const MAX_LABEL = 80;
const MAX_BY = 40;
const MAX_BODY = 64 * 1024;
const MAX_CACHED_INDEXES = 64;
const KINDS = ['auto', 'named', 'pre-restore', 'restore'];
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const OPEN_PATH_RE = /^\/api\/boards\/([A-Za-z0-9_-]{1,64})\/versions(?:\/([A-Za-z0-9_-]{16})(?:\/(state|begin-restore))?)?$/;
const CONTROL_RE = /\p{Cc}/u;

export class HistoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HistoryError';
    this.status = status;
    this.code = code;
  }
}

const bad = (message) => new HistoryError(400, 'bad_request', message);
const missing = (message = 'Version not found') => new HistoryError(404, 'not_found', message);

function cleanLabel(value) {
  if (typeof value !== 'string') throw bad('label must be a string');
  const label = value.trim();
  if (label.length < 1 || label.length > MAX_LABEL || CONTROL_RE.test(label)) {
    throw bad(`label must be 1 to ${MAX_LABEL} characters, without control characters`);
  }
  return label;
}

// Open mode only: the name a client gives itself. Anything unusable is ignored rather than refused.
function cleanBy(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= MAX_BY && !CONTROL_RE.test(name) ? name : null;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function countObjects(bytes) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    return doc.getMap('objects').size;
  } finally {
    doc.destroy();
  }
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !VERSION_ID_RE.test(e.id)) return null;
  if (!Number.isFinite(e.createdAt) || !KINDS.includes(e.kind) || typeof e.hash !== 'string') return null;
  const text = (v) => (typeof v === 'string' ? v : null);
  const num = (v) => (Number.isFinite(v) ? v : 0);
  return {
    id: e.id,
    createdAt: e.createdAt,
    kind: e.kind,
    label: text(e.label),
    by: text(e.by),
    byName: text(e.byName),
    objects: num(e.objects),
    bytes: num(e.bytes),
    hash: e.hash,
    from: text(e.from),
  };
}

const view = (e) => ({
  id: e.id,
  createdAt: e.createdAt,
  kind: e.kind,
  label: e.label,
  by: e.by,
  byName: e.byName,
  objects: e.objects,
  bytes: e.bytes,
  from: e.from,
});

/**
 * Which versions a board keeps. `entries` are oldest first; returns the ids to delete. The newest version is never
 * deleted, and named versions never are.
 */
export function pruneIds(entries, t, limits = LIMITS) {
  const drop = new Set();
  const newest = entries[entries.length - 1];
  const buckets = new Map();
  for (const e of entries) {
    if (e.kind === 'named') continue;
    const age = t - e.createdAt;
    if (age > limits.keepMs) {
      drop.add(e.id);
      continue;
    }
    if (e.kind !== 'auto') continue;
    let key = null;
    if (age > limits.hourlyMs) key = `d${Math.floor(e.createdAt / DAY_MS)}`;
    else if (age > limits.denseMs) key = `h${Math.floor(e.createdAt / HOUR_MS)}`;
    if (key === null) continue;
    const earlier = buckets.get(key);
    if (earlier) drop.add(earlier.id);
    buckets.set(key, e);
  }
  if (newest) drop.delete(newest.id);

  let total = 0;
  for (const e of entries) if (e.kind !== 'named' && !drop.has(e.id)) total += e.bytes;
  if (total > limits.budgetBytes) {
    const candidates = entries.filter((e) => e.kind !== 'named' && !drop.has(e.id) && e !== newest);
    const order = [...candidates.filter((e) => e.kind === 'auto'), ...candidates.filter((e) => e.kind !== 'auto')];
    for (const e of order) {
      if (total <= limits.budgetBytes) break;
      drop.add(e.id);
      total -= e.bytes;
    }
  }
  return drop;
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(boardId: string) => Uint8Array | null} options.boardState current state of a board room (live room, else its file)
 * @param {() => number} [options.now]
 * @param {(...args: unknown[]) => void} [options.log]
 * @param {(req: import('node:http').IncomingMessage) => boolean} [options.csrfOk]
 * @param {number} [options.sweepMs] 0 turns the periodic sweep off (the first sweep still runs at start)
 * @param {Partial<typeof LIMITS>} [options.limits]
 */
export function createHistory({ dataDir, boardState, now = Date.now, log = console.error, csrfOk = sharedCsrfOk, sweepMs = LIMITS.sweepMs, limits: overrides = {} }) {
  const limits = { ...LIMITS, ...overrides };
  const root = path.join(dataDir, 'history');
  const dirOf = (boardId) => {
    if (typeof boardId !== 'string' || !BOARD_ID_RE.test(boardId)) throw bad('Not a board id');
    return path.join(root, boardId);
  };
  const blobOf = (boardId, id) => path.join(dirOf(boardId), `${id}.yjs.gz`);

  /** @type {Map<string, ReturnType<typeof cleanEntry>[]>} */
  const cache = new Map();
  /** boardId -> a restore that began and whose edit has not been saved yet */
  const pending = new Map();

  // ------------------------------------------------------------ files

  function writeAtomic(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    renameSyncRetry(tmp, file);
  }

  function remember(boardId, entries) {
    cache.delete(boardId);
    cache.set(boardId, entries);
    if (cache.size > MAX_CACHED_INDEXES) cache.delete(cache.keys().next().value);
  }

  function readIndex(boardId) {
    const hit = cache.get(boardId);
    if (hit) {
      remember(boardId, hit);
      return hit;
    }
    const file = path.join(dirOf(boardId), 'index.json');
    let entries = [];
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') log(`history ${boardId}: could not read the index`, err?.message);
    }
    if (raw !== null) {
      try {
        const data = JSON.parse(raw);
        if (data?.v !== 1 || !Array.isArray(data.versions)) throw new Error('unexpected content');
        entries = data.versions.map(cleanEntry).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
      } catch (err) {
        log(`history ${boardId}: the index is unreadable and was set aside`, err?.message);
        try {
          fs.renameSync(file, `${file}.corrupt-${now()}`);
        } catch {
          /* leave it */
        }
        entries = [];
      }
    }
    remember(boardId, entries);
    return entries;
  }

  function writeIndex(boardId, entries) {
    fs.mkdirSync(dirOf(boardId), { recursive: true });
    writeAtomic(path.join(dirOf(boardId), 'index.json'), JSON.stringify({ v: 1, versions: entries }));
    remember(boardId, entries);
  }

  // The index entry goes first, the file after it: a crash leaves an orphan file, never an entry without one.
  function applyPrune(boardId, entries, t) {
    const drop = pruneIds(entries, t, limits);
    if (drop.size === 0) return entries;
    const keep = entries.filter((e) => !drop.has(e.id));
    writeIndex(boardId, keep);
    for (const id of drop) {
      try {
        fs.unlinkSync(blobOf(boardId, id));
      } catch {
        /* already gone */
      }
    }
    return keep;
  }

  function addVersion(boardId, { kind, label = null, by = null, byName = null, from = null, bytes, objects, hash }) {
    const entries = readIndex(boardId);
    const t = Math.max(now(), entries.length ? entries[entries.length - 1].createdAt : 0);
    const gz = zlib.gzipSync(bytes);
    const id = crypto.randomBytes(12).toString('base64url');
    fs.mkdirSync(dirOf(boardId), { recursive: true });
    writeAtomic(blobOf(boardId, id), gz);
    const entry = { id, createdAt: t, kind, label, by, byName, objects, bytes: gz.length, hash, from };
    const next = [...entries, entry];
    writeIndex(boardId, next);
    applyPrune(boardId, next, t);
    return entry;
  }

  // ------------------------------------------------------------ automatic versions

  /**
   * Called by Room.save() with the bytes it just wrote. `room` is { name, kind, doc, conns }; the previous save
   * is remembered on it (so it is dropped with the room).
   */
  function onSave(room, bytes) {
    if (room.kind !== 'board') return;
    try {
      saveRules(room, bytes);
    } catch (err) {
      log(`history ${room.name}: could not snapshot`, err?.message);
    }
  }

  function saveRules(room, bytes) {
    const boardId = room.name;
    const t = now();
    const objects = room.doc.getMap('objects').size;
    const previous = room.historyPrevious ?? null;
    room.historyPrevious = { bytes, objects };
    const entries = readIndex(boardId);
    const newest = entries[entries.length - 1] ?? null;
    let hash = null;
    const hashOf = () => (hash ??= sha256(bytes));

    // 1. a restore that began: its edit is the next change that gets saved
    const restore = pending.get(boardId);
    if (restore && restore.until <= t) pending.delete(boardId);
    else if (restore && hashOf() !== newest?.hash) {
      pending.delete(boardId);
      addVersion(boardId, { kind: 'restore', from: restore.from, by: restore.by, byName: restore.byName, bytes, objects, hash: hashOf() });
      return;
    }

    // 2. the board as it was just before a large deletion
    if (previous && previous.objects >= limits.bigDrop && objects <= previous.objects - limits.bigDrop && objects <= previous.objects * limits.bigDropRatio) {
      const before = sha256(previous.bytes);
      if (before !== newest?.hash) {
        addVersion(boardId, { kind: 'auto', bytes: previous.bytes, objects: previous.objects, hash: before });
        return;
      }
    }

    // 3. the interval; a board's first version waits for something on it
    if (!newest ? objects > 0 : t - newest.createdAt >= limits.intervalMs) {
      if (hashOf() !== newest?.hash) addVersion(boardId, { kind: 'auto', bytes, objects, hash: hashOf() });
      return;
    }

    // 4. everyone has left
    if (newest && room.conns.size === 0 && t - newest.createdAt >= limits.idleGapMs && hashOf() !== newest.hash) {
      addVersion(boardId, { kind: 'auto', bytes, objects, hash: hashOf() });
    }
  }

  // ------------------------------------------------------------ actions
  // An actor is { id: account id or null, name, owner: may act on every version }.

  const named = (entries) => entries.filter((e) => e.kind === 'named').length;
  const limitError = () => new HistoryError(409, 'limit', `A board keeps at most ${limits.maxNamed} named versions. Delete one first.`);

  function find(boardId, versionId) {
    if (typeof versionId !== 'string' || !VERSION_ID_RE.test(versionId)) throw missing();
    const entry = readIndex(boardId).find((e) => e.id === versionId);
    if (!entry) throw missing();
    return entry;
  }

  const whoOf = (actor, by) => ({ by: actor.id ?? null, byName: actor.id ? (actor.name ?? null) : cleanBy(by ?? actor.name) });

  function current(boardId) {
    const bytes = boardState(boardId);
    if (!bytes || bytes.length === 0) return null;
    return { bytes, hash: sha256(bytes) };
  }

  const actions = {
    list(boardId) {
      return { versions: readIndex(boardId).slice().reverse().map(view) };
    },

    /** The stored (gzipped) state of a version. */
    state(boardId, versionId) {
      const entry = find(boardId, versionId);
      try {
        return fs.readFileSync(blobOf(boardId, entry.id));
      } catch {
        throw missing('This version is no longer available');
      }
    },

    /** A named version of the board as it is now. `created` is false when the newest version already had this content. */
    create(boardId, actor, { label, by } = {}) {
      const text = cleanLabel(label);
      const state = current(boardId);
      if (!state) throw new HistoryError(409, 'empty', 'This board has no saved state yet');
      const entries = readIndex(boardId);
      const newest = entries[entries.length - 1];
      const who = whoOf(actor, by);
      if (named(entries) >= limits.maxNamed) throw limitError();
      if (newest && newest.hash === state.hash && newest.kind !== 'named') {
        Object.assign(newest, { kind: 'named', label: text, ...who });
        writeIndex(boardId, entries);
        return { version: view(newest), created: false };
      }
      const entry = addVersion(boardId, { kind: 'named', label: text, ...who, bytes: state.bytes, objects: countObjects(state.bytes), hash: state.hash });
      return { version: view(entry), created: true };
    },

    /** Names an unnamed version (any editor) or renames a named one (its creator or the owner). */
    rename(boardId, versionId, actor, { label, by } = {}) {
      const entry = find(boardId, versionId);
      const text = cleanLabel(label);
      const entries = readIndex(boardId);
      if (entry.kind === 'named') {
        if (!actor.owner && !(actor.id && actor.id === entry.by)) {
          throw new HistoryError(403, 'forbidden', 'Only the person who named this version or the board owner can rename it');
        }
      } else {
        if (named(entries) >= limits.maxNamed) throw limitError();
        Object.assign(entry, { kind: 'named', ...whoOf(actor, by) });
      }
      entry.label = text;
      writeIndex(boardId, entries);
      return view(entry);
    },

    /** The owner deletes any version; an editor only a named version they created. */
    remove(boardId, versionId, actor) {
      const entry = find(boardId, versionId);
      if (!actor.owner && !(entry.kind === 'named' && actor.id && actor.id === entry.by)) {
        throw new HistoryError(403, 'forbidden', 'Only the board owner can delete this version');
      }
      writeIndex(boardId, readIndex(boardId).filter((e) => e.id !== entry.id));
      try {
        fs.unlinkSync(blobOf(boardId, entry.id));
      } catch {
        /* already gone */
      }
    },

    /** Saves the board as it is now (the durable undo) and expects the restoring client's edit next. Changes nothing else. */
    beginRestore(boardId, versionId, actor, { by } = {}) {
      const target = find(boardId, versionId);
      const who = whoOf(actor, by);
      const state = current(boardId);
      let preRestore = null;
      if (state) {
        const entries = readIndex(boardId);
        const newest = entries[entries.length - 1];
        if (newest && newest.hash === state.hash) {
          if (newest.kind === 'auto') {
            Object.assign(newest, { kind: 'pre-restore', from: target.id, ...who });
            writeIndex(boardId, entries);
          }
          preRestore = newest;
        } else {
          preRestore = addVersion(boardId, { kind: 'pre-restore', from: target.id, ...who, bytes: state.bytes, objects: countObjects(state.bytes), hash: state.hash });
        }
      }
      pending.set(boardId, { from: target.id, ...who, until: now() + limits.restorePendingMs });
      return { versionId: target.id, preRestore: preRestore ? view(preRestore) : null };
    },
  };

  // ------------------------------------------------------------ accounts API

  /**
   * Route definitions for api.mjs (session, CSRF, the hosted read-only 402 and the error format come from it).
   * ctx: { compile, boardFor(user, boardId) -> { role }, audit(user, action, detail), errors: { HttpError, forbidden } }
   */
  function routes({ compile, boardFor, audit, errors }) {
    const { HttpError, forbidden } = errors;
    const asHttp = (fn) => {
      try {
        return fn();
      } catch (err) {
        throw err instanceof HistoryError ? new HttpError(err.status, err.code, err.message) : err;
      }
    };
    // Editors and owners only: the history holds what people deleted.
    const actorFor = (user, boardId) => {
      const { role } = boardFor(user, boardId);
      if (role !== 'owner' && role !== 'editor') throw forbidden('Only editors can see version history');
      return { id: user.id, name: user.name, owner: role === 'owner' };
    };

    return [
      compile('GET', 'boards/:id/versions', {}, ({ user, params }) => {
        actorFor(user, params.id);
        return [200, actions.list(params.id)];
      }),
      compile('GET', 'boards/:id/versions/:vid/state', {}, ({ req, user, params }) => {
        actorFor(user, params.id);
        const gz = asHttp(() => actions.state(params.id, params.vid));
        return stateReply(req, gz);
      }),
      compile('POST', 'boards/:id/versions', { body: true }, ({ user, params, body }) => {
        const actor = actorFor(user, params.id);
        const { version, created } = asHttp(() => actions.create(params.id, actor, body));
        audit(user, 'board.version.create', { boardId: params.id, versionId: version.id, label: version.label });
        return [created ? 201 : 200, version];
      }),
      compile('PATCH', 'boards/:id/versions/:vid', { body: true }, ({ user, params, body }) => {
        const actor = actorFor(user, params.id);
        const version = asHttp(() => actions.rename(params.id, params.vid, actor, body));
        audit(user, 'board.version.rename', { boardId: params.id, versionId: version.id, label: version.label });
        return [200, version];
      }),
      compile('DELETE', 'boards/:id/versions/:vid', {}, ({ user, params }) => {
        const actor = actorFor(user, params.id);
        const { kind } = asHttp(() => find(params.id, params.vid));
        asHttp(() => actions.remove(params.id, params.vid, actor));
        audit(user, 'board.version.delete', { boardId: params.id, versionId: params.vid, kind });
        return [204];
      }),
      compile('POST', 'boards/:id/versions/:vid/begin-restore', { body: true }, ({ user, params }) => {
        const actor = actorFor(user, params.id);
        const result = asHttp(() => actions.beginRestore(params.id, params.vid, actor));
        audit(user, 'board.version.restore', { boardId: params.id, versionId: result.versionId, preRestoreId: result.preRestore?.id ?? null });
        return [200, { preRestore: result.preRestore }];
      }),
    ];
  }

  // The stored gzip goes out as it is for a client that accepts gzip, inflated for one that does not.
  function stateReply(req, gz) {
    const accepts = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
    const headers = { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
    if (accepts) return [200, gz, { ...headers, 'content-encoding': 'gzip' }];
    return [200, zlib.gunzipSync(gz), headers];
  }

  // ------------------------------------------------------------ open mode

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) over = true;
        else chunks.push(chunk);
      });
      req.on('end', () => {
        if (over) return reject(new HistoryError(413, 'too_large', 'The request body is too large'));
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({});
        try {
          const data = JSON.parse(text);
          if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('not an object');
          resolve(data);
        } catch {
          reject(bad('The request body must be a JSON object'));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, body) {
    const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (body === undefined) {
      res.writeHead(status, common);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, { ...common, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  /** Open mode (no accounts): answers the version routes and returns true, or returns false for any other path. */
  async function handleOpen(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return false;
    }
    const m = OPEN_PATH_RE.exec(url.pathname);
    if (!m) return false;
    const [, boardId, versionId, sub] = m;
    const method = String(req.method).toUpperCase();
    const actor = { id: null, name: null, owner: true };
    try {
      let call = null;
      if (!versionId) {
        if (method === 'GET') call = () => [200, actions.list(boardId)];
        else if (method === 'POST') call = (body) => { const r = actions.create(boardId, actor, body); return [r.created ? 201 : 200, r.version]; };
      } else if (!sub) {
        if (method === 'PATCH') call = (body) => [200, actions.rename(boardId, versionId, actor, body)];
        else if (method === 'DELETE') call = () => { actions.remove(boardId, versionId, actor); return [204]; };
      } else if (sub === 'state') {
        if (method === 'GET') call = () => stateReply(req, actions.state(boardId, versionId));
      } else if (method === 'POST') {
        call = (body) => { const r = actions.beginRestore(boardId, versionId, actor, body); return [200, { preRestore: r.preRestore }]; };
      }
      if (!call) throw new HistoryError(405, 'method_not_allowed', 'Method not allowed');
      if (!csrfOk(req)) throw new HistoryError(403, 'csrf', 'Missing or invalid CSRF protection header');
      const needsBody = method === 'POST' || method === 'PATCH';
      const [status, payload, headers] = call(needsBody ? await readBody(req) : {});
      if (Buffer.isBuffer(payload)) {
        res.writeHead(status, { ...headers, 'content-length': payload.length });
        res.end(payload);
      } else {
        sendJson(res, status, payload);
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
      } else if (err instanceof HistoryError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else {
        log('history: request failed', err?.message);
        sendJson(res, 500, { error: 'internal', message: 'Something went wrong' });
      }
    }
    return true;
  }

  // ------------------------------------------------------------ sweep

  /** Applies the retention rules to every board and removes version files that no index names. */
  function sweep() {
    let boards = [];
    try {
      boards = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && BOARD_ID_RE.test(d.name));
    } catch {
      return;
    }
    const t = now();
    for (const { name: boardId } of boards) {
      try {
        const entries = applyPrune(boardId, readIndex(boardId), t);
        const known = new Set(entries.map((e) => `${e.id}.yjs.gz`));
        for (const file of fs.readdirSync(dirOf(boardId))) {
          const isVersionFile = file.endsWith('.yjs.gz') || file.endsWith('.tmp');
          if (!isVersionFile || known.has(file)) continue;
          const full = path.join(dirOf(boardId), file);
          if (t - fs.statSync(full).mtimeMs > limits.orphanMs) fs.unlinkSync(full);
        }
      } catch (err) {
        log(`history ${boardId}: sweep failed`, err?.message);
      }
    }
  }

  sweep();
  const timer = sweepMs > 0 ? setInterval(sweep, sweepMs) : null;
  timer?.unref();

  return {
    onSave,
    actions,
    routes,
    handleOpen,
    sweep,
    close() {
      if (timer) clearInterval(timer);
    },
  };
}
