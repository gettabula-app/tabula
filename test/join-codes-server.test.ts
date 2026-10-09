import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { createHarness, type Account, until } from './mcp-harness';
import { makePng } from './image-fixtures';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

const h = createHarness({
  accounts: true,
  settings: { JOIN_CODES: 'on', CHAT: 'on', MCP: 'on', ASSET_BOARD_QUOTA: '1000000' },
});
let owner: Account;
let editor: Account;
let commenter: Account;
let board: string;
let otherBoard: string;
let ipSeq = 0;
const nextIp = () => `198.51.100.${(++ipSeq % 240) + 1}`;

type JoinReply = { status: number; body: any; cookie?: string; setCookie?: string };
async function join(code: string, name = 'Guest', ip = nextIp()): Promise<JoinReply> {
  const res = await h.api(undefined, 'POST', '/api/join', { code, name }, { 'x-forwarded-for': ip });
  const setCookie = res.headers.getSetCookie()[0];
  return { status: res.status, body: res.body, cookie: setCookie?.split(';')[0], setCookie };
}

async function newCode(cookie: string, opts: { role?: 'commenter' | 'editor'; expiresInHours?: number; maxUses?: number } = {}) {
  return h.api(cookie, 'POST', `/api/boards/${board}/join-codes`, { role: 'commenter', ...opts });
}

async function newCodeFor(cookie: string, boardId: string, opts: { role?: 'commenter' | 'editor'; expiresInHours?: number; maxUses?: number } = {}) {
  return h.api(cookie, 'POST', `/api/boards/${boardId}/join-codes`, { role: 'commenter', ...opts });
}

async function upload(cookie: string, boardId: string, bytes: Buffer) {
  const res = await fetch(`${h.base}/api/boards/${boardId}/assets`, {
    method: 'POST',
    headers: { cookie, 'x-tabula': '1', 'content-type': 'image/png' },
    body: new Uint8Array(bytes),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const rawSockets = new Set<WebSocket>();
function rawRoom(boardId: string, cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/sync/${boardId}`, { headers: { Origin: h.base, Cookie: cookie } });
  rawSockets.add(ws);
  ws.on('error', () => undefined);
  const message = new Promise<void>((resolve) => ws.once('message', () => resolve()));
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  return { ws, message, closed };
}

function rawChat(cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/chat`, { headers: { Origin: h.base, Cookie: cookie } });
  rawSockets.add(ws);
  ws.on('error', () => undefined);
  const rejected = new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
  return { ws, rejected };
}

afterEach(() => {
  h.closeProviders();
  for (const ws of rawSockets) ws.terminate();
  rawSockets.clear();
});

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const team = await h.newTeam(owner.cookie, 'Join codes');
  editor = await h.joinTeam(owner.cookie, team.id);
  commenter = await h.joinTeam(owner.cookie, team.id);
  board = await h.newBoard(owner.cookie);
  otherBoard = await h.newBoard(owner.cookie);
  await h.share(owner.cookie, board, editor.user.id, 'editor');
  await h.share(owner.cookie, board, commenter.user.id, 'commenter');
});

afterAll(async () => h.cleanup());

describe('join-code creation and storage', () => {
  it('creates a hashed 8-character code with role, default expiry and use limit; only editors can manage it', async () => {
    const made = await newCode(editor.cookie);
    expect(made.status).toBe(201);
    expect(made.body.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(made.body).toMatchObject({ role: 'commenter', maxUses: 100, uses: 0 });
    expect(made.body.expiresAt - made.body.createdAt).toBe(3 * 60 * 60 * 1000);
    const digest = crypto.createHash('sha256').update(made.body.code).digest('hex');
    const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      const stored = db.prepare('SELECT code_hash FROM join_codes WHERE id = ?').get(made.body.id) as { code_hash: string };
      expect(stored.code_hash).toBe(digest);
      expect(stored.code_hash).not.toBe(made.body.code);
    } finally {
      db.close();
    }
    const listed = await h.api(editor.cookie, 'GET', `/api/boards/${board}/join-codes`);
    expect(listed.body).toEqual([{
      id: made.body.id, role: 'commenter', createdAt: made.body.createdAt, expiresAt: made.body.expiresAt,
      maxUses: 100, uses: 0, revokedAt: null,
    }]);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.code);
    expect((await newCode(commenter.cookie)).status).toBe(403);
    expect([403, 404]).toContain((await h.api(editor.cookie, 'POST', `/api/boards/${otherBoard}/join-codes`, { role: 'editor' })).status);
  });

  it('accepts only commenter or editor, caps expiry at 24 hours and validates use limits', async () => {
    const made = await newCode(owner.cookie, { role: 'editor', expiresInHours: 24, maxUses: 7 });
    expect(made.status).toBe(201);
    expect(made.body.expiresAt - made.body.createdAt).toBe(24 * 60 * 60 * 1000);
    expect(made.body).toMatchObject({ role: 'editor', maxUses: 7 });
    expect((await newCode(owner.cookie, { role: 'viewer' as 'editor' })).status).toBe(400);
    expect((await h.api(owner.cookie, 'POST', `/api/boards/${board}/join-codes`, { role: 'editor', expiresInHours: 25 })).status).toBe(400);
    expect((await h.api(owner.cookie, 'POST', `/api/boards/${board}/join-codes`, { role: 'editor', maxUses: 1001 })).status).toBe(400);
  });
});

describe('joining, expiry and revocation', () => {
  it('sanitises the display name, issues a board-only cookie, and records use without the code', async () => {
    const made = await newCode(owner.cookie, { role: 'commenter' });
    expect((await join(made.body.code, ' \u200b\n')).status).toBe(400);
    expect((await join(made.body.code, '🙂'.repeat(41))).status).toBe(400);
    const response = await join(made.body.code, '  Jose\u0301\u200b   Visitor\n');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ boardId: board, role: 'commenter', name: 'José Visitor' });
    expect(response.body.expiresAt).toBe(made.body.expiresAt);
    expect((await join(made.body.code, '🙂'.repeat(40))).body.name).toBe('🙂'.repeat(40));
    expect(response.cookie).toMatch(/^tabula_session=[A-Za-z0-9_-]+$/);
    expect(response.setCookie).toContain('HttpOnly');
    expect(response.setCookie).toContain('SameSite=Lax');
    expect(response.setCookie).toContain('Path=/');
    expect(response.setCookie).not.toMatch(/Domain/i);
    expect(response.body).not.toHaveProperty('email');
    const audit = await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=200&action=join-code.');
    expect(audit.body.entries.map((entry: any) => entry.action)).toContain('join-code.used');
    expect(audit.body.entries.map((entry: any) => entry.action)).toContain('join-code.created');
    expect(JSON.stringify(audit.body)).not.toContain(made.body.code);
  });

  it('uses the same generic error for wrong, expired, exhausted and revoked codes, and revoke closes an open socket', async () => {
    const expired = await newCode(owner.cookie);
    const revoked = await newCode(owner.cookie);
    const exhausted = await newCode(owner.cookie, { maxUses: 1 });
    const active = await newCode(owner.cookie, { role: 'editor' });
    const first = await join(exhausted.body.code);
    expect(first.status).toBe(201);

    const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      db.prepare('UPDATE join_codes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.body.id);
    } finally {
      db.close();
    }
    expect((await h.api(owner.cookie, 'DELETE', `/api/boards/${board}/join-codes/${revoked.body.id}`)).status).toBe(204);
    const validGuest = await join(active.body.code);
    const socket = rawRoom(board, validGuest.cookie!);
    await socket.message;
    expect((await h.api(owner.cookie, 'DELETE', `/api/boards/${board}/join-codes/${active.body.id}`)).status).toBe(204);
    expect(await socket.closed).toBe(4410);

    const wrongReply = await join('22222222');
    const wrongLengthReply = await join('ABCDE');
    const tooLongReply = await join('A'.repeat(33));
    const expiredReply = await join(expired.body.code);
    const exhaustedReply = await join(exhausted.body.code);
    const revokedReply = await join(revoked.body.code);
    expect([wrongReply.status, wrongReply.body]).toEqual([404, expiredReply.body]);
    expect([wrongLengthReply.status, wrongLengthReply.body]).toEqual([404, expiredReply.body]);
    expect([tooLongReply.status, tooLongReply.body]).toEqual([404, expiredReply.body]);
    expect([expiredReply.status, expiredReply.body]).toEqual([404, exhaustedReply.body]);
    expect([exhaustedReply.status, exhaustedReply.body]).toEqual([404, revokedReply.body]);
    expect(wrongReply.body).toEqual({ error: 'invalid_join_code', message: 'This join code is not valid. Ask the board owner for a new one.' });

    const audit = await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=200&action=join-code.');
    expect(audit.body.entries.map((entry: any) => entry.action)).toContain('join-code.revoked');
    expect(JSON.stringify(audit.body)).not.toContain(active.body.code);
  });

  it('rate limits by source address and by code', async () => {
    const source = '203.0.113.40';
    let last;
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 20; i++) {
      const code = `${alphabet[Math.floor(i / alphabet.length)]}${alphabet[i % alphabet.length]}AAAAAA`;
      last = await join(code, 'Guest', source);
      expect(last.status).toBe(404);
    }
    expect((await join('XYABCDEFG', 'Guest', source)).status).toBe(429);

    let byCode;
    for (let i = 0; i < 5; i++) byCode = await join('BBBBBBBB', 'Guest', nextIp());
    expect(byCode!.status).toBe(404);
    expect((await join('BBBBBBBB', 'Guest', nextIp())).status).toBe(429);
  });
});

describe('guest scope and role enforcement', () => {
  it('refuses every unrelated API and MCP request while preserving public config', async () => {
    const made = await newCode(owner.cookie, { role: 'editor' });
    const guest = await join(made.body.code);
    const cookie = guest.cookie!;
    expect((await h.api(cookie, 'GET', '/api/config')).body).toEqual({ authEnabled: true, images: true, joinCodes: true });
    for (const [method, route] of [
      ['GET', '/api/boards'],
      ['GET', `/api/boards/${otherBoard}/versions`],
      ['GET', '/api/admin/audit'],
      ['POST', '/api/admin/audit'],
      ['GET', '/api/chat/channels'],
      ['GET', '/api/ai/config'],
      ['GET', '/api/health'],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/join'],
    ] as const) {
      const response = await h.api(cookie, method, route, method === 'POST' ? {} : undefined);
      expect([403, 404]).toContain(response.status);
    }
    const mcp = await fetch(`${h.base}/mcp`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(mcp.status).toBe(403);
    expect(await rawChat(cookie).rejected).toBe(403);
    const wrongBoard = rawRoom(otherBoard, cookie);
    expect(await wrongBoard.closed).toBe(4403);

    const another = await newCode(owner.cookie);
    expect((await h.api(cookie, 'POST', '/api/join', { code: another.body.code, name: 'Second board' })).status).toBe(403);
    const listed = await h.api(owner.cookie, 'GET', `/api/boards/${board}/join-codes`);
    expect(listed.body.find((code: any) => code.id === another.body.id).uses).toBe(0);
  });

  it('lets an editor guest edit only the granted board and upload within its image quota', async () => {
    const made = await newCode(owner.cookie, { role: 'editor' });
    const guest = await join(made.body.code);
    const guestConn = h.connect(board, guest.cookie);
    const ownerConn = h.connect(board, owner.cookie);
    await Promise.all([guestConn.synced(), ownerConn.synced()]);
    guestConn.doc.getMap('objects').set('join-code-write', { text: 'hello' });
    await until(() => ownerConn.doc.getMap('objects').has('join-code-write'));

    const bytes = makePng();
    const added = await upload(guest.cookie!, board, bytes);
    expect(added.status).toBe(201);
    expect((await h.api(guest.cookie, 'GET', `/api/boards/${board}/versions`)).status).toBe(200);
    const read = await fetch(`${h.base}/api/boards/${board}/assets/${added.body.hash}`, { headers: { cookie: guest.cookie! } });
    expect(read.status).toBe(200);
    expect((await read.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const otherUpload = await upload(guest.cookie!, otherBoard, bytes);
    expect(otherUpload.status).toBe(403);
    const claim = await h.api(guest.cookie, 'POST', `/api/boards/${board}/assets/claim`, { hash: added.body.hash });
    expect(claim.status).toBe(403);

    const exhaustedBoard = await h.newBoard(owner.cookie);
    const another = await newCodeFor(owner.cookie, exhaustedBoard, { role: 'editor' });
    const cappedGuest = await join(another.body.code);
    const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      db.prepare('INSERT INTO assets (board_id, hash, mime, bytes, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(exhaustedBoard, 'f'.repeat(64), 'image/png', 1_000_000, 1, 1, 'fixture', Date.now());
    } finally {
      db.close();
    }
    const overQuota = await upload(cappedGuest.cookie!, exhaustedBoard, bytes);
    expect(overQuota.status).toBe(402);
    expect(overQuota.body.error).toBe('storage_full');
  });

  it('gives commenters read and comment-room access, but not board writes or uploads', async () => {
    const made = await newCode(owner.cookie, { role: 'commenter' });
    const guest = await join(made.body.code);
    const ownerBoard = h.connect(board, owner.cookie);
    const boardRoom = h.connect(board, guest.cookie);
    const commentsRoom = h.connect(`${board}~comments`, guest.cookie);
    await Promise.all([ownerBoard.synced(), boardRoom.synced(), commentsRoom.synced()]);
    ownerBoard.doc.getMap('objects').set('commenter-readable', true);
    await until(() => boardRoom.doc.getMap('objects').has('commenter-readable'));
    const boardObserver = h.connect(board, owner.cookie);
    const commentsObserver = h.connect(`${board}~comments`, owner.cookie);
    await Promise.all([boardObserver.synced(), commentsObserver.synced()]);
    boardRoom.doc.getMap('objects').set('commenter-write', true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(boardObserver.doc.getMap('objects').has('commenter-write')).toBe(false);
    const thread = new Y.Map<unknown>(Object.entries({
      id: 'guest-comment', createdAt: Date.now(), authorId: 'forged', authorName: 'Forged', authorColor: '#123456',
      text: 'A guest comment', anchor: { x: 0, y: 0 }, resolved: false,
    }));
    commentsRoom.doc.getMap('threads').set('guest-comment', thread);
    await until(() => commentsObserver.doc.getMap('threads').has('guest-comment'));
    const saved = (commentsObserver.doc.getMap('threads').get('guest-comment') as Y.Map<unknown>).toJSON();
    expect(saved).toMatchObject({ authorId: guest.body.guestId, authorName: 'Guest', text: 'A guest comment' });
    expect((await upload(guest.cookie!, board, makePng())).status).toBe(403);
  });
});
