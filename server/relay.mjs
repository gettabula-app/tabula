#!/usr/bin/env node
// Mira relay: serves the built app and relays Yjs sync + awareness
// messages between everyone in a board room. It keeps each room's document on
// disk so someone joining later catches up even if the author is offline.
//
//   PORT=8787 DATA_DIR=./data node server/relay.mjs
//
// The wire protocol is the standard y-websocket protocol, so any y-websocket
// client can connect to ws://host:PORT/sync/<boardId>. Every board also has a
// sibling comments room, ws://host:PORT/sync/<boardId>~comments (docs/comments.md).
//
// With MIRA_AUTH=on (accounts mode, docs/accounts.md) the relay also serves the
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

const here = path.dirname(fileURLToPath(import.meta.url));
// settings (and secrets such as MAILGUN_API_KEY) may live in a .env file next to where the server starts; real environment variables win
try { process.loadEnvFile(); } catch { /* no .env file */ }
const config = loadConfig();
const PORT = config.port;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = config.dataDir;
const DIST = path.resolve(process.env.DIST_DIR || path.join(here, '..', 'dist'));
const ROOM_RE = /^([A-Za-z0-9_-]{1,64})(~comments)?$/;
const SAVE_DEBOUNCE_MS = 1000;
const UNLOAD_AFTER_MS = 60_000;
const PING_MS = 30_000;
const ROLE_RECHECK_MS = 5_000;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

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

// Who may write which room. Anything not listed here (an unknown role or kind) may not write.
function canWriteRoom(role, kind) {
  if (kind === 'board') return role === 'owner' || role === 'editor';
  if (kind === 'comments') return role === 'owner' || role === 'editor' || role === 'commenter';
  return false;
}

// Leftover comments mean the id was used before, so adopting such a board is as sensitive as adopting its board file.
const roomExists = (id) => fs.existsSync(path.join(DATA_DIR, `${id}.yjs`)) || fs.existsSync(path.join(DATA_DIR, `${id}~comments.yjs`));

// Accounts mode only. The modules are loaded lazily so open mode never touches node:sqlite.
const events = new EventEmitter();
let directory = null;
let auth = null;
let api = null;
if (config.authEnabled) {
  const [{ openDirectory }, { createMailer }, { createAuth }, { createApi }] = await Promise.all([
    import('./directory.mjs'),
    import('./mailer.mjs'),
    import('./auth.mjs'),
    import('./api.mjs'),
  ]);
  directory = openDirectory(path.join(DATA_DIR, 'directory.sqlite'));
  auth = createAuth({ directory, config, mailer: createMailer(config) });
  api = createApi({ directory, auth, config, roomExists, events });
}

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();

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

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, Y.encodeStateAsUpdate(this.doc));
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
      this.unloadTimer = setTimeout(() => {
        if (this.conns.size === 0) {
          this.save();
          this.doc.destroy();
          rooms.delete(this.name);
          log(`room ${this.name}: unloaded`);
        }
      }, UNLOAD_AFTER_MS);
    }
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
  }
  return r;
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

function serveStatic(req, res, url) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The app has not been built yet. Run `npm run build`, then restart the relay. (In development, open the Vite URL instead.)');
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
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, rooms: rooms.size, connections: [...rooms.values()].reduce((n, r) => n + r.conns.size, 0) });
    } else if (url.pathname.startsWith('/api/')) {
      // Anything under /api/ is answered here and never falls through to the single-page app.
      if (api) {
        if (!(await api.handle(req, res))) sendJson(res, 404, { error: 'not_found' });
      } else if (url.pathname === '/api/config') {
        sendJson(res, 200, { authEnabled: false });
      } else {
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
  return { session, role };
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
    ws.canWrite = canWriteRoom(role, ws.roomKind);
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
  events.on('user-removed', ({ userId } = {}) => {
    for (const ws of socketsOf(userId)) refresh(ws, true);
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
    ws.canWrite = canWriteRoom(verdict.role, parsed.kind);
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
  for (const r of rooms.values()) r.save();
  directory?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  log(`Mira relay on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_DIR})${config.authEnabled ? '  (accounts mode)' : ''}`);
});
