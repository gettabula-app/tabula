#!/usr/bin/env node
// Mira relay: serves the built app and relays Yjs sync + awareness
// messages between everyone in a board room. It keeps each room's document on
// disk so someone joining later catches up even if the author is offline.
//
//   PORT=8787 DATA_DIR=./data node server/relay.mjs
//
// The wire protocol is the standard y-websocket protocol, so any y-websocket
// client can connect to ws://host:PORT/sync/<boardId>.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
const DIST = path.resolve(process.env.DIST_DIR || path.join(here, '..', 'dist'));
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAVE_DEBOUNCE_MS = 1000;
const UNLOAD_AFTER_MS = 60_000;
const PING_MS = 30_000;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

fs.mkdirSync(DATA_DIR, { recursive: true });

const log = (...a) => {
  if (process.env.QUIET !== '1') console.log(new Date().toISOString(), ...a);
};

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(name) {
    this.name = name;
    this.file = path.join(DATA_DIR, `${name}.yjs`);
    this.doc = new Y.Doc({ gc: true });
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    /** @type {Map<import('ws').WebSocket, Set<number>>} */
    this.conns = new Map();
    this.saveTimer = null;
    this.unloadTimer = null;

    if (fs.existsSync(this.file)) {
      try {
        Y.applyUpdate(this.doc, fs.readFileSync(this.file));
      } catch (err) {
        log(`room ${name}: could not read saved state`, err);
      }
    }

    this.doc.on('update', (update) => {
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

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: [...rooms.values()].reduce((n, r) => n + r.conns.size, 0) }));
    return;
  }
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

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/sync\/([^/]+)$/);
  const name = m && decodeURIComponent(m[1]);
  if (!name || !ROOM_RE.test(name)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = getRoom(name);
    ws.binaryType = 'arraybuffer';
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data) => room.onMessage(ws, data));
    ws.on('close', () => room.leave(ws));
    ws.on('error', () => ws.close());
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
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  log(`Mira relay on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_DIR})`);
});
