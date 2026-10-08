#!/usr/bin/env node
// Tabula relay: serves the built app and relays Yjs sync + awareness
// messages between everyone in a board room. It keeps each room's document on
// disk so someone joining later catches up even if the author is offline.
//
//   PORT=8787 DATA_DIR=./data node server/relay.mjs
//
// The wire protocol is the standard y-websocket protocol, so any y-websocket
// client can connect to ws://host:PORT/sync/<boardId>. Every board also has a
// sibling comments room, ws://host:PORT/sync/<boardId>~comments (docs/comments.md).
//
// With TABULA_AUTH=on (accounts mode, docs/accounts.md) the relay also serves the
// HTTP API and decides who may join which room before it touches the room.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { loadConfig } from './config.mjs';
import { withLegacyEnv } from './env.mjs';
import { createHistory } from './history.mjs';
import { saveDelay } from './save-delay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// settings (and secrets such as TABULA_SMTP_URL) may live in a .env file next to where the server starts; real environment variables win
try { process.loadEnvFile(); } catch { /* no .env file */ }
const env = withLegacyEnv();
const config = loadConfig(env);
const PORT = config.port;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = config.dataDir;
const DIST = path.resolve(process.env.DIST_DIR || path.join(here, '..', 'dist'));
const ROOM_RE = /^([A-Za-z0-9_-]{1,64})(~comments)?$/;
const SAVE_DEBOUNCE_MS = 1000;
const SAVE_MAX_WAIT_MS = 30_000;
const DEFAULT_TITLE = 'Untitled board'; // the directory's title for a board created without one
const UNLOAD_AFTER_MS = Number(process.env.ROOM_UNLOAD_MS) > 0 ? Number(process.env.ROOM_UNLOAD_MS) : 60_000;
const PING_MS = 30_000;
const ROLE_RECHECK_MS = 5_000;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
// Not a y-websocket type (it uses 0 sync, 1 awareness, 2 auth, 3 query awareness). Relay to client only: a hosted
// workspace's read-only switch flipped (docs/cloud.md). Room.onMessage ignores it from a client like any unknown type.
const MSG_WORKSPACE = 4;

const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_NOT_FOUND = 4404;
const CLOSE_ACCESS_REMOVED = 4410;

fs.mkdirSync(DATA_DIR, { recursive: true });

const log = (...a) => {
  if (process.env.QUIET !== '1') console.log(new Date().toISOString(), ...a);
};

// A room name is `<boardId>` or `<boardId>~comments` (the `~` cannot occur in a board id).
function parseRoom(name) {
  const m = typeof name === 'string' ? ROOM_RE.exec(name) : null;
  return m ? { boardId: m[1], kind: m[2] ? 'comments' : 'board' } : null;
}

// Who may write which room. Anything not listed here (an unknown role or kind) may not write, and nobody writes
// while a hosted workspace is read-only, or to a deleted board (workspace admins may still open one, to look before
// restoring it).
function canWriteRoom(role, kind, deleted = false) {
  if (deleted || cloud?.limits().readOnly) return false;
  if (kind === 'board') return role === 'owner' || role === 'editor';
  if (kind === 'comments') return role === 'owner' || role === 'editor' || role === 'commenter';
  return false;
}

// Leftover comments mean the id was used before, so adopting such a board is as sensitive as adopting its board file.
const roomExists = (id) => fs.existsSync(path.join(DATA_DIR, `${id}.yjs`)) || fs.existsSync(path.join(DATA_DIR, `${id}~comments.yjs`));

// Version history (docs/history.md), in both modes. The state of a board room: the live room, else its file.
function boardState(id) {
  const room = rooms.get(id);
  if (room) return Y.encodeStateAsUpdate(room.doc);
  try {
    return fs.readFileSync(path.join(DATA_DIR, `${id}.yjs`));
  } catch {
    return null;
  }
}
const history = createHistory({ dataDir: DATA_DIR, boardState, log });

// Accounts mode only. The modules are loaded lazily so open mode never touches node:sqlite.
const events = new EventEmitter();
let directory = null;
let auth = null;
let api = null;
let cloud = null;
if (config.authEnabled) {
  const [{ openDirectory }, { createMailer }, { createAuth }, { createApi }, { createCloud }] = await Promise.all([
    import('./directory.mjs'),
    import('./mailer.mjs'),
    import('./auth.mjs'),
    import('./api.mjs'),
    import('./cloud.mjs'),
  ]);
  directory = openDirectory(path.join(DATA_DIR, 'directory.sqlite'));
  // Hosted workspaces (docs/cloud.md): null unless TABULA_CLOUD_* is set, and then every hook below is inert.
  cloud = createCloud({ config: config.cloud, directory, events });
  auth = createAuth({ directory, config, mailer: createMailer(config), seatsAvailable: cloud?.seatsAvailable });
  api = createApi({ directory, auth, config, roomExists, events, liveStats, cloud, history });
} else if (env.TABULA_CLOUD_TOKEN || env.TABULA_CLOUD_URL || env.TABULA_CLOUD_WORKSPACE_ID) {
  console.error('TABULA_CLOUD_* is ignored: hosted workspace mode needs TABULA_AUTH=on');
}

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();

// Hoisted on purpose: the API is created above this line and asks for it per request. /api/health reports the same numbers.
function liveStats() {
  return { rooms: rooms.size, connections: [...rooms.values()].reduce((n, r) => n + r.conns.size, 0) };
}

class Room {
  constructor(name) {
    this.name = name;
    this.kind = parseRoom(name).kind;
    this.file = path.join(DATA_DIR, `${name}.yjs`);
    this.doc = new Y.Doc({ gc: true });
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    /** @type {Map<import('ws').WebSocket, Set<number>>} */
    this.conns = new Map();
    this.saveTimer = null;
    this.unloadTimer = null;
    this.dirty = false;
    this.firstUnsavedAt = null;

    if (fs.existsSync(this.file)) {
      try {
        Y.applyUpdate(this.doc, fs.readFileSync(this.file));
      } catch (err) {
        log(`room ${name}: could not read saved state`, err);
      }
    }

    this.doc.on('update', (update) => {
      this.dirty = true;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc));
      this.scheduleSave();
    });

    this.awareness.on('update', ({ added, updated, removed }, conn) => {
      const changed = added.concat(updated, removed);
      if (conn && this.conns.has(conn)) {
        const ids = this.conns.get(conn);
        added.forEach((id) => ids.add(id));
        removed.forEach((id) => ids.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(enc));
    });
  }

  broadcast(msg) {
    for (const ws of this.conns.keys()) send(ws, msg);
  }

  // A debounce, but never later than SAVE_MAX_WAIT_MS after the first change that is still unsaved.
  scheduleSave() {
    clearTimeout(this.saveTimer);
    const now = Date.now();
    this.firstUnsavedAt ??= now;
    const delay = saveDelay({ now, firstUnsavedAt: this.firstUnsavedAt, debounceMs: SAVE_DEBOUNCE_MS, maxWaitMs: SAVE_MAX_WAIT_MS });
    this.saveTimer = setTimeout(() => this.save(), delay);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.firstUnsavedAt = null;
    const tmp = `${this.file}.tmp`;
    const bytes = Y.encodeStateAsUpdate(this.doc);
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, this.file);
    if (directory && this.kind === 'board' && this.dirty) {
      this.dirty = false;
      try {
        const title = this.doc.getMap('meta').get('name');
        directory.touchBoard(this.name, typeof title === 'string' && title.trim() ? { title } : {});
      } catch (err) {
        log(`room ${this.name}: could not update the directory`, err?.message);
      }
    }
    history.onSave(this, bytes);
  }

  join(ws) {
    clearTimeout(this.unloadTimer);
    this.conns.set(ws, new Set());

    // Start the sync handshake: send our state vector.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    send(ws, encoding.toUint8Array(enc));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      send(ws, encoding.toUint8Array(a));
    }
  }

  leave(ws) {
    const ids = this.conns.get(ws);
    this.conns.delete(ws);
    if (ids?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
    if (this.conns.size === 0) {
      if (this.saveTimer) this.save();
      this.releaseIfIdle();
    }
  }

  // Starts the unload timer when nobody is connected. A room opened for an MCP edit would otherwise stay in memory.
  releaseIfIdle() {
    if (this.conns.size !== 0) return;
    clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      if (this.conns.size === 0) {
        this.save();
        this.doc.destroy();
        rooms.delete(this.name);
        log(`room ${this.name}: unloaded`);
      }
    }, UNLOAD_AFTER_MS);
  }
  /**
   * A board named through POST or PATCH /api/boards (outside the app) has its title only in the directory, and the
   * board would open as "Untitled board". A board document without a name takes the
   * directory's title; one with a name keeps it (saving copies it to the directory, as before).
   */
  nameFromDirectory() {
    if (!directory || this.kind !== 'board') return;
    const title = directory.getBoard(this.name)?.title;
    const meta = this.doc.getMap('meta');
    if (typeof title === 'string' && title !== DEFAULT_TITLE && !meta.has('name')) this.setName(title);
  }

  setName(title) {
    const meta = this.doc.getMap('meta');
    if (meta.get('name') !== title) this.doc.transact(() => meta.set('name', title), 'relay');
  }


  onMessage(ws, data) {
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        // A connection that may not write this room can still ask for the state (step 1): step 2 and updates are dropped.
        if (ws.canWrite !== true && decoding.peekVarUint(dec) !== syncProtocol.messageYjsSyncStep1) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, this.doc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), ws);
      }
    } catch (err) {
      log(`room ${this.name}: bad message`, err?.message);
    }
  }
}

function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = new Room(name);
    rooms.set(name, r);
    log(`room ${name}: loaded`);
    r.nameFromDirectory();
  }
  return r;
}

// MCP (docs/mcp.md) edits the live room documents through this, never the files. `read` loads nothing into memory
// (a room that is open is read in place, otherwise the file is decoded into a throwaway document); `write` applies
// fn inside one transaction on the room's own doc, so the update listener broadcasts it to every socket and saves it.
// Callers have authorised the board before they get here: getRoom() creates the room file for an unknown name.
const roomAccess = {
  exists: (name) => rooms.has(name) || fs.existsSync(path.join(DATA_DIR, `${name}.yjs`)),
  read(name, fn) {
    const open = rooms.get(name);
    if (open) return fn(open.doc);
    const doc = new Y.Doc({ gc: true });
    try {
      const file = path.join(DATA_DIR, `${name}.yjs`);
      if (fs.existsSync(file)) Y.applyUpdate(doc, fs.readFileSync(file));
      return fn(doc);
    } finally {
      doc.destroy();
    }
  },
  write(name, origin, fn) {
    const room = getRoom(name);
    try {
      let result;
      room.doc.transact(() => {
        result = fn(room.doc);
      }, origin);
      return result;
    } finally {
      room.releaseIfIdle();
    }
  },
};

let mcp = null;
if (config.mcp) {
  const { createMcp } = await import('./mcp.mjs');
  mcp = createMcp({ config, directory, cloud, canWriteRoom, roomAccess, log });
}

function workspaceHint(readOnly) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_WORKSPACE);
  encoding.writeVarString(enc, JSON.stringify({ readOnly }));
  return encoding.toUint8Array(enc);
}

function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(msg, (err) => {
    if (err) ws.close();
  });
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://api.fontshare.com",
  "font-src 'self' data: https://cdn.fontshare.com",
  "img-src 'self' data: blob: https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com",
  "connect-src 'self' ws: wss: https://api.fontshare.com https://cdn.fontshare.com https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com",
  "worker-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const DOCS = path.join(DIST, 'docs');

function sendFile(res, file, status, cache) {
  const ext = path.extname(file);
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': cache,
  };
  if (ext === '.html') headers['content-security-policy'] = CSP;
  res.writeHead(status, headers);
  fs.createReadStream(file).pipe(res);
}

// The user guide: files are resolved inside dist/docs only and never fall back to the app shell.
function serveDocs(req, res, url) {
  const decoded = decodeURIComponent(url.pathname);
  const notFound = () => {
    const page = path.join(DOCS, '404.html');
    if (fs.existsSync(page)) sendFile(res, page, 404, 'no-cache');
    else res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  };
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((seg) => seg === '..' || seg === '.')) {
    res.writeHead(404).end();
    return;
  }
  const rel = decoded.slice('/docs'.length).replace(/^\/+|\/+$/g, '');
  const ext = path.extname(rel);
  const file = path.resolve(DOCS, rel === '' ? 'index.html' : ext ? rel : path.join(rel, 'index.html'));
  if (!file.startsWith(DOCS + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  const isFile = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!isFile || file === path.join(DOCS, '404.html')) {
    if (!ext || ext === '.html') notFound();
    else res.writeHead(404).end();
    return;
  }
  sendFile(res, file, 200, 'no-cache');
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The app has not been built yet. Run `npm run build`, then restart the relay. (In development, open the Vite URL instead.)');
    return;
  }
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
    serveDocs(req, res, url);
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  let file = path.resolve(DIST, '.' + rel);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file);
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (ext === '.html') headers['content-security-policy'] = CSP;
  headers['cache-control'] = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...NO_STORE });
  res.end(JSON.stringify(body));
}

async function onRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/mcp') {
      // Never the single-page app: /mcp is either the endpoint or a 404.
      if (mcp) await mcp.handle(req, res);
      else sendJson(res, 404, { error: 'not_found' });
    } else if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, ...liveStats() });
    } else if (url.pathname.startsWith('/api/')) {
      // Anything under /api/ is answered here and never falls through to the single-page app.
      if (api) {
        if (!(await api.handle(req, res))) sendJson(res, 404, { error: 'not_found' });
      } else if (url.pathname === '/api/config') {
        sendJson(res, 200, { authEnabled: false });
      } else if (!(await history.handleOpen(req, res))) {
        sendJson(res, 404, { error: 'not_found' });
      }
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    log('request failed', req.method, err?.message);
    if (res.headersSent) res.end();
    else if (err instanceof URIError || err instanceof TypeError) res.writeHead(400).end();
    else res.writeHead(500).end();
  }
}

const server = http.createServer(onRequest);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

// ---------------------------------------------------------------- accounts: who is connected

const isWorkspaceAdmin = (user) => user.role === 'owner' || user.role === 'admin';

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const userSockets = new Map();

function track(ws) {
  let set = userSockets.get(ws.userId);
  if (!set) userSockets.set(ws.userId, (set = new Set()));
  set.add(ws);
}

function untrack(ws) {
  const set = userSockets.get(ws.userId);
  set?.delete(ws);
  if (set?.size === 0) userSockets.delete(ws.userId);
}

const socketsOf = (userId) => [...(userSockets.get(userId) ?? [])];
const allSockets = () => [...userSockets.values()].flatMap((set) => [...set]);

// Runs before the room is touched: an unauthorised connection must never load or create a room file.
function authorise(req, board) {
  const session = auth.authenticate(req.headers.cookie);
  if (!session) return { code: CLOSE_UNAUTHENTICATED, reason: 'unauthenticated' };
  const row = directory.getBoard(board);
  if (!row || (row.deletedAt != null && !isWorkspaceAdmin(session.user))) return { code: CLOSE_NOT_FOUND, reason: 'board_not_found' };
  const role = directory.boardRole(board, session.user.id);
  if (role === null) return { code: CLOSE_FORBIDDEN, reason: 'no_access' };
  return { session, role, deleted: row.deletedAt != null };
}

function deny(ws, code, reason) {
  ws.denied = true;
  ws.role = null;
  ws.canWrite = false;
  ws.close(code, reason);
}

// Re-resolves the role of one connection. `force` skips the 5 second throttle (access changes and revocations).
function refresh(ws, force) {
  if (ws.denied) return;
  const now = Date.now();
  if (!force && now - ws.checkedAt < ROLE_RECHECK_MS) return;
  ws.checkedAt = now;
  try {
    const role = directory.boardRole(ws.boardId, ws.userId);
    if (role === null) return deny(ws, CLOSE_ACCESS_REMOVED, 'access_removed');
    if (ws.sessionRevoked) return deny(ws, CLOSE_UNAUTHENTICATED, 'unauthenticated');
    if (now >= ws.sessionExpiresAt) {
      // The expiry slides while the person uses the app elsewhere, so ask before giving up on it.
      const session = auth.authenticate(ws.cookie);
      if (!session || session.sessionId !== ws.sessionId) return deny(ws, CLOSE_UNAUTHENTICATED, 'unauthenticated');
      ws.sessionExpiresAt = session.expiresAt;
    }
    ws.role = role;
    ws.deleted = directory.getBoard(ws.boardId)?.deletedAt != null;
    ws.canWrite = canWriteRoom(role, ws.roomKind, ws.deleted);
  } catch (err) {
    log(`room ${ws.roomName}: could not resolve a role`, err?.message);
    deny(ws, 1011, 'internal_error');
  }
}

if (config.authEnabled) {
  events.on('access-changed', ({ userId, boardId } = {}) => {
    for (const ws of userId ? socketsOf(userId) : allSockets()) {
      if (!boardId || ws.boardId === boardId) refresh(ws, true);
    }
  });
  events.on('session-revoked', ({ userId, sessionId } = {}) => {
    for (const ws of socketsOf(userId)) {
      if (sessionId && ws.sessionId !== sessionId) continue;
      ws.sessionRevoked = true;
      refresh(ws, true);
    }
  });
  // PATCH /api/boards/:id renamed it: the board itself shows the new name, and the next save keeps it.
  events.on('board-renamed', ({ boardId, title } = {}) => {
    if (typeof boardId !== 'string' || typeof title !== 'string' || !parseRoom(boardId)) return;
    try {
      const room = getRoom(boardId);
      room.setName(title);
      room.releaseIfIdle();
    } catch (err) {
      log(`room ${boardId}: could not rename`, err?.message);
    }
  });
  events.on('user-removed', ({ userId } = {}) => {
    for (const ws of socketsOf(userId)) refresh(ws, true);
  });
  // A workspace that turns read-only (or back) applies to sockets that are already open, and only a flip of that switch
  // (not a banner, a seat limit or a repeated value) tells the clients, who then ask /api/me what is true. `send` skips
  // a socket that is closing, such as one the refresh just denied.
  let knownReadOnly = cloud?.limits().readOnly === true;
  events.on('limits-changed', ({ readOnly } = {}) => {
    const flipped = (readOnly === true) !== knownReadOnly;
    knownReadOnly = readOnly === true;
    const hint = flipped ? workspaceHint(knownReadOnly) : null;
    for (const ws of allSockets()) {
      refresh(ws, true);
      if (hint) send(ws, hint);
    }
  });
  setInterval(() => {
    for (const ws of allSockets()) refresh(ws, false);
  }, 1000);
}

server.on('upgrade', (req, socket, head) => {
  // Before anything else: a page on another origin (for example a sibling workspace subdomain) must not ride the cookie.
  if (config.authEnabled && req.headers.origin !== config.origin) {
    socket.on('error', () => socket.destroy());
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  let name = null;
  try {
    const m = new URL(req.url, 'http://x').pathname.match(/^\/sync\/([^/]+)$/);
    name = m && decodeURIComponent(m[1]);
  } catch {
    name = null;
  }
  const parsed = parseRoom(name);
  if (!parsed) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.binaryType = 'arraybuffer';
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', () => ws.close());

    if (!config.authEnabled) {
      ws.canWrite = true;
      const room = getRoom(name);
      ws.on('message', (data) => room.onMessage(ws, data));
      ws.on('close', () => room.leave(ws));
      room.join(ws);
      return;
    }

    let verdict;
    try {
      verdict = authorise(req, parsed.boardId);
    } catch (err) {
      log(`room ${name}: could not authorise`, err?.message);
      verdict = { code: 1011, reason: 'internal_error' };
    }
    if (!verdict.session) {
      ws.close(verdict.code, verdict.reason);
      return;
    }

    ws.userId = verdict.session.user.id;
    ws.sessionId = verdict.session.sessionId;
    ws.sessionExpiresAt = verdict.session.expiresAt;
    ws.cookie = req.headers.cookie;
    ws.boardId = parsed.boardId;
    ws.roomName = name;
    ws.roomKind = parsed.kind;
    ws.role = verdict.role;
    ws.deleted = verdict.deleted;
    ws.canWrite = canWriteRoom(verdict.role, parsed.kind, verdict.deleted);
    ws.checkedAt = Date.now();
    ws.sessionRevoked = false;
    ws.denied = false;
    track(ws);

    const room = getRoom(name);
    ws.on('message', (data) => {
      refresh(ws, false);
      if (!ws.denied) room.onMessage(ws, data);
    });
    ws.on('close', () => {
      untrack(ws);
      room.leave(ws);
    });
    room.join(ws);
  });
});

const pinger = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_MS);

function shutdown() {
  clearInterval(pinger);
  cloud?.close();
  for (const r of rooms.values()) r.save();
  history.close();
  directory?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  log(`Tabula relay on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_DIR})${config.authEnabled ? '  (accounts mode)' : ''}${cloud ? '  (hosted workspace)' : ''}`);
});
