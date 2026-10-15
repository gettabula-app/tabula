import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { MAX_PREVIEW_BYTES, validatePreviewImage } from '../server/preview-image.mjs';
import { createPreviewStore } from '../server/preview-store.mjs';
import { get as getPreviewRevision, observePreviewChanges } from '../server/preview-rev.mjs';
import { isBackupPath } from '../server/backup.mjs';
import { budget } from './wait-budget';

type Account = { user: NonNullable<ReturnType<ReturnType<typeof openDirectory>['createUser']>>; cookie: string };
type Reply = { status: number; headers: Headers; text: string; bytes: Buffer };
type Room = { doc: Y.Doc; dirty: boolean };
type World = Awaited<ReturnType<typeof setup>>;

const worlds: World[] = [];
let serial = 0;

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + budget(1000);
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, budget(5)));
  }
}

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

async function setup({ previews = true, readOnly = false, previewMaxBytes, previewStore: overrideStore }: { previews?: boolean; readOnly?: boolean; previewMaxBytes?: number; previewStore?: ReturnType<typeof createPreviewStore> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-preview-'));
  const clock = { now: Date.UTC(2026, 9, 15, 12) };
  const config = loadConfig({
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'workspace-owner@example.test',
    TABULA_MAIL: 'file',
    TABULA_JOIN_CODES: 'on',
    DATA_DIR: root,
    ...(!previews ? { TABULA_PREVIEWS: '0' } : {}),
  }, () => {});
  const directory = openDirectory(path.join(root, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} }, now: () => clock.now });
  const previewStore = previews ? overrideStore ?? createPreviewStore({ dataDir: root, now: () => clock.now, maxBytes: previewMaxBytes, log: () => {} }) : null;
  const rooms = new Map<string, Room & { stopPreviewObserver?: () => void }>();
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
    write(name: string, _origin: unknown, fn: (doc: Y.Doc) => unknown) {
      writes++;
      const entry = rooms.get(name) ?? room(name);
      let result: unknown;
      entry.doc.transact(() => { result = fn(entry.doc); });
      return result;
    },
  };
  const api = createApi({
    directory, auth, config, roomExists: roomAccess.exists, events: new EventEmitter(),
    now: () => clock.now,
    cloud: readOnly ? { limits: () => ({ readOnly: true }) } as never : null,
    dataDir: root, mailer: { send: async () => {} }, roomAccess: roomAccess as never, previewStore: previewStore as never,
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
    const entry: Room & { stopPreviewObserver?: () => void } = { doc, dirty: false };
    doc.on('update', () => { entry.dirty = true; });
    if (previewStore) entry.stopPreviewObserver = observePreviewChanges(doc, boardId, { unlink: (id: string) => previewStore.unlink(id), now: () => clock.now, log: () => {} });
    rooms.set(boardId, entry);
    return entry;
  }

  function unload(boardId: string) {
    const entry = rooms.get(boardId);
    if (!entry) return;
    fs.writeFileSync(path.join(root, `${boardId}.yjs`), Buffer.from(Y.encodeStateAsUpdate(entry.doc)), { mode: 0o600 });
    entry.stopPreviewObserver?.();
    entry.doc.destroy();
    rooms.delete(boardId);
  }

  async function call(who: { cookie: string } | null, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}, csrf = true): Promise<Reply> {
    const requestHeaders: Record<string, string> = {
      ...(who ? { cookie: who.cookie } : {}),
      ...(csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? { 'x-tabula': '1' } : {}),
      ...headers,
    };
    if (method === 'PUT' && urlPath.endsWith('/preview') && !Object.keys(headers).some((name) => name.toLowerCase() === 'x-preview-rev')) {
      const boardId = urlPath.split('/').at(-2);
      if (boardId) requestHeaders['x-preview-rev'] = String(getPreviewRevision(boardId));
    }
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
    for (const entry of rooms.values()) { entry.stopPreviewObserver?.(); entry.doc.destroy(); }
    rooms.clear();
    directory.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { account, api, base, call, clock, close, config, directory, guest, newBoard, room, roomAccess, previewStore, root, streamed, unload, writes: () => writes, throwawayReads: () => throwawayReads, isLoaded: (id: string) => rooms.has(id) };
}

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

describe('board previews', () => {
  it('keeps preview routes absent with the kill switch and creates no store directory', async () => {
    const world = await setup({ previews: false });
    worlds.push(world);
    expect(world.config.previews).toBe(false);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    for (const [method, tail] of [['GET', 'preview-source'], ['PUT', 'preview'], ['GET', 'preview']] as const) {
      const response = await world.call(owner, method, `/api/boards/${board.id}/${tail}`, method === 'PUT' ? png() : undefined, method === 'PUT' ? { 'content-type': 'image/png' } : {});
      expect(response.status).toBe(404);
    }
    expect(fs.existsSync(path.join(world.root, 'previews'))).toBe(false);
  });

  it('enables previews by default and exposes the workspace setting to the client', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    expect(world.config.previews).toBe(true);
    expect((await world.call(owner, 'GET', '/api/me')).text).toContain('"boardPreviews":true');
    expect(JSON.parse((await world.call(owner, 'GET', '/api/admin/board-previews')).text)).toEqual({ enabled: true, locked: false, setting: null });
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

    const storeDir = path.join(world.root, 'previews');
    const boardHash = crypto.createHash('sha256').update(board.id).digest('hex');
    const filenames = fs.readdirSync(storeDir).sort();
    expect(filenames).toEqual([`${boardHash}.img`, `${boardHash}.json`]);
    expect((fs.statSync(storeDir).mode & 0o777)).toBe(0o700);
    for (const name of filenames) expect((fs.statSync(path.join(storeDir, name)).mode & 0o777)).toBe(0o600);
    const metadata = JSON.parse(fs.readFileSync(path.join(storeDir, `${boardHash}.json`), 'utf8'));
    expect(metadata).toEqual({
      boardId: board.id, type: 'image/png', width: 480, height: 300, bytes: image.length,
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

  it('leaves the stored picture untouched when preview-source is fetched', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const previewPath = `/api/boards/${board.id}/preview`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
    expect((await world.call(owner, 'GET', previewPath)).status).toBe(200);
    expect((await world.call(owner, 'GET', `${previewPath}-source`)).status).toBe(200);
    expect((await world.call(owner, 'GET', previewPath)).status).toBe(200);
    expect(world.previewStore!.read(board.id)).not.toBeNull();
  });

  it('turns preview routes off workspace-wide and keeps the admin switch audited', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const admin = world.account('admin');
    const member = world.account();
    const board = world.newBoard(owner);
    const previewPath = `/api/boards/${board.id}/preview`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);

    expect((await world.call(member, 'GET', '/api/admin/board-previews')).status).toBe(403);
    expect((await world.call(member, 'PUT', '/api/admin/board-previews', { enabled: false })).status).toBe(403);
    const off = await world.call(admin, 'PUT', '/api/admin/board-previews', { enabled: false });
    expect(off.status).toBe(200);
    expect(JSON.parse(off.text)).toEqual({ enabled: false, locked: false, setting: false });
    expect((await world.call(owner, 'GET', `/api/boards/${board.id}/preview-source`)).status).toBe(404);
    expect((await world.call(owner, 'GET', previewPath)).status).toBe(404);
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(404);
    expect((await world.call(owner, 'DELETE', previewPath)).status).toBe(404);
    expect((await world.call(owner, 'GET', '/api/me')).text).not.toContain('"boardPreviews":true');
    expect(world.directory.listAudit(10).map((row) => row.action)).toContain('boardPreviews.disabled');
    expect(world.previewStore!.read(board.id)).not.toBeNull();
  });

  it('lets only a board owner or workspace admin remove a preview and audits the action', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const admin = world.account('admin');
    const editor = world.account();
    const viewer = world.account();
    const board = world.newBoard(owner);
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: editor.user.id, role: 'editor' });
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: viewer.user.id, role: 'viewer' });
    const previewPath = `/api/boards/${board.id}/preview`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);

    expect((await world.call(editor, 'DELETE', previewPath)).status).toBe(403);
    expect((await world.call(viewer, 'DELETE', previewPath)).status).toBe(403);
    expect((await world.call(world.guest(board.id, owner), 'DELETE', previewPath)).status).toBe(403);
    expect((await world.call(owner, 'DELETE', previewPath, undefined, { authorization: 'Bearer token' })).status).toBe(403);
    expect((await world.call(owner, 'DELETE', '/api/boards/preview_missing/preview')).status).toBe(404);

    const ownerRemove = await world.call(owner, 'DELETE', previewPath);
    expect(ownerRemove.status).toBe(204);
    expect(ownerRemove.headers.get('clear-site-data')).toBe('"cache"');
    expect(world.previewStore!.read(board.id)).toBeNull();
    world.clock.now += 10_001;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
    const adminRemove = await world.call(admin, 'DELETE', previewPath);
    expect(adminRemove.status).toBe(204);
    expect(world.directory.listAudit(10).filter((row) => row.action === 'board.preview.remove').map((row) => row.detail)).toEqual([
      { boardId: board.id, by: admin.user.id, reason: 'manual' },
      { boardId: board.id, by: owner.user.id, reason: 'manual' },
    ]);
    const logout = await world.call(owner, 'POST', '/api/auth/logout');
    expect(logout.headers.get('clear-site-data')).toBe('"cache"');
  });

  it('unlinks on an object deletion', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const room = world.room(board.id);
    room.doc.getMap('objects').set('connector', new Y.Map([['id', 'connector'], ['type', 'connector']]));
    const previewPath = `/api/boards/${board.id}/preview`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
    const before = getPreviewRevision(board.id);

    room.doc.getMap('objects').delete('connector');
    expect(getPreviewRevision(board.id)).toBeGreaterThan(before);
    await waitFor(() => world.previewStore!.read(board.id) === null, 'the deleted object preview to unlink');
  });

  it('unlinks when a note becomes private or an object becomes hidden', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const privateBoard = world.newBoard(owner);
    const privateRoom = world.room(privateBoard.id);
    const privateNote = new Y.Map([['id', 'note'], ['type', 'sticky'], ['text', 'Shared note']]);
    privateRoom.doc.getMap('objects').set('note', privateNote);
    const privatePath = `/api/boards/${privateBoard.id}/preview`;
    expect((await world.call(owner, 'PUT', privatePath, png(), { 'content-type': 'image/png' })).status).toBe(204);
    privateNote.set('privateStep', 'step-1');
    await waitFor(() => world.previewStore!.read(privateBoard.id) === null, 'the private note preview to unlink');

    world.clock.now += 10_001;
    const hiddenBoard = world.newBoard(owner);
    const hiddenRoom = world.room(hiddenBoard.id);
    const layer = new Y.Map([['id', 'frame'], ['type', 'frame'], ['text', 'Layer']]);
    hiddenRoom.doc.getMap('objects').set('frame', layer);
    const hiddenPath = `/api/boards/${hiddenBoard.id}/preview`;
    expect((await world.call(owner, 'PUT', hiddenPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
    layer.set('hidden', true);
    await waitFor(() => world.previewStore!.read(hiddenBoard.id) === null, 'the hidden object preview to unlink');
  });

  it('throttles text-edit unlinking to once per 30 seconds per board', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const room = world.room(board.id);
    const note = new Y.Map([['id', 'note'], ['type', 'sticky'], ['text', 'First']]);
    room.doc.getMap('objects').set('note', note);
    const previewPath = `/api/boards/${board.id}/preview`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);

    note.set('text', 'Second');
    await waitFor(() => world.previewStore!.read(board.id) === null, 'the first text edit preview to unlink');
    world.clock.now += 10_001;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
    const revision = getPreviewRevision(board.id);
    note.set('text', 'Third');
    expect(getPreviewRevision(board.id)).toBeGreaterThan(revision);
    expect(world.previewStore!.read(board.id)).not.toBeNull();
  });

  it('keeps a board without a picture when its owner turns previews off, even after the cache is cleared', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const editor = world.account();
    const outsider = world.account();
    const board = world.newBoard(owner);
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: editor.user.id, role: 'editor' });
    const previewPath = `/api/boards/${board.id}/preview`;
    const offPath = `${previewPath}-off`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);

    expect((await world.call(editor, 'PUT', offPath, { off: true })).status).toBe(403);
    expect((await world.call(outsider, 'GET', offPath)).status).toBeGreaterThanOrEqual(403);
    expect((await world.call(owner, 'PUT', offPath, { off: 'yes' })).status).toBe(400);
    expect((await world.call(owner, 'PUT', offPath, { off: true })).status).toBe(200);
    expect(JSON.parse((await world.call(owner, 'GET', offPath)).text)).toEqual({ off: true });
    expect(world.previewStore!.read(board.id)).toBeNull();
    expect((await world.call(owner, 'GET', previewPath)).status).toBe(404);
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(404);
    expect((await world.call(owner, 'GET', `${previewPath}-source`)).status).toBe(404);
    world.previewStore!.clear();
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(404);

    expect((await world.call(owner, 'PUT', offPath, { off: false })).status).toBe(200);
    world.clock.now += 10_001;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
  });

  it('unlinks once the throttle window is over when a text change fell inside it', () => {
    vi.useFakeTimers();
    try {
      const clock = { now: 1_000_000 };
      const doc = new Y.Doc();
      const note = new Y.Map<unknown>([['id', 'note'], ['type', 'sticky'], ['text', 'First']]);
      doc.getMap('objects').set('note', note);
      const unlink = vi.fn<(boardId: string) => void>();
      const stop = observePreviewChanges(doc, 'trailing_board', { unlink, now: () => clock.now });
      note.set('text', 'Second');
      expect(unlink).toHaveBeenCalledTimes(1);
      clock.now += 5_000;
      note.set('text', 'Third');
      expect(unlink).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(24_999);
      expect(unlink).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2);
      expect(unlink).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('watches a frame name and a connector label like text', () => {
    const doc = new Y.Doc();
    const objects = doc.getMap('objects');
    const frame = new Y.Map<unknown>([['id', 'frame'], ['type', 'frame'], ['name', 'Secret plan']]);
    const connector = new Y.Map<unknown>([['id', 'link'], ['type', 'connector'], ['label', 'Secret label']]);
    objects.set('frame', frame);
    objects.set('link', connector);
    const unlink = vi.fn<(boardId: string) => void>();
    const stop = observePreviewChanges(doc, 'label_board', { unlink, now: () => 5_000_000 });
    frame.set('name', '');
    expect(unlink).toHaveBeenCalledTimes(1);
    stop();
    const other = vi.fn<(boardId: string) => void>();
    const stopOther = observePreviewChanges(doc, 'label_board_connector', { unlink: other, now: () => 5_000_000 });
    connector.set('label', '');
    expect(other).toHaveBeenCalledTimes(1);
    expect(getPreviewRevision('label_board_connector')).toBe(1);
    stopOther();
  });

  it('observes MCP roomAccess writes and does not treat persisted state as a new edit', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const room = world.room(board.id);
    const note = new Y.Map([['id', 'note'], ['type', 'sticky'], ['text', 'Shared']]);
    room.doc.getMap('objects').set('note', note);
    const previewPath = `/api/boards/${board.id}/preview`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);

    world.roomAccess.write(board.id, 'mcp', (doc: Y.Doc) => {
      (doc.getMap('objects').get('note') as Y.Map<unknown>).set('privateStep', 'step-2');
    });
    await waitFor(() => world.previewStore!.read(board.id) === null, 'the MCP private change preview to unlink');
    expect(world.writes()).toBe(1);

    const persisted = new Y.Doc();
    persisted.getMap('objects').set('private-note', new Y.Map([['id', 'private-note'], ['type', 'sticky'], ['privateStep', 'step-3']]));
    const unlink = vi.fn<(boardId: string) => void>();
    const stop = observePreviewChanges(persisted, 'preview_initial_load', { unlink, now: () => world.clock.now });
    expect(unlink).not.toHaveBeenCalled();
    stop();
    persisted.destroy();
  });

  it('rejects stale or missing preview revisions without storing pixels', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const room = world.room(board.id);
    const note = new Y.Map([['id', 'note'], ['type', 'sticky'], ['text', 'Shared']]);
    room.doc.getMap('objects').set('note', note);
    const previewPath = `/api/boards/${board.id}/preview`;

    const source = await world.call(owner, 'GET', `/api/boards/${board.id}/preview-source`);
    expect(source.status).toBe(200);
    const oldRevision = (JSON.parse(source.text) as { rev: number }).rev;
    note.set('privateStep', 'step-1');
    const stale = await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png', 'x-preview-rev': String(oldRevision) });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.text).error).toBe('preview_stale');
    expect(world.previewStore!.read(board.id)).toBeNull();

    world.clock.now += 10_001;
    const freshSource = await world.call(owner, 'GET', `/api/boards/${board.id}/preview-source`);
    const newRevision = (JSON.parse(freshSource.text) as { rev: number }).rev;
    expect(newRevision).toBeGreaterThan(oldRevision);
    const fresh = await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png', 'x-preview-rev': String(newRevision) });
    expect(fresh.status).toBe(204);
    expect(world.previewStore!.read(board.id)).not.toBeNull();

    const missingBoard = world.newBoard(owner);
    const noRevision = await world.streamed('PUT', `/api/boards/${missingBoard.id}/preview`, png(), {
      cookie: owner.cookie,
      'x-tabula': '1',
      'content-type': 'image/png',
      'content-length': String(png().length),
    });
    expect(noRevision.status).toBe(409);
    expect(JSON.parse(noRevision.text).error).toBe('preview_stale');
    expect(world.previewStore!.read(missingBoard.id)).toBeNull();
  });

  it('returns 503 for a failed cache write while board room writes still save', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const board = world.newBoard(owner);
    const put = vi.spyOn(world.previewStore!, 'put').mockImplementation(() => { throw new Error('ENOSPC'); });
    const response = await world.call(owner, 'PUT', `/api/boards/${board.id}/preview`, png(), { 'content-type': 'image/png' });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.text).error).toBe('preview_unavailable');

    world.roomAccess.write(board.id, 'mcp', (doc: Y.Doc) => {
      doc.getMap('objects').set('saved', new Y.Map([['id', 'saved'], ['type', 'sticky'], ['text', 'Still saved']]));
    });
    expect(world.roomAccess.read(board.id, (doc: Y.Doc) => doc.getMap('objects').has('saved'))).toBe(true);
    expect(world.writes()).toBe(1);
    put.mockRestore();
  });

  it('evicts the oldest preview when the total cache byte cap would be exceeded', async () => {
    const world = await setup();
    worlds.push(world);
    const bytes = png();
    const image = validatePreviewImage(bytes, 'image/png');
    if (!image.ok) throw new Error('test PNG was invalid');
    const validatedImage = image as { ok: true; type: string; width: number; height: number };
    const ids = ['evict_0000', 'evict_0001', 'evict_0002'];
    const metadataBytes = Buffer.byteLength(JSON.stringify({
      boardId: ids[0], type: validatedImage.type, width: validatedImage.width, height: validatedImage.height, bytes: bytes.length,
      uploadedBy: 'owner', at: world.clock.now,
      etag: `"${crypto.createHash('sha256').update(bytes).digest('hex')}"`,
    }));
    const recordBytes = bytes.length + metadataBytes;
    const store = createPreviewStore({ dataDir: world.root, now: () => world.clock.now, maxBytes: recordBytes * 2, log: () => {} });

    for (const id of ids) {
      store.put({ boardId: id, bytes, image: validatedImage, uploadedBy: 'owner' });
      world.clock.now++;
    }
    expect(store.read(ids[0])).toBeNull();
    expect(store.read(ids[1])).not.toBeNull();
    expect(store.read(ids[2])).not.toBeNull();
    expect(store.list()).toEqual({ count: 2, bytes: recordBytes * 2 });
  });

  it('sweeps deleted-board files, orphans, and old temp files while backup allowlists exclude previews', async () => {
    const world = await setup();
    worlds.push(world);
    const bytes = png();
    const image = validatePreviewImage(bytes, 'image/png');
    if (!image.ok) throw new Error('test PNG was invalid');
    const validatedImage = image as { ok: true; type: string; width: number; height: number };
    const store = world.previewStore!;
    store.put({ boardId: 'sweep_live', bytes, image: validatedImage, uploadedBy: 'owner' });
    store.put({ boardId: 'sweep_deleted', bytes, image: validatedImage, uploadedBy: 'owner' });
    const orphan = `${crypto.createHash('sha256').update('sweep_orphan').digest('hex')}.img`;
    fs.writeFileSync(path.join(store.directory, orphan), Buffer.from('orphan'));
    const temporary = '.preview-00000000-0000-0000-0000-000000000000.tmp';
    const temporaryPath = path.join(store.directory, temporary);
    fs.writeFileSync(temporaryPath, Buffer.from('left over'));
    const oldTime = new Date(world.clock.now - 2 * 60 * 60_000);
    fs.utimesSync(temporaryPath, oldTime, oldTime);

    await store.sweep((id: string) => id === 'sweep_live');
    expect(store.read('sweep_live')).not.toBeNull();
    expect(store.read('sweep_deleted')).toBeNull();
    expect(fs.existsSync(path.join(store.directory, orphan))).toBe(false);
    expect(fs.existsSync(temporaryPath)).toBe(false);
    expect(store.list().count).toBe(1);
    expect(isBackupPath(`previews/${orphan}`)).toBe(false);
    expect(isBackupPath('directory.sqlite')).toBe(true);
    store.clear();
    expect(store.list()).toEqual({ count: 0, bytes: 0 });
  });

  it('treats a sidecar without its board id as an absent cache entry', async () => {
    const world = await setup();
    worlds.push(world);
    const store = world.previewStore!;
    const bytes = png();
    const image = validatePreviewImage(bytes, 'image/png');
    if (!image.ok) throw new Error('test PNG was invalid');
    store.put({ boardId: 'sidecar_board', bytes, image, uploadedBy: 'owner' });
    const name = `${crypto.createHash('sha256').update('sidecar_board').digest('hex')}.json`;
    const sidecar = path.join(store.directory, name);
    const metadata = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    delete metadata.boardId;
    fs.writeFileSync(sidecar, JSON.stringify(metadata));

    expect(store.read('sidecar_board')).toBeNull();
    expect((await store.sweep()).removed).toBeGreaterThan(0);
    expect(store.list().count).toBe(0);
  });

  it('removes preview files on board delete and before restoring a board from trash', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const admin = world.account('admin');
    const board = world.newBoard(owner);
    const previewPath = `/api/boards/${board.id}/preview`;
    expect((await world.call(owner, 'PUT', previewPath, png(), { 'content-type': 'image/png' })).status).toBe(204);
    expect((await world.call(owner, 'DELETE', `/api/boards/${board.id}`)).status).toBe(204);
    expect(world.previewStore!.read(board.id)).toBeNull();

    const bytes = png();
    const image = validatePreviewImage(bytes, 'image/png');
    if (!image.ok) throw new Error('test PNG was invalid');
    world.previewStore!.put({ boardId: board.id, bytes, image, uploadedBy: owner.user.id });
    const restored = await world.call(admin, 'POST', `/api/admin/boards/${board.id}/restore`);
    expect(restored.status).toBe(200);
    expect(world.previewStore!.read(board.id)).toBeNull();
    expect((await world.call(owner, 'GET', previewPath)).status).toBe(404);
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
    const headers = { cookie: owner.cookie, 'x-tabula': '1', 'content-type': 'image/png', 'x-preview-rev': String(getPreviewRevision(board.id)) };

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
    expect(fs.existsSync(path.join(world.root, 'previews'))).toBe(false);
  });

  it('limits board, user, and workspace upload rates with the injected clock', async () => {
    const world = await setup({ previewMaxBytes: 1024 * 1024 });
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
    const dailyAccounts = Array.from({ length: 86 }, () => world.account('owner'));
    for (let index = 0; index < 5120; index++) {
      const dailyBoard = world.newBoard(owner, `daily_board_${index}`);
      const response = await world.call(dailyAccounts[index % dailyAccounts.length], 'PUT', pathFor(dailyBoard.id), fullDayImage, { 'content-type': 'image/png' });
      expect(response.status, `daily upload ${index}`).toBe(204);
    }
    const dailyOver = world.newBoard(owner, 'daily_board_over');
    const limited = await world.call(world.account('owner'), 'PUT', pathFor(dailyOver.id), fullDayImage, { 'content-type': 'image/png' });
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.text).error).toBe('rate_limited');
    expect(fs.existsSync(path.join(world.root, 'previews', `${crypto.createHash('sha256').update(dailyOver.id).digest('hex')}.img`))).toBe(false);
  }, budget(240_000));

  it('refuses a path-traversal board id before touching the store', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.account('owner');
    const response = await world.call(owner, 'GET', '/api/boards/%2F..%2Fpreview/preview');
    expect(response.status).toBe(404);
    expect(fs.existsSync(path.join(world.root, 'previews'))).toBe(false);
  });
});
