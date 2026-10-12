import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';
import {
  ABUSE_CLOSE_MS, UPDATE_BURST, createConnectionCounter, createDocSizeGuard, createSyncFrameLimiter, createUpgradeLimiter,
  loadSyncCaps, describeSyncCaps, frameLimitFor, MAX_FRAME_BYTES_COMMENTS, MAX_FRAME_BYTES_OTHER, MAX_FRAME_BYTES_OWNER,
} from '../server/sync-caps.mjs';

describe('createSyncFrameLimiter', () => {
  it('never drops a sustained 60 updates per second or a 400-frame burst', () => {
    let t = 0;
    const l = createSyncFrameLimiter({ now: () => t });
    for (let i = 0; i < 400; i++) expect(l.take('update')).toBe('ok');
    t += 5000;
    for (let i = 0; i < 3000; i++) { t += 1000 / 60; expect(l.take('update')).toBe('ok'); }
  });
  it('limits SyncStep1 tightly and keeps its bucket apart from updates', () => {
    let t = 0;
    const l = createSyncFrameLimiter({ now: () => t });
    let ok = 0;
    for (let i = 0; i < 100; i++) if (l.take('step1') === 'ok') ok++;
    expect(ok).toBe(20);
    expect(l.take('update')).toBe('ok');
    t += 1000;
    ok = 0;
    for (let i = 0; i < 100; i++) if (l.take('step1') === 'ok') ok++;
    expect(ok).toBe(5);
  });
  it('closes only after ABUSE_CLOSE_MS of continuous over-limit, and a quiet second ends the run', () => {
    let t = 0;
    const l = createSyncFrameLimiter({ now: () => t });
    for (let i = 0; i < UPDATE_BURST; i++) l.take('update');
    let verdict = 'drop';
    for (; t < ABUSE_CLOSE_MS - 100; t += 2) verdict = l.take('update') === 'close' ? 'close' : verdict;
    expect(verdict).not.toBe('close');
    t += 2000; // a break
    expect(l.take('update')).toBe('ok');
    for (let i = 0; i < UPDATE_BURST; i++) l.take('update');
    let closed = false;
    for (let i = 0; i < 10000 && !closed; i++) { t += 2; closed = l.take('update') === 'close'; }
    expect(closed).toBe(true);
    expect(t).toBeGreaterThanOrEqual(ABUSE_CLOSE_MS + 2000);
  });
});

describe('createConnectionCounter', () => {
  it('refuses the surplus socket, frees on release and releases once', () => {
    const c = createConnectionCounter(2);
    const a = c.acquire('u1')!;
    c.acquire('u1');
    expect(c.acquire('u1')).toBeNull();
    expect(c.acquire('u2')).not.toBeNull();
    a(); a();
    expect(c.count('u1')).toBe(1);
    expect(c.acquire('u1')).not.toBeNull();
  });
  it('holds no entry for a key without sockets', () => {
    const c = createConnectionCounter(3);
    c.acquire('x')!();
    expect(c.size).toBe(0);
  });
});

describe('createUpgradeLimiter', () => {
  it('allows the window count, then refuses until the window ends, and stays bounded', () => {
    let t = 0;
    const l = createUpgradeLimiter({ max: 120, now: () => t, maxKeys: 50 });
    for (let i = 0; i < 120; i++) expect(l.allow('1.1.1.1')).toBe(true);
    expect(l.allow('1.1.1.1')).toBe(false);
    expect(l.allow('2.2.2.2')).toBe(true);
    t += 60_000;
    expect(l.allow('1.1.1.1')).toBe(true);
    for (let i = 0; i < 500; i++) l.allow(`k${i}`);
    expect(l.size).toBeLessThanOrEqual(50);
    t += 60_000;
    l.allow('new');
    expect(l.size).toBeLessThanOrEqual(50);
  });
});

describe('createDocSizeGuard', () => {
  it('refuses a big frame past the cap, takes small ones, and recovers when the doc shrinks', () => {
    let size = 900;
    let measures = 0;
    const g = createDocSizeGuard({ max: 1000, measure: () => { measures++; return size; }, recheckBytes: 1000, smallFrame: 50 });
    expect(g.admit(80)).toBe(true);
    expect(g.admit(200)).toBe(false);
    expect(g.admit(40)).toBe(true);
    size = 1200;
    g.accepted(2000);
    expect(g.admit(40)).toBe(true);
    expect(g.over).toBe(true);
    expect(g.admit(60)).toBe(false);
    size = 100;
    g.accepted(2000);
    expect(g.admit(60)).toBe(true);
    expect(measures).toBeGreaterThan(1);
  });
  it('is off with max 0', () => {
    const g = createDocSizeGuard({ max: 0, measure: () => 1e12 });
    expect(g.admit(1e9)).toBe(true);
  });
});

describe('loadSyncCaps and frameLimitFor', () => {
  it('defaults, overrides and validates', () => {
    const d = loadSyncCaps({});
    expect(d.maxFrameOwner).toBe(MAX_FRAME_BYTES_OWNER);
    expect(loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '10M', TABULA_SYNC_MAX_FRAME_OWNER: '8M', TABULA_SYNC_MAX_FRAME_OTHER: '8M' }).maxDocBytes).toBe(10 * 1024 * 1024);
    expect(loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '0' }).maxDocBytes).toBe(0);
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_SOCKETS_PER_USER: 'abc' })).toThrow(/TABULA_SYNC_MAX_SOCKETS_PER_USER/);
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_FRAME_OTHER: '0' })).toThrow(/at least 1/);
    expect(() => loadSyncCaps({ TABULA_SYNC_UPGRADES_PER_MINUTE: '0' })).toThrow();
    // the limits must nest: small <= comments <= editor <= owner <= document cap
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_FRAME_SMALL: '10M' })).toThrow(/TABULA_SYNC_MAX_FRAME_SMALL.*TABULA_SYNC_MAX_FRAME_COMMENTS/);
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_FRAME_COMMENTS: '100M' })).toThrow(/TABULA_SYNC_MAX_FRAME_COMMENTS.*TABULA_SYNC_MAX_FRAME_OTHER/);
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_FRAME_OTHER: '200M' })).toThrow(/TABULA_SYNC_MAX_FRAME_OTHER.*TABULA_SYNC_MAX_FRAME_OWNER/);
    // only the document cap set (an older, valid deployment): frame limits left at their defaults come down to it
    const only100 = loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '100M' });
    expect([only100.maxFrameOwner, only100.maxFrameOther]).toEqual([100 * 1024 * 1024, MAX_FRAME_BYTES_OTHER]);
    const only10 = loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '10M' });
    expect([only10.maxFrameOwner, only10.maxFrameOther, only10.maxFrameComments, only10.maxFrameSmall]).toEqual([10, 10, 8, 1].map((m) => m * 1024 * 1024));
    const only4 = loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '4M' }); // below the editor and comments defaults
    expect([only4.maxFrameOwner, only4.maxFrameOther, only4.maxFrameComments, only4.maxFrameSmall]).toEqual([4, 4, 4, 1].map((m) => m * 1024 * 1024));
    expect(only10.clamped).toEqual([
      'effective owner 10 MiB (clamped from default 128 MiB to fit the document cap)',
      'effective editor 10 MiB (clamped from default 96 MiB to fit the owner limit)',
    ]);
    const line = describeSyncCaps(only10);
    expect(line).toMatch(/owner 10 MiB, editor 10 MiB, comments 8 MiB, small 1 MiB; document 10 MiB; effective owner 10 MiB \(clamped from default 128 MiB/);
    expect(describeSyncCaps(loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '0' }))).toContain('document no cap');
    const off = loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '0' });
    expect([off.maxDocBytes, off.maxFrameOwner, off.maxFrameOther]).toEqual([0, MAX_FRAME_BYTES_OWNER, MAX_FRAME_BYTES_OTHER]);
    // both set and contradicting: the relay does not start, and the message names both
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '100M', TABULA_SYNC_MAX_FRAME_OWNER: '128M' })).toThrow(/TABULA_SYNC_MAX_FRAME_OWNER=128 MiB \(explicit\) exceeds TABULA_SYNC_MAX_DOC_BYTES=100 MiB/);
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_FRAME_SMALL: '512' })).toThrow(/at least 1 KiB/);
    expect(loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '0', TABULA_SYNC_MAX_FRAME_OWNER: '512M' }).maxFrameOwner).toBe(512 * 1024 * 1024);
    expect(frameLimitFor(d, { role: 'editor', canWrite: true }, true)).toBe(MAX_FRAME_BYTES_OTHER);
    expect(frameLimitFor(d, { role: 'owner', canWrite: true }, true)).toBe(MAX_FRAME_BYTES_OWNER);
    expect(frameLimitFor(d, { role: 'viewer', canWrite: false }, true)).toBe(d.maxFrameSmall);
    expect(frameLimitFor(d, { role: 'commenter', canWrite: false }, true)).toBe(d.maxFrameSmall);
    expect(frameLimitFor(d, { canWrite: true }, false)).toBe(MAX_FRAME_BYTES_OWNER);
    expect(frameLimitFor(d, { canWrite: true }, false, 'comments')).toBe(MAX_FRAME_BYTES_COMMENTS);
    expect(frameLimitFor(d, { role: 'owner', canWrite: true }, true, 'comments')).toBe(MAX_FRAME_BYTES_COMMENTS);
    expect(frameLimitFor(d, { role: 'viewer', canWrite: false }, true, 'comments')).toBe(d.maxFrameSmall);
    expect(MAX_FRAME_BYTES_COMMENTS).toBeGreaterThanOrEqual(4 * 1.7 * 1024 * 1024);
    expect(MAX_FRAME_BYTES_OTHER).toBeGreaterThanOrEqual(4 * 20.6 * 1024 * 1024);
  });
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-caps-'));
let relay: ChildProcess;
let PORT = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = (room: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sync/${room}`);
  ws.binaryType = 'arraybuffer';
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
});
const updateFrame = (fn: (d: Y.Doc) => void) => {
  const d = new Y.Doc();
  fn(d);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(d));
  return encoding.toUint8Array(enc);
};
const closeOf = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: String(reason) })));

describe('relay sync caps (open mode)', () => {
  beforeAll(async () => {
    const started = await startRelayProcess({
      envFor: (port) => ({
        ...(process.env as Record<string, string>), PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1',
        TABULA_SYNC_MAX_FRAME_OWNER: '192K', TABULA_SYNC_MAX_FRAME_OTHER: '128K', TABULA_SYNC_MAX_FRAME_COMMENTS: '96K', TABULA_SYNC_MAX_FRAME_SMALL: '64K', TABULA_SYNC_MAX_DOC_BYTES: '200K', TABULA_SYNC_MAX_SOCKETS_PER_ADDRESS: '6',
      }),
    });
    PORT = started.port;
    relay = started.proc;
  });
  afterAll(async () => {
    if (relay && relay.exitCode === null) await new Promise<void>((r) => { relay.once('exit', () => r()); relay.kill('SIGTERM'); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('never drops a few hundred small updates sent quickly, and refuses an oversized frame', async () => {
    const writer = await open('caps-a');
    const reader = await open('caps-a');
    const doc = new Y.Doc();
    const seen = new Y.Doc();
    reader.on('message', (m: ArrayBuffer) => {
      const dec = (async () => { const d = await import('lib0/decoding'); return d; })();
      void dec.then((d) => {
        const dd = d.createDecoder(new Uint8Array(m));
        if (d.readVarUint(dd) !== 0) return;
        const out = encoding.createEncoder();
        syncProtocol.readSyncMessage(dd, out, seen, 'relay');
      });
    });
    doc.on('update', (u: Uint8Array) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      writer.send(encoding.toUint8Array(enc));
    });
    for (let i = 0; i < 300; i++) doc.getMap('m').set(`k${i}`, i);
    for (let i = 0; i < 100 && seen.getMap('m').size < 300; i++) await sleep(50);
    expect(seen.getMap('m').size).toBe(300);
    expect(writer.readyState).toBe(WebSocket.OPEN);

    const closed = closeOf(writer);
    writer.send(updateFrame((d) => d.getText('t').insert(0, 'x'.repeat(300 * 1024))));
    expect(await closed).toMatchObject({ code: 1009 });
    reader.close();
  });

  it('refuses a big update once the document is at its cap but keeps taking small ones', async () => {
    const big = (n: number) => updateFrame((d) => d.getText(`t${n}`).insert(0, String.fromCharCode(65 + n).repeat(60 * 1024)));
    const a = await open('caps-b');
    a.send(big(0));
    a.send(big(1));
    a.send(big(3));
    await sleep(300);
    const b = await open('caps-b'); // sees the state, proving it was applied
    expect(a.readyState).toBe(WebSocket.OPEN);
    const closed = closeOf(a);
    a.send(big(2));
    expect(await closed).toMatchObject({ code: 4413, reason: 'document_too_large' });
    b.send(updateFrame((d) => d.getText('small').insert(0, 'ok')));
    await sleep(200);
    expect(b.readyState).toBe(WebSocket.OPEN);
    b.close();
  });

  it('closes the surplus socket of one address', async () => {
    const socks: WebSocket[] = [];
    for (let i = 0; i < 6; i++) socks.push(await open('caps-c'));
    const extra = new WebSocket(`ws://127.0.0.1:${PORT}/sync/caps-c`);
    const code = await new Promise<{ code: number; reason: string }>((r) => extra.once('close', (c, reason) => r({ code: c, reason: String(reason) })));
    expect(code).toEqual({ code: 4430, reason: 'too_many_connections' });
    expect(socks.every((s) => s.readyState === WebSocket.OPEN)).toBe(true);
    socks[0].close();
    await sleep(200);
    const again = await open('caps-c');
    expect(again.readyState).toBe(WebSocket.OPEN);
    for (const s of [...socks, again]) s.close();
  });
});

describe('relay sync caps (accounts mode)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-caps-acc-'));
  let proc: ChildProcess;
  let port = 0;
  const OWNER = 'owner@example.com';
  const api = async (cookie: string | undefined, method: string, p: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'x-tabula': '1', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  beforeAll(async () => {
    const started = await startRelayProcess({
      envFor: (p) => ({
        ...(process.env as Record<string, string>), PORT: String(p), DATA_DIR: dir, HOST: '127.0.0.1', TABULA_AUTH: 'on',
        TABULA_OWNER_EMAIL: OWNER, TABULA_MAIL: 'file', TABULA_BASE_URL: `http://127.0.0.1:${p}`, TABULA_TRUST_PROXY: '1',
        TABULA_SYNC_MAX_SOCKETS_PER_USER: '3', TABULA_SYNC_UPGRADES_PER_MINUTE: '40',
      }),
    });
    port = started.port;
    proc = started.proc;
  });
  afterAll(async () => {
    if (proc && proc.exitCode === null) await new Promise<void>((r) => { proc.once('exit', () => r()); proc.kill('SIGTERM'); });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('closes the surplus socket of one person, frees the slot on close, and limits upgrades per address', async () => {
    const req = await api(undefined, 'POST', '/api/auth/request', { email: OWNER }, { 'x-forwarded-for': '10.1.1.11' });
    expect(req.status).toBe(200);
    const mail = JSON.parse(fs.readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean)[0]);
    const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);
    const verify = await api(undefined, 'POST', '/api/auth/verify', { token });
    const cookie = /tabula_session=[^;]+/.exec(verify.headers.getSetCookie()[0])![0];
    const board = (await api(cookie, 'POST', '/api/boards', { id: 'capsboard' }));
    expect(board.status).toBe(201);
    const connect = (xff: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/capsboard`, { headers: { Origin: `http://127.0.0.1:${port}`, Cookie: cookie, 'x-forwarded-for': xff } });
      ws.on('error', () => {});
      return ws;
    };
    const opened = (ws: WebSocket) => new Promise<void>((r, j) => { ws.once('message', () => r()); ws.once('close', (c) => j(new Error(`closed ${c} before the first message`))); });
    const socks = [connect('10.2.0.1'), connect('10.2.0.2'), connect('10.2.0.3')];
    await Promise.all(socks.map(opened));
    const extra = connect('10.2.0.4');
    expect(await closeOf(extra)).toEqual({ code: 4430, reason: 'too_many_connections' });
    expect(socks.every((s) => s.readyState === WebSocket.OPEN)).toBe(true);
    socks[0].close();
    await sleep(300);
    const again = connect('10.2.0.5');
    await opened(again);
    for (const s of [...socks, again]) s.terminate();
    await sleep(500);

    // a refusal for the cap is created with the tiny 1 KiB receiver: a bigger frame sent at once ends the socket (4430 or 1009)
    const full = [connect('10.2.0.6'), connect('10.2.0.7'), connect('10.2.0.8')];
    await Promise.all(full.map(opened));
    const over = connect('10.2.0.9');
    over.on('open', () => over.send(new Uint8Array(4096)));
    expect([4430, 1009]).toContain((await closeOf(over)).code);
    for (const s of full) s.terminate();
    await sleep(500);

    // slots come back after an upgrade that never completes: ten aborted handshakes, then the whole cap is free again
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => {
        const raw = net.connect(port, '127.0.0.1', () => {
          raw.write(`GET /sync/capsboard HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
          raw.destroy();
          r();
        });
        raw.on('error', () => r());
      });
    }
    await sleep(500);
    const fresh = [connect('10.2.0.10'), connect('10.2.0.11'), connect('10.2.0.12')];
    await Promise.all(fresh.map(opened));
    expect(fresh.every((s) => s.readyState === WebSocket.OPEN)).toBe(true);
    // the cap is full again, so the flood below ends in closes (4430, or 4429 once the account limit is used)
    socks.splice(0, socks.length, ...fresh);
    // 40 upgrades a minute per account (this test's env): later ones complete the handshake and are closed with 4429.
    const attempts: Promise<number>[] = [];
    for (let i = 0; i < 30; i++) {
      attempts.push(new Promise((r) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/capsboard`, { headers: { Origin: `http://127.0.0.1:${port}`, Cookie: cookie, 'x-forwarded-for': '10.9.9.9' } });
        ws.on('close', (code) => r(code));
        ws.on('error', () => {});
      }));
    }
    expect((await Promise.all(attempts)).filter((x) => x === 4429).length).toBeGreaterThanOrEqual(2);
    for (const s of [...socks, again]) s.terminate();
  });
});

describe('relay sync caps (classroom and big editor updates)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-caps-class-'));
  let proc: ChildProcess;
  let port = 0;
  const OWNER = 'owner@example.com';
  let ipSeq = 0;
  const api = async (cookie: string | undefined, method: string, p: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'x-tabula': '1', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const outbox = () => (fs.existsSync(path.join(dir, 'outbox.jsonl')) ? fs.readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  async function signIn(email: string, invite?: string) {
    const before = outbox().length;
    const r = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': `10.7.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` });
    expect(r.status).toBe(200);
    const mail = outbox()[before];
    const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);
    const v = await api(undefined, 'POST', '/api/auth/verify', { token });
    return { cookie: /tabula_session=[^;]+/.exec(v.headers.getSetCookie()[0])![0], user: v.body.user };
  }
  beforeAll(async () => {
    const started = await startRelayProcess({
      envFor: (p) => ({
        ...(process.env as Record<string, string>), PORT: String(p), DATA_DIR: dir, HOST: '127.0.0.1', TABULA_AUTH: 'on',
        TABULA_OWNER_EMAIL: OWNER, TABULA_MAIL: 'file', TABULA_BASE_URL: `http://127.0.0.1:${p}`, TABULA_TRUST_PROXY: '1',
      }),
    });
    port = started.port;
    proc = started.proc;
  });
  afterAll(async () => {
    if (proc && proc.exitCode === null) await new Promise<void>((r) => { proc.once('exit', () => r()); proc.kill('SIGTERM'); });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const connect = (cookie: string, room: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/${room}`, { headers: { Origin: `http://127.0.0.1:${port}`, Cookie: cookie, 'x-forwarded-for': '10.50.0.1' } });
    ws.binaryType = 'arraybuffer';
    ws.on('error', () => {});
    return ws;
  };

  it('accepts a ~21 MiB and a ~17 MiB update from an editor, and refuses a big frame in a comments room, but takes a 200-thread offline sync', async () => {
    const owner = await signIn(OWNER);
    expect((await api(owner.cookie, 'POST', '/api/boards', { id: 'bigboard' })).status).toBe(201);
    const team = (await api(owner.cookie, 'POST', '/api/teams', { name: 'Big' })).body;
    const invite = (await api(owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member' })).body.token;
    const editor = await signIn('editor@example.com', invite);
    expect((await api(owner.cookie, 'POST', '/api/boards/bigboard/shares', { principalType: 'user', principalId: editor.user.id, role: 'editor' })).status).toBeLessThan(300);

    const watcher = connect(owner.cookie, 'bigboard');
    const sender = connect(editor.cookie, 'bigboard');
    const sizes: number[] = [];
    watcher.on('message', (m: ArrayBuffer) => sizes.push(m.byteLength));
    await Promise.all([watcher, sender].map((w) => new Promise((r) => w.once('message', r))));
    sender.on('close', (code) => sizes.push(-code));
    for (const mib of [21, 17]) {
      sender.send(updateFrame((d) => d.getText(`t${mib}`).insert(0, 'x'.repeat(Math.floor(mib * 1024 * 1024)))));
      for (let i = 0; i < 400 && !sizes.some((n) => n > (mib - 1) * 1024 * 1024); i++) await sleep(50);
      expect(sizes.some((n) => n > (mib - 1) * 1024 * 1024)).toBe(true);
    }
    expect(sender.readyState).toBe(WebSocket.OPEN);
    expect(sizes.filter((n) => n < 0)).toEqual([]);

    const comments = connect(editor.cookie, 'bigboard~comments');
    await new Promise((r) => comments.once('message', r));
    // 200 threads with one 4,000-character reply each, built with real Yjs docs (non-ASCII text, about 1.7 MB)
    const offline = updateFrame((d) => {
      const threads = d.getMap('threads');
      for (let i = 0; i < 200; i++) {
        const t = new Y.Map<unknown>([['id', `th${i}`], ['createdAt', 1], ['text', 'hi'], ['anchor', { x: 0, y: 0 }], ['resolved', false]]);
        const replies = new Y.Map<unknown>();
        replies.set(`r${i}`, new Y.Map<unknown>([['id', `r${i}`], ['createdAt', 2], ['text', 'é'.repeat(4000)]]));
        t.set('replies', replies);
        threads.set(`th${i}`, t);
      }
    });
    expect(offline.length).toBeGreaterThan(1_500_000); // over the old 1 MiB cap
    const commentsSeen: number[] = [];
    const commentsWatcher = connect(owner.cookie, 'bigboard~comments');
    commentsWatcher.on('message', (m: ArrayBuffer) => commentsSeen.push(m.byteLength));
    await sleep(300);
    comments.send(offline);
    for (let i = 0; i < 100 && !commentsSeen.some((n) => n > 500_000); i++) await sleep(50);
    expect(comments.readyState).toBe(WebSocket.OPEN);
    expect(commentsSeen.some((n) => n > 500_000)).toBe(true);
    commentsWatcher.terminate();
    const closed = closeOf(comments);
    comments.send(updateFrame((d) => d.getText('c').insert(0, 'y'.repeat(9 * 1024 * 1024))));
    expect((await closed).code).toBe(1009);
    sender.terminate(); watcher.terminate();
  }, 60_000);

  it('lets 30 pupils with 2 tabs each on one address connect twice in a row without a refusal', async () => {
    const owner = await signIn(OWNER);
    const team = (await api(owner.cookie, 'POST', '/api/teams', { name: 'Class' })).body;
    expect((await api(owner.cookie, 'POST', '/api/boards', { id: 'classboard' })).status).toBe(201);
    expect((await api(owner.cookie, 'POST', '/api/boards/classboard/shares', { principalType: 'team', principalId: team.id, role: 'editor' })).status).toBeLessThan(300);
    const pupils = [];
    for (let i = 0; i < 30; i++) {
      const invite = (await api(owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member' })).body.token;
      pupils.push(await signIn(`pupil${i}@example.com`, invite));
    }
    for (let pass = 0; pass < 2; pass++) {
      const socks: WebSocket[] = [];
      for (const p of pupils) for (let tab = 0; tab < 2; tab++) for (const room of ['classboard', 'classboard~comments']) socks.push(connect(p.cookie, room));
      const results = await Promise.all(socks.map((ws) => new Promise<string>((r) => {
        ws.once('message', () => r('open'));
        ws.once('close', (code) => r(`closed ${code}`));
        setTimeout(() => r('timeout'), 15_000);
      })));
      expect(results.filter((x) => x !== 'open')).toEqual([]);
      for (const ws of socks) ws.terminate(); // the relay restart: everybody drops and comes back
      await sleep(300);
    }
  }, 120_000);
});

describe('relay receive limits by role (accounts mode)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-caps-tier-'));
  let proc: ChildProcess;
  let port = 0;
  const OWNER = 'owner@example.com';
  let ipSeq = 0;
  const api = async (cookie: string | undefined, method: string, p: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'x-tabula': '1', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const outbox = () => (fs.existsSync(path.join(dir, 'outbox.jsonl')) ? fs.readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  async function signIn(email: string, invite?: string) {
    const before = outbox().length;
    const r = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': `10.8.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` });
    expect(r.status).toBe(200);
    const token = decodeURIComponent(/token=([^\s&]+)/.exec(outbox()[before].text)![1]);
    const v = await api(undefined, 'POST', '/api/auth/verify', { token });
    return { cookie: /tabula_session=[^;]+/.exec(v.headers.getSetCookie()[0])![0], user: v.body.user };
  }
  const origin = () => `http://127.0.0.1:${port}`;
  const connect = (room: string, cookie?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/${room}`, { headers: { Origin: origin(), ...(cookie ? { Cookie: cookie } : {}) } });
    ws.binaryType = 'arraybuffer';
    ws.on('error', () => {});
    return ws;
  };
  beforeAll(async () => {
    const started = await startRelayProcess({
      envFor: (p) => ({
        ...(process.env as Record<string, string>), PORT: String(p), DATA_DIR: dir, HOST: '127.0.0.1', TABULA_AUTH: 'on',
        TABULA_OWNER_EMAIL: OWNER, TABULA_MAIL: 'file', TABULA_BASE_URL: `http://127.0.0.1:${p}`, TABULA_TRUST_PROXY: '1',
        TABULA_SYNC_MAX_FRAME_SMALL: '64K', TABULA_SYNC_MAX_FRAME_OTHER: '2M', TABULA_SYNC_MAX_FRAME_OWNER: '4M', TABULA_SYNC_MAX_FRAME_COMMENTS: '256K',
      }),
    });
    port = started.port;
    proc = started.proc;
  });
  afterAll(async () => {
    if (proc && proc.exitCode === null) await new Promise<void>((r) => { proc.once('exit', () => r()); proc.kill('SIGTERM'); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const text = (n: number) => updateFrame((d) => d.getText('t').insert(0, 'x'.repeat(n)));
  const sees = async (ws: WebSocket, min: number) => {
    const seen: number[] = [];
    ws.on('message', (m: ArrayBuffer) => seen.push(m.byteLength));
    return async () => { for (let i = 0; i < 100 && !seen.some((n) => n > min); i++) await sleep(50); return seen.some((n) => n > min); };
  };

  it('rejects a foreign Origin with HTTP 403 before any socket exists, and closes an unauthenticated socket at once', async () => {
    const status = await new Promise<number | string>((r) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/anything`, { headers: { Origin: 'http://evil.example' } });
      ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0));
      ws.on('open', () => r('open'));
      ws.on('error', () => {});
    });
    expect(status).toBe(403);
    const anon = connect('anything');
    const sent = new Promise<void>((r) => anon.once('open', () => { anon.send(new Uint8Array(4096)); r(); }));
    const close = await closeOf(anon);
    await sent;
    expect([4401, 1009]).toContain(close.code);
  });

  it('gives viewers the small limit and editors theirs', async () => {
    const owner = await signIn(OWNER);
    expect((await api(owner.cookie, 'POST', '/api/boards', { id: 'tierboard' })).status).toBe(201);
    const team = (await api(owner.cookie, 'POST', '/api/teams', { name: 'Tier' })).body;
    const share = async (email: string, role: string) => {
      const invite = (await api(owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member' })).body.token;
      const person = await signIn(email, invite);
      expect((await api(owner.cookie, 'POST', '/api/boards/tierboard/shares', { principalType: 'user', principalId: person.user.id, role })).status).toBeLessThan(300);
      return person;
    };
    const viewer = await share('viewer@example.com', 'viewer');
    const editor = await share('editor2@example.com', 'editor');
    const watcher = connect('tierboard', owner.cookie);
    const waitWatch = await sees(watcher, 1_000_000);
    await new Promise((r) => watcher.once('message', r));

    const v = connect('tierboard', viewer.cookie);
    await new Promise((r) => v.once('message', r));
    v.send(text(50 * 1024)); // just under 64K: allowed through the socket (and then dropped, a viewer cannot write)
    await sleep(300);
    expect(v.readyState).toBe(WebSocket.OPEN);
    const vClosed = closeOf(v);
    v.send(text(70 * 1024));
    expect((await vClosed).code).toBe(1009);

    const e = connect('tierboard', editor.cookie);
    await new Promise((r) => e.once('message', r));
    e.send(text(1_500_000));
    expect(await waitWatch()).toBe(true);
    expect(e.readyState).toBe(WebSocket.OPEN);
    const eClosed = closeOf(e);
    e.send(text(2_300_000));
    expect((await eClosed).code).toBe(1009);

    const o = connect('tierboard', owner.cookie);
    await new Promise((r) => o.once('message', r));
    o.send(text(3_500_000));
    await sleep(500);
    expect(o.readyState).toBe(WebSocket.OPEN);
    for (const w of [watcher, o]) w.terminate();
  }, 60_000);

  it('applies the comments limits to a commenter, and keeps a viewer at the small limit in the comments room', async () => {
    const owner = await signIn(OWNER);
    expect((await api(owner.cookie, 'POST', '/api/boards', { id: 'commentsboard' })).status).toBe(201);
    const team = (await api(owner.cookie, 'POST', '/api/teams', { name: 'Comments' })).body;
    const share = async (email: string, role: string) => {
      const invite = (await api(owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member' })).body.token;
      const person = await signIn(email, invite);
      expect((await api(owner.cookie, 'POST', '/api/boards/commentsboard/shares', { principalType: 'user', principalId: person.user.id, role })).status).toBeLessThan(300);
      return person;
    };
    const commenter = await share('commenter@example.com', 'commenter');
    const viewer = await share('viewer2@example.com', 'viewer');
    const c = connect('commentsboard~comments', commenter.cookie);
    await new Promise((r) => c.once('message', r));
    c.send(text(200 * 1024)); // within the 256K comments limit
    await sleep(400);
    expect(c.readyState).toBe(WebSocket.OPEN);
    const cClosed = closeOf(c);
    c.send(text(300 * 1024));
    expect((await cClosed).code).toBe(1009);

    const v = connect('commentsboard~comments', viewer.cookie);
    await new Promise((r) => v.once('message', r));
    v.send(text(40 * 1024)); // under the 64K small limit
    await sleep(400);
    expect(v.readyState).toBe(WebSocket.OPEN);
    const vClosed = closeOf(v);
    v.send(text(100 * 1024)); // a viewer cannot write comments, and has no part of the 256K allowance
    expect((await vClosed).code).toBe(1009);

    // a commenter on the board room itself cannot write there: the small limit
    const cb = connect('commentsboard', commenter.cookie);
    await new Promise((r) => cb.once('message', r));
    const cbClosed = closeOf(cb);
    cb.send(text(100 * 1024));
    expect((await cbClosed).code).toBe(1009);
  }, 60_000);
});
