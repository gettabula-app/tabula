import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';
import {
  ABUSE_CLOSE_MS, UPDATE_BURST, createConnectionCounter, createDocSizeGuard, createSyncFrameLimiter, createUpgradeLimiter,
  loadSyncCaps, frameLimitFor, MAX_FRAME_BYTES_OTHER, MAX_FRAME_BYTES_OWNER,
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
    expect(loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '10M' }).maxDocBytes).toBe(10 * 1024 * 1024);
    expect(loadSyncCaps({ TABULA_SYNC_MAX_DOC_BYTES: '0' }).maxDocBytes).toBe(0);
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_SOCKETS_PER_USER: 'abc' })).toThrow(/TABULA_SYNC_MAX_SOCKETS_PER_USER/);
    expect(() => loadSyncCaps({ TABULA_SYNC_MAX_FRAME_OTHER: '0' })).toThrow(/at least 1/);
    expect(() => loadSyncCaps({ TABULA_SYNC_UPGRADES_PER_MINUTE: '0' })).toThrow();
    expect(frameLimitFor(d, { role: 'editor' }, true)).toBe(MAX_FRAME_BYTES_OTHER);
    expect(frameLimitFor(d, { role: 'owner' }, true)).toBe(MAX_FRAME_BYTES_OWNER);
    expect(frameLimitFor(d, {}, false)).toBe(MAX_FRAME_BYTES_OWNER);
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
        TABULA_SYNC_MAX_FRAME_OWNER: '256K', TABULA_SYNC_MAX_DOC_BYTES: '200K', TABULA_SYNC_MAX_SOCKETS_PER_ADDRESS: '6',
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
    expect(await closed).toMatchObject({ code: 1009, reason: 'message_too_big' });
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
        TABULA_SYNC_MAX_SOCKETS_PER_USER: '3', TABULA_SYNC_UPGRADES_PER_MINUTE: '12',
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
    const opened = (ws: WebSocket) => new Promise<void>((r) => ws.once('message', () => r()));
    const socks = [connect('10.2.0.1'), connect('10.2.0.2'), connect('10.2.0.3')];
    await Promise.all(socks.map(opened));
    const extra = connect('10.2.0.4');
    expect(await closeOf(extra)).toEqual({ code: 4430, reason: 'too_many_connections' });
    expect(socks.every((s) => s.readyState === WebSocket.OPEN)).toBe(true);
    socks[0].close();
    await sleep(300);
    const again = connect('10.2.0.5');
    await opened(again);
    // 12 upgrades a minute per address (this test's env): the 13th from one address is refused with 429 before the handshake.
    const attempts: Promise<string>[] = [];
    for (let i = 0; i < 14; i++) {
      attempts.push(new Promise((r) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/capsboard`, { headers: { Origin: `http://127.0.0.1:${port}`, Cookie: cookie, 'x-forwarded-for': '10.9.9.9' } });
        ws.on('unexpected-response', (_q, res) => r(String(res.statusCode)));
        ws.on('close', () => r('closed'));
        ws.on('error', () => {});
      }));
    }
    expect((await Promise.all(attempts)).filter((x) => x === '429').length).toBeGreaterThanOrEqual(2);
    for (const s of [...socks, again]) s.terminate();
  });
});
