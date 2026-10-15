import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { MAX_PREVIEW_BYTES } from '../server/preview-image.mjs';

type Account = { user: NonNullable<ReturnType<ReturnType<typeof openDirectory>['createUser']>>; cookie: string };
type Reply = { status: number; headers: Headers; text: string; bytes: Buffer };
type Room = { doc: Y.Doc; dirty: boolean };
type World = Awaited<ReturnType<typeof setup>>;

const worlds: World[] = [];
let serial = 0;

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const chunkData = Buffer.concat([Buffer.from(name), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(chunkData));
  return Buffer.concat([length, chunkData, checksum]);
}

function png(data = deflateSync(Buffer.alloc((480 * 4 + 1) * 300))) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(480, 0);
  header.writeUInt32BE(300, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([pngSignature, pngChunk('IHDR', header), pngChunk('IDAT', data), pngChunk('IEND')]);
}

function animatedPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(480, 0);
  header.writeUInt32BE(300, 4);
  return Buffer.concat([pngSignature, pngChunk('IHDR', header), pngChunk('acTL', Buffer.alloc(8)), pngChunk('IDAT', Buffer.from([0])), pngChunk('IEND')]);
}

function webpChunk(name: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(name), length, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function animatedWebp() {
  const extended = Buffer.alloc(10);
  extended[0] = 0x02;
  extended[4] = 0xdf;
  extended[5] = 1;
  extended[7] = 0x2b;
  extended[8] = 1;
  const frame = Buffer.alloc(10);
  frame[3] = 0x9d;
  frame[4] = 1;
  frame[5] = 0x2a;
  frame.writeUInt16LE(480, 6);
  frame.writeUInt16LE(300, 8);
  const body = Buffer.concat([Buffer.from('WEBP'), webpChunk('VP8X', extended), webpChunk('ANIM', Buffer.alloc(6)), webpChunk('VP8 ', frame)]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), length, body]);
}

function webp() {
  const frame = Buffer.alloc(10);
  frame[3] = 0x9d;
  frame[4] = 1;
  frame[5] = 0x2a;
  frame.writeUInt16LE(480, 6);
  frame.writeUInt16LE(300, 8);
  const body = Buffer.concat([Buffer.from('WEBP'), webpChunk('VP8 ', frame)]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), length, body]);
}

async function setup({ previewDev = true, readOnly = false }: { previewDev?: boolean; readOnly?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-preview-dev-'));
  const clock = { now: Date.UTC(2026, 9, 15, 12) };
  const config = loadConfig({
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'workspace-owner@example.test',
    TABULA_MAIL: 'file',
    TABULA_JOIN_CODES: 'on',
    DATA_DIR: root,
    ...(previewDev ? { TABULA_PREVIEW_DEV: '1' } : {}),
  }, () => {});
  const directory = openDirectory(path.join(root, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} }, now: () => clock.now });
  const rooms = new Map<string, Room>();
  let writes = 0;
  let throwawayReads = 0;
  const roomAccess = {
    exists: (name: string) => rooms.has(name) || fs.existsSync(path.join(root, `${name}.yjs`)),
    read(name: string, fn: (doc: Y.Doc) => unknown) {
      const room = rooms.get(name);
      if (room) return fn(room.doc);
      throwawayReads++;
      const doc = new Y.Doc({ gc: true });
      const filename = path.join(root, `${name}.yjs`);
      try {
        if (fs.existsSync(filename)) Y.applyUpdate(doc, fs.readFileSync(filename));
        return fn(doc);
      } finally {
        doc.destroy();
      }
    },
    write() { writes++; throw new Error('preview routes must not write a sync room'); },
  };
  const api = createApi({
    directory, auth, config, roomExists: roomAccess.exists, events: new EventEmitter(),
    now: () => clock.now,
    cloud: readOnly ? { limits: () => ({ readOnly: true }) } as never : null,
    dataDir: root, mailer: { send: async () => {} }, roomAccess: roomAccess as never,
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function account(role: 'owner' | 'admin' | 'member' | 'guest' = 'member'): Account {
    const n = ++serial;
    const user = directory.createUser({ email: `preview-${n}@example.test`, name: `Preview ${n}`, role })!;
    const session = directory.createSession(user.id, { ttlMs: 24 * 60 * 60_000, now: clock.now });
    return { user, cookie: `${config.cookieName}=${session.token}` };
  }

  function newBoard(owner: Account, id = `preview_board_${++serial}`) {
    return directory.createBoard({ id, title: `Preview ${id}`, ownerId: owner.user.id })!;
  }

  function room(boardId: string, doc = new Y.Doc()) {
    const entry = { doc, dirty: false };
    doc.on('update', () => { entry.dirty = true; });
    rooms.set(boardId, entry);
    return entry;
  }

  function unload(boardId: string) {
    const entry = rooms.get(boardId);
    if (!entry) return;
    fs.writeFileSync(path.join(root, `${boardId}.yjs`), Buffer.from(Y.encodeStateAsUpdate(entry.doc)), { mode: 0o600 });
    entry.doc.destroy();
    rooms.delete(boardId);
  }

  async function call(who: { cookie: string } | null, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}, csrf = true): Promise<Reply> {
    const requestHeaders: Record<string, string> = {
      ...(who ? { cookie: who.cookie } : {}),
      ...(csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? { 'x-tabula': '1' } : {}),
      ...headers,
    };
    let requestBody: BodyInit | undefined;
    if (Buffer.isBuffer(body)) requestBody = new Uint8Array(body);
    else if (body !== undefined) {
      requestBody = JSON.stringify(body);
      requestHeaders['content-type'] ??= 'application/json';
    }
    const response = await fetch(base + urlPath, { method, headers: requestHeaders, body: requestBody });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, text: bytes.toString('utf8'), bytes };
  }

  class MemoryResponse extends EventEmitter {
    headersSent = false;
    statusCode = 200;
    headers: Record<string, string> = {};
    bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    setHeader(name: string, value: string | number) { this.headers[name.toLowerCase()] = String(value); }
    writeHead(status: number, headers: Record<string, string | number> = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      return this;
    }
    end(bytes?: Buffer | string) {
      this.bytes = bytes === undefined ? Buffer.alloc(0) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      this.emit('finish');
      return this;
    }
  }

  async function streamed(method: string, urlPath: string, payload: Buffer, headers: Record<string, string>): Promise<Reply> {
    const req = Object.assign(Readable.from([payload]), { method, url: urlPath, headers });
    const res = new MemoryResponse();
    await api.handle(req as never, res as never);
    const responseHeaders = new Headers(res.headers);
    return { status: res.statusCode, headers: responseHeaders, text: res.bytes.toString('utf8'), bytes: res.bytes };
  }

  function guest(boardId: string, creator: Account) {
    const token = `guest-token-${++serial}`;
    const code = directory.createJoinCode({
      boardId,
      createdBy: creator.user.id,
      codeHash: 'a'.repeat(64),
      role: 'editor',
      createdAt: clock.now,
      expiresAt: clock.now + 60 * 60_000,
      maxUses: 5,
    });
    if (!code) throw new Error('join code creation failed');
    directory.createGuestSession(code.id, {
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      name: 'Preview guest',
      now: clock.now,
    });
    return { cookie: `${config.cookieName}=${token}` };
  }

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const entry of rooms.values()) entry.doc.destroy();
    rooms.clear();
    directory.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { account, api, base, call, clock, close, config, directory, guest, newBoard, room, root, streamed, unload, writes: () => writes, throwawayReads: () => throwawayReads, isLoaded: (id: string) => rooms.has(id) };
}

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

describe('developer board previews', () => {
  it('keeps all preview routes absent by default and creates no store directory', async () => {
    const world = await setup({ previewDev: false });
    worlds.push(world);
    expect(world.config.previewDev).toBe(false);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    for (const [method, tail] of [['GET', 'preview-source'], ['PUT', 'preview'], ['GET', 'preview']] as const) {
      const response = await world.call(owner, method, `/api/boards/${board.id}/${tail}`, method === 'PUT' ? png() : undefined, method === 'PUT' ? { 'content-type': 'image/png' } : {});
      expect(response.status).toBe(404);
    }
    expect(fs.existsSync(path.join(world.root, 'previews-dev'))).toBe(false);
  });

  it('filters preview-source, reads without dirtying a room, and stores an atomic image slot', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const editor = world.account();
    const board = world.newBoard(owner, 'preview_board');
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: editor.user.id, role: 'editor' });
    const room = world.room(board.id);
    const objects = room.doc.getMap('objects');
    const add = (id: string, value: Record<string, unknown>) => objects.set(id, new Y.Map(Object.entries({ id, x: 0, y: 0, w: 100, h: 80, rotation: 0, z: id, ...value })));
    add('visible', { type: 'sticky', text: 'Visible' });
    add('private-note', { type: 'sticky', text: 'THE PRIVATE NOTE', privateStep: 'step-1' });
    add('private-card', { type: 'card', text: 'THE PRIVATE CARD', privateStep: 'step-1' });
    add('hidden', { type: 'sticky', text: 'THE HIDDEN OBJECT', hidden: true });
    add('bound-connector', { type: 'connector', from: { kind: 'bound', id: 'private-note' }, to: { kind: 'point', x: 200, y: 200 } });
    room.doc.getMap('meta').set('lastEditedBy', 'last-editor-id');
    const comments = world.room(`${board.id}~comments`);
    comments.doc.getMap('threads').set('comment-1', new Y.Map([['text', 'THE PRIVATE COMMENT']]));
    comments.dirty = false;
    room.dirty = false;
    const updatedAt = world.directory.getBoard(board.id)!.updatedAt;

    const sourcePath = `/api/boards/${board.id}/preview-source`;
    const firstSource = await world.call(editor, 'GET', sourcePath);
    world.clock.now += 2_001;
    const secondSource = await world.call(editor, 'GET', sourcePath);
    expect(firstSource.status).toBe(200);
    expect(firstSource.headers.get('cache-control')).toBe('private, no-store');
    expect(firstSource.headers.get('x-content-type-options')).toBe('nosniff');
    const source = JSON.parse(firstSource.text) as { objects: Array<Record<string, unknown>>; revealed: boolean };
    expect(source.revealed).toBe(false);
    expect(source.objects.map((item) => item.id)).toEqual(['visible']);
    expect(firstSource.text).not.toContain('THE PRIVATE');
    expect(firstSource.text).not.toContain('THE HIDDEN OBJECT');
    expect(firstSource.text).not.toContain('THE PRIVATE COMMENT');
    expect(JSON.parse(secondSource.text)).toEqual(source);
    expect(world.directory.getBoard(board.id)!.updatedAt).toBe(updatedAt);
    expect(room.dirty).toBe(false);
    expect(world.writes()).toBe(0);

    room.doc.getMap('flow').set('reveal', true);
    room.dirty = false;
    world.clock.now += 2_001;
    const revealed = await world.call(editor, 'GET', sourcePath);
    expect(JSON.parse(revealed.text)).toMatchObject({ revealed: true });
    const revealedIds = (JSON.parse(revealed.text) as { objects: Array<{ id: string }> }).objects.map((item) => item.id);
    expect(revealedIds).toContain('private-note');
    expect(revealedIds).toContain('private-card');
    expect(revealedIds).not.toContain('hidden');
    expect(revealedIds).toContain('bound-connector');
    expect(room.dirty).toBe(false);

    const image = png();
    const upload = await world.call(editor, 'PUT', `/api/boards/${board.id}/preview`, image, { 'content-type': 'image/png' });
    expect(upload.status).toBe(204);
    const uploadedAt = world.clock.now;
    expect(world.writes()).toBe(0);
    expect(world.directory.getBoard(board.id)!.updatedAt).toBe(updatedAt);
    expect(room.doc.getMap('meta').get('lastEditedBy')).toBe('last-editor-id');
    expect(room.dirty).toBe(false);

    world.unload(board.id);
    world.clock.now += 2_001;
    const unloadedSource = await world.call(editor, 'GET', sourcePath);
    expect(unloadedSource.status).toBe(200);
    expect(world.isLoaded(board.id)).toBe(false);
    expect(world.throwawayReads()).toBeGreaterThan(0);
    expect(world.directory.getBoard(board.id)!.updatedAt).toBe(updatedAt);

    const storeDir = path.join(world.root, 'previews-dev');
    const boardHash = crypto.createHash('sha256').update(board.id).digest('hex');
    const filenames = fs.readdirSync(storeDir).sort();
    expect(filenames).toEqual([`${boardHash}.img`, `${boardHash}.json`]);
    expect((fs.statSync(storeDir).mode & 0o777)).toBe(0o700);
    for (const name of filenames) expect((fs.statSync(path.join(storeDir, name)).mode & 0o777)).toBe(0o600);
    const metadata = JSON.parse(fs.readFileSync(path.join(storeDir, `${boardHash}.json`), 'utf8'));
    expect(metadata).toEqual({
      type: 'image/png', width: 480, height: 300, bytes: image.length,
      uploadedBy: editor.user.id, at: uploadedAt,
      etag: `"${crypto.createHash('sha256').update(image).digest('hex')}"`,
    });
    expect(world.directory.listAudit(10).filter((row) => row.action === 'board.preview.upload').map((row) => row.detail)).toEqual([{
      boardId: board.id, by: editor.user.id, bytes: image.length,
    }]);

    const viewer = world.account();
    const commenter = world.account();
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: viewer.user.id, role: 'viewer' });
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: commenter.user.id, role: 'commenter' });
    for (const reader of [viewer, commenter]) {
      expect((await world.call(reader, 'GET', `/api/boards/${board.id}/preview`)).status).toBe(200);
      expect((await world.call(reader, 'GET', sourcePath)).status).toBe(403);
      expect((await world.call(reader, 'PUT', `/api/boards/${board.id}/preview`, image, { 'content-type': 'image/png' })).status).toBe(403);
    }

    const get = await world.call(viewer, 'GET', `/api/boards/${board.id}/preview`);
    expect(get.status).toBe(200);
    expect(get.bytes).toEqual(image);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(get.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(get.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(get.headers.get('cache-control')).toBe('private, no-cache');
    expect(get.headers.get('content-disposition')).toBeNull();
    const etag = `"${crypto.createHash('sha256').update(image).digest('hex')}"`;
    expect(get.headers.get('etag')).toBe(etag);
    const notModified = await world.call(viewer, 'GET', `/api/boards/${board.id}/preview`, undefined, { 'if-none-match': etag });
    expect(notModified.status).toBe(304);
    expect(notModified.bytes.length).toBe(0);
    expect(notModified.headers.get('content-type')).toBe('image/png');
    expect(notModified.headers.get('etag')).toBe(etag);
  });

  it('uses identical 404s for no access and no stored image', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const outsider = world.account();
    const stored = world.newBoard(owner);
    const empty = world.newBoard(owner);
    await world.call(owner, 'PUT', `/api/boards/${stored.id}/preview`, png(), { 'content-type': 'image/png' });
    const noAccess = await world.call(outsider, 'GET', `/api/boards/${stored.id}/preview`);
    const noPreview = await world.call(owner, 'GET', `/api/boards/${empty.id}/preview`);
    const noSourceAccess = await world.call(outsider, 'GET', `/api/boards/${stored.id}/preview-source`);
    expect(noAccess.status).toBe(404);
    expect(noPreview.status).toBe(404);
    expect(noAccess.text).toBe(noPreview.text);
    expect(noSourceAccess.status).toBe(404);
    expect(noAccess.headers.get('cache-control')).toBe(noPreview.headers.get('cache-control'));
    expect(noAccess.headers.get('x-content-type-options')).toBe(noPreview.headers.get('x-content-type-options'));
  });

  it('accepts and serves a validated WebP preview', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const image = webp();
    const uploaded = await world.call(owner, 'PUT', `/api/boards/${board.id}/preview`, image, { 'content-type': 'image/webp' });
    expect(uploaded.status).toBe(204);
    const fetched = await world.call(owner, 'GET', `/api/boards/${board.id}/preview`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/webp');
    expect(fetched.bytes).toEqual(image);
  });

  it('caps the filtered preview source at 5,000 objects', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const room = world.room(board.id);
    const objects = room.doc.getMap('objects');
    for (let index = 0; index < 5001; index++) {
      objects.set(`object_${index}`, new Y.Map(Object.entries({ id: `object_${index}`, type: 'sticky', x: 0, y: 0, w: 100, h: 80, z: String(index), text: 'visible' })));
    }
    room.dirty = false;
    const response = await world.call(owner, 'GET', `/api/boards/${board.id}/preview-source`);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.text).error).toBe('too_large');
    expect(room.dirty).toBe(false);
  });

  it('limits preview-source per board and per user, and charges every upload attempt, valid or not', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const sourcePath = `/api/boards/${board.id}/preview-source`;
    expect((await world.call(owner, 'GET', sourcePath)).status).toBe(200);
    const again = await world.call(owner, 'GET', sourcePath);
    expect(again.status).toBe(429);
    world.clock.now += 2_001;
    expect((await world.call(owner, 'GET', sourcePath)).status).toBe(200);

    const previewPath = `/api/boards/${board.id}/preview`;
    world.clock.now += 10_001;
    const bad = await world.call(owner, 'PUT', previewPath, Buffer.from('not an image'), { 'content-type': 'image/png' });
    expect(bad.status).toBe(400);
    const burned = await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' });
    expect(burned.status).toBe(429);
    world.clock.now += 10_001;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
  });

  it('stops serving an image 24 hours after its upload', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const previewPath = `/api/boards/${board.id}/preview`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
    world.clock.now += 24 * 60 * 60_000 - 1;
    expect((await world.call(owner, 'GET', previewPath)).status).toBe(200);
    world.clock.now += 2;
    expect((await world.call(owner, 'GET', previewPath)).status).toBe(404);
  });

  it('rejects guests, join-code sessions, and all token headers on all preview routes', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const guest = world.guest(board.id, owner);
    const routes = [
      ['GET', `/api/boards/${board.id}/preview-source`],
      ['PUT', `/api/boards/${board.id}/preview`],
      ['GET', `/api/boards/${board.id}/preview`],
    ] as const;
    for (const [method, route] of routes) {
      const response = await world.call(guest, method, route, method === 'PUT' ? png() : undefined, method === 'PUT' ? { 'content-type': 'image/png' } : {});
      expect(response.status).toBe(403);
    }
    const tokenHeaders = [
      ['authorization', 'Bearer token'], ['x-api-key', 'ai-key'], ['x-mcp-token', 'mcp-token'],
      ['x-oauth-token', 'oauth-token'], ['x-agent-token', 'agent-token'], ['x-tabula-token', 'tabula-token'],
      ['mcp-session-id', 'session-token'],
    ];
    for (const [method, route] of routes) {
      for (const [name, value] of tokenHeaders) {
        const response = await world.call(null, method, route, method === 'PUT' ? png() : undefined, {
          [name]: value,
          ...(method === 'PUT' ? { 'content-type': 'image/png' } : {}),
        });
        expect(response.status, `${name} on ${route}`).toBe(403);
      }
    }
  });

  it('requires CSRF and returns 402 for writes in a read-only workspace', async () => {
    const csrfWorld = await setup();
    worlds.push(csrfWorld);
    const owner = csrfWorld.account('owner');
    const board = csrfWorld.newBoard(owner);
    const noCsrf = await csrfWorld.call(owner, 'PUT', `/api/boards/${board.id}/preview`, png(), { 'content-type': 'image/png' }, false);
    expect(noCsrf.status).toBe(403);
    expect(JSON.parse(noCsrf.text).error).toBe('csrf');

    const readOnlyWorld = await setup({ readOnly: true });
    worlds.push(readOnlyWorld);
    const readOnlyOwner = readOnlyWorld.account('owner');
    const readOnlyBoard = readOnlyWorld.newBoard(readOnlyOwner);
    const response = await readOnlyWorld.call(readOnlyOwner, 'PUT', `/api/boards/${readOnlyBoard.id}/preview`, png(), { 'content-type': 'image/png' });
    expect(response.status).toBe(402);
    expect(JSON.parse(response.text).error).toBe('read_only');
  });

  it('rejects missing or lying lengths, streamed over-cap bytes, wrong types, SVG, GIF, and animation', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const previewPath = `/api/boards/${board.id}/preview`;
    const headers = { cookie: owner.cookie, 'x-tabula': '1', 'content-type': 'image/png' };

    const missingLength = await world.streamed('PUT', previewPath, Buffer.alloc(0), headers);
    expect(missingLength.status).toBe(411);
    world.clock.now += 10_001;
    const lyingLength = await world.streamed('PUT', previewPath, png(), { ...headers, 'content-length': String(png().length + 3) });
    expect(lyingLength.status).toBe(400);
    world.clock.now += 10_001;
    const overStreamed = await world.streamed('PUT', previewPath, Buffer.alloc(MAX_PREVIEW_BYTES + 1), { ...headers, 'content-length': '1' });
    expect(overStreamed.status).toBe(413);

    const invalidImages: Array<[Buffer, string]> = [
      [png(), 'image/jpeg'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>'), 'image/png'],
      [Buffer.from('GIF89a'), 'image/png'],
      [animatedPng(), 'image/png'],
      [animatedWebp(), 'image/webp'],
    ];
    for (const [bytes, type] of invalidImages) {
      world.clock.now += 10_001;
      const response = await world.call(owner, 'PUT', previewPath, bytes, { 'content-type': type });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(fs.existsSync(path.join(world.root, 'previews-dev'))).toBe(false);
  });

  it('limits board, user, and workspace upload rates with the injected clock', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const image = png();
    const pathFor = (id: string) => `/api/boards/${id}/preview`;
    expect((await world.call(owner, 'PUT', pathFor(board.id), image, { 'content-type': 'image/png' })).status).toBe(204);
    expect((await world.call(owner, 'PUT', pathFor(board.id), image, { 'content-type': 'image/png' })).status).toBe(429);
    world.clock.now += 10_001;
    expect((await world.call(owner, 'PUT', pathFor(board.id), image, { 'content-type': 'image/png' })).status).toBe(204);

    const hourlyUser = world.account('owner');
    for (let index = 0; index < 60; index++) {
      const another = world.newBoard(owner, `hourly_board_${index}`);
      expect((await world.call(hourlyUser, 'PUT', pathFor(another.id), image, { 'content-type': 'image/png' })).status).toBe(204);
    }
    const hourlyOver = world.newBoard(owner, 'hourly_board_over');
    expect((await world.call(hourlyUser, 'PUT', pathFor(hourlyOver.id), image, { 'content-type': 'image/png' })).status).toBe(429);

    const fullDayImage = png(Buffer.alloc(MAX_PREVIEW_BYTES - 57));
    expect(fullDayImage.length).toBe(MAX_PREVIEW_BYTES);
    world.clock.now += 24 * 60 * 60_000;
    const dailyAccounts = Array.from({ length: 9 }, () => world.account('owner'));
    for (let index = 0; index < 512; index++) {
      const dailyBoard = world.newBoard(owner, `daily_board_${index}`);
      const response = await world.call(dailyAccounts[index % dailyAccounts.length], 'PUT', pathFor(dailyBoard.id), fullDayImage, { 'content-type': 'image/png' });
      expect(response.status, `daily upload ${index}`).toBe(204);
    }
    const dailyOver = world.newBoard(owner, 'daily_board_over');
    const limited = await world.call(dailyAccounts[0], 'PUT', pathFor(dailyOver.id), fullDayImage, { 'content-type': 'image/png' });
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.text).error).toBe('rate_limited');
    expect(fs.existsSync(path.join(world.root, 'previews-dev', `${crypto.createHash('sha256').update(dailyOver.id).digest('hex')}.img`))).toBe(false);
  }, 120_000);

  it('refuses a path-traversal board id before touching the store', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const response = await world.call(owner, 'GET', '/api/boards/%2F..%2Fpreview/preview');
    expect(response.status).toBe(404);
    expect(fs.existsSync(path.join(world.root, 'previews-dev'))).toBe(false);
  });
});
