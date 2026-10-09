import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as decoding from 'lib0/decoding';
import WebSocket from 'ws';
import { createKeyRing } from '../server/ai/keys.mjs';
import { openDirectory } from '../server/directory.mjs';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// docs/ai.md, "Live runs", in accounts mode: the relay shapes the AI-run messages (type 6) for each socket's person.
// Viewers see runs without the prompt, a private run reaches its runner only, and a socket whose access is removed
// hears nothing more. The provider is a local HTTP server that answers like the Messages API; every key is made up.

const RELAY = fileURLToPath(new URL('../server/relay.mjs', import.meta.url));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('base64');
const newKey = () => `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;
const MSG_AI_RUNS = 6;
const BOARD = 'liveboard1';

const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TABULA|MIRA)_|^ANTHROPIC_|^DATA_DIR$|^PORT$/.test(name)));
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const provider = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify({ objects: [{ text: 'An idea' }] }) } }));
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
});

type Person = { id: string; cookie: string };
type Socket = { ws: WebSocket; runs: any[]; closed: number | null };

let relay: ChildProcess | null = null;
let dir = '';
const sockets: WebSocket[] = [];

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  if (relay && relay.exitCode === null) {
    const exited = new Promise((r) => relay!.once('exit', r));
    relay.kill('SIGTERM');
    await exited;
  }
  await new Promise((r) => provider.close(r));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const until = async (fn: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Users, sessions, the board and its shares, AI on with a workspace key and the editor's own key: written before the relay starts. */
function seed() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-live-accounts-'));
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  const ring = createKeyRing({ secret: Buffer.from(SECRET, 'base64') });
  const person = (email: string, role: 'owner' | 'member', name: string): Person => {
    const user = directory.createUser({ email, role, name })!;
    return { id: user.id, cookie: `tabula_session=${directory.createSession(user.id, { ttlMs: 3_600_000 }).token}` };
  };
  const owner = person('owner@example.com', 'owner', 'Ana');
  const editor = person('ben@example.com', 'member', 'Ben');
  const viewer = person('cy@example.com', 'member', 'Cy');
  directory.createBoard({ id: BOARD, title: 'Roadmap', ownerId: owner.id });
  directory.shareBoard(BOARD, { principalType: 'user', principalId: editor.id, role: 'editor' });
  directory.shareBoard(BOARD, { principalType: 'user', principalId: viewer.id, role: 'viewer' });
  directory.setSetting('ai.enabled', '1');
  directory.setSetting('ai.personalKeys', '1');
  directory.saveAiKey({ ring, scope: 'workspace', provider: 'anthropic', apiKey: newKey() });
  directory.saveAiKey({ ring, scope: 'user', userId: editor.id, provider: 'anthropic', apiKey: newKey() });
  directory.close();
  return { owner, editor, viewer };
}

async function start() {
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  let out = '';
  relay = spawn(process.execPath, [RELAY], {
    cwd: dir,
    env: {
      ...cleanEnv(),
      PORT: String(PORT),
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      TABULA_AUTH: 'on',
      TABULA_OWNER_EMAIL: 'owner@example.com',
      TABULA_MAIL: 'file',
      TABULA_BASE_URL: BASE,
      TABULA_AI_SECRET: SECRET,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout!.on('data', (d) => (out += d));
  relay.stderr!.on('data', (d) => (out += d));
  await until(() => out.includes('Tabula relay'), RELAY_START_MS).catch(() => {
    throw new Error(`relay did not start: ${out}`);
  });
}

function connect(who: Person): Promise<Socket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sync/${BOARD}`, { headers: { Origin: BASE, Cookie: who.cookie } });
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  const sock: Socket = { ws, runs: [], closed: null };
  ws.on('message', (data: ArrayBuffer) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(dec) === MSG_AI_RUNS) sock.runs.push(JSON.parse(decoding.readVarString(dec)));
  });
  ws.on('close', (code) => (sock.closed = code));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(sock));
    ws.once('error', reject);
  });
}

async function post(who: Person, url: string, body: unknown) {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'x-tabula': '1', 'content-type': 'application/json', cookie: who.cookie }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

const runIdOf = (text: string) => JSON.parse(/^data: (.+)$/m.exec(text)![1]).runId as string;
const about = (s: Socket, id: string) => s.runs.filter((m) => m.run?.id === id || m.runs?.some((r: any) => r.id === id));

describe('live AI runs through an accounts-mode relay', () => {
  it('shapes the stream per person: viewers see runs, nobody gets the prompt, private runs reach the runner only, removed access hears nothing', async () => {
    const { owner, editor, viewer } = seed();
    await start();
    const [a, b, c] = await Promise.all([connect(owner), connect(editor), connect(viewer)]);

    // a run on the workspace key: everyone on the board sees it, viewers included, and the prompt goes to nobody
    const shared = await post(owner, '/api/ai/run', { feature: 'generate', boardId: BOARD, input: { prompt: 'CANARY-prompt' }, presence: { name: 'Mallory', color: '#2F6FED' } });
    expect(shared.status).toBe(200);
    const sharedId = runIdOf(shared.text);
    await until(() => [a, b, c].every((s) => about(s, sharedId).some((m) => m.run.status === 'ready')));
    const viewerReady = about(c, sharedId).find((m) => m.run.status === 'ready').run;
    expect(viewerReady).toMatchObject({ by: { id: owner.id, name: 'Ana', color: '#2F6FED' }, proposal: { kind: 'create', objects: [{ text: 'An idea' }] } });
    expect(JSON.stringify([a.runs, b.runs, c.runs])).not.toContain('CANARY');
    expect(JSON.stringify([a.runs, b.runs, c.runs])).not.toContain('Mallory');

    // the viewer may see it but not settle it
    expect((await post(viewer, `/api/ai/runs/${sharedId}/resolve`, { action: 'accept' })).status).toBe(403);

    // a private run on the editor's own key: only the editor hears of it, and to anyone else it does not exist
    const hidden = await post(editor, '/api/ai/run', { feature: 'generate', boardId: BOARD, input: { prompt: 'secret' }, private: true });
    expect(hidden.status).toBe(200);
    const hiddenId = runIdOf(hidden.text);
    await until(() => about(b, hiddenId).some((m) => m.run.status === 'ready'));
    expect(about(b, hiddenId)[0].run.private).toBe(true);
    expect((await post(owner, `/api/ai/runs/${hiddenId}/resolve`, { action: 'discard' })).status).toBe(404);
    // a late joiner who is not the runner gets no snapshot of it either
    const late = await connect(owner);
    await until(() => late.runs.length > 0);
    expect(late.runs[0].runs.map((r: any) => r.id)).toEqual([sharedId]);

    // the owner removes the viewer: the relay closes that socket, and it hears nothing more
    const removed = await fetch(`${BASE}/api/boards/${BOARD}/shares/user/${viewer.id}`, { method: 'DELETE', headers: { 'x-tabula': '1', cookie: owner.cookie } });
    expect(removed.status).toBeLessThan(300);
    await until(() => c.closed !== null);
    const heard = c.runs.length;
    const after = await post(owner, '/api/ai/run', { feature: 'generate', boardId: BOARD, input: { prompt: 'again' } });
    const afterId = runIdOf(after.text);
    await until(() => about(a, afterId).some((m) => m.run.status === 'ready'));
    expect(c.runs.length).toBe(heard);
    expect(about(a, hiddenId)).toEqual([]);
  }, 60_000);
});
