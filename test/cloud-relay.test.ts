import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

// docs/cloud.md. The relay runs as a child process exactly as `npm start` would, next to a fake control plane.

const BASE_PORT = 22000 + Math.floor(Math.random() * 900);
const OWNER = 'owner@example.com';
const TOKEN = 'c'.repeat(48);
const WORKSPACE = 'ws_test_1';
const PORTAL = 'https://billing.example.com/p/abc';

type Body = any;
type Res = { status: number; body: Body; headers: Headers };
type Account = { cookie: string; user: Body; email: string };
type Server = { port: number; base: string; dir: string; proc: ChildProcess };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
}

const baseEnv = (port: number, dir: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  PORT: String(port),
  DATA_DIR: dir,
  HOST: '127.0.0.1',
  TABULA_AUTH: 'on',
  TABULA_OWNER_EMAIL: OWNER,
  TABULA_MAIL: 'file',
  TABULA_BASE_URL: `http://127.0.0.1:${port}`,
  TABULA_TRUST_PROXY: '1',
});

const startRelay = (port: number, dir: string, env: Record<string, string>) =>
  new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ['server/relay.mjs'], { env: { ...baseEnv(port, dir), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout!.on('data', (d) => String(d).includes('Tabula relay') && resolve(p));
    p.stderr!.on('data', () => {});
    p.on('error', reject);
    setTimeout(() => reject(new Error('relay did not start')), 8000);
  });

const stopRelay = (p: ChildProcess) =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill('SIGTERM');
  });

// ---------------------------------------------------------------- the fake control plane

type Seen = { method: string; url: string; authorization: string | undefined; body: string };
const seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { url: PORTAL } };
let controlPlane: http.Server;
let controlUrl = '';
// The instance also reports usage to the same fake, 30 seconds after members change.
const portalCalls = () => seen.filter((s) => s.url.endsWith('/portal'));

beforeAll(async () => {
  controlPlane = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => controlPlane.listen(0, '127.0.0.1', resolve));
  controlUrl = `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => controlPlane.close(() => resolve())));

// ---------------------------------------------------------------- servers and clients

const servers: Server[] = [];
let launched = 0;

const CLOUD_ENV = () => ({ TABULA_CLOUD_TOKEN: TOKEN, TABULA_CLOUD_URL: controlUrl, TABULA_CLOUD_WORKSPACE_ID: WORKSPACE });

async function launch(env: Record<string, string> = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-cloud-'))): Promise<Server> {
  const port = BASE_PORT + launched++;
  const server = { port, base: `http://127.0.0.1:${port}`, dir, proc: await startRelay(port, dir, env) };
  servers.push(server);
  return server;
}

// Stop every relay before removing any directory: a restart test runs two relays on one directory, and Windows
// refuses to remove files the second one still holds open.
afterAll(async () => {
  await Promise.all(servers.map((s) => stopRelay(s.proc)));
  for (const dir of new Set(servers.map((s) => s.dir))) fs.rmSync(dir, { recursive: true, force: true });
});

const sockets = new Set<WebSocket>();
const providers = new Set<WebsocketProvider>();
afterEach(() => {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  for (const p of providers) p.destroy();
  providers.clear();
  seen.length = 0;
  reply = { status: 200, body: { url: PORTAL } };
});

let seq = 0;
const unique = (tag: string) => `${tag}${++seq}x${Math.random().toString(36).slice(2, 7)}`;

function client(srv: Server) {
  const outbox = path.join(srv.dir, 'outbox.jsonl');
  let ipSeq = 0;
  const nextIp = () => `10.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}.7`;

  async function api(cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(srv.base + urlPath, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'x-tabula': '1' }),
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  const internal = (method: string, urlPath: string, body?: unknown, token: string | null = TOKEN) =>
    api(undefined, method, urlPath, body, token ? { authorization: `Bearer ${token}` } : {});

  const mails = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean) : []);

  async function requestLink(email: string, invite?: string) {
    const before = mails().length;
    const res = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': nextIp() });
    const sent = mails().slice(before);
    const token = sent[0] ? decodeURIComponent(/token=([^\s&"\\]+)/.exec(JSON.parse(sent[0]).text)![1]) : null;
    return { res, mails: sent.length, token };
  }

  async function signIn(email: string, invite?: string): Promise<Account> {
    const { res, token } = await requestLink(email, invite);
    if (res.status !== 200 || !token) throw new Error(`no sign-in mail for ${email} (status ${res.status})`);
    const verify = await api(undefined, 'POST', '/api/auth/verify', { token });
    if (verify.status !== 200) throw new Error(`verify failed with ${verify.status}`);
    return { cookie: /tabula_session=[^;]+/.exec(verify.headers.getSetCookie()[0])![0], user: verify.body.user, email };
  }

  async function newTeam(cookie: string) {
    const res = await api(cookie, 'POST', '/api/teams', { name: unique('Team') });
    if (res.status !== 201) throw new Error(`could not create a team (${res.status})`);
    return res.body as Body;
  }

  async function invite(cookie: string, teamId: string) {
    const res = await api(cookie, 'POST', `/api/teams/${teamId}/invites`, { role: 'member' });
    if (res.status !== 201) throw new Error(`could not create an invite (${res.status})`);
    return res.body.token as string;
  }

  const joinTeam = async (adminCookie: string, teamId: string) => signIn(`${unique('user')}@example.com`, await invite(adminCookie, teamId));

  async function newBoard(cookie: string, extra: Record<string, unknown> = {}) {
    const id = unique('board');
    const res = await api(cookie, 'POST', '/api/boards', { id, ...extra });
    if (res.status !== 201) throw new Error(`could not create a board (${res.status})`);
    return id;
  }

  const wsFor = (cookie: string) =>
    class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols, { headers: { Origin: srv.base, Cookie: cookie } });
        sockets.add(this);
      }
    };

  function connect(room: string, cookie: string) {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${srv.port}/sync`, room, doc, {
      WebSocketPolyfill: wsFor(cookie) as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    providers.add(provider);
    return { doc, provider };
  }

  const synced = (c: ReturnType<typeof connect>) => until(() => c.provider.wsconnected && c.provider.synced);

  /** Awareness sent after a document edit reaches the other side after that edit would have, if it were allowed. */
  async function flush(from: ReturnType<typeof connect>, to: ReturnType<typeof connect>) {
    const name = unique('marker');
    from.provider.awareness.setLocalStateField('user', { name });
    await until(() => [...to.provider.awareness.getStates().values()].some((s) => s.user?.name === name));
  }

  return { api, internal, requestLink, signIn, newTeam, invite, joinTeam, newBoard, connect, synced, flush };
}

// ---------------------------------------------------------------- configuration

describe('startup', () => {
  const LOCAL_CLOUD_ENV = { TABULA_CLOUD_TOKEN: TOKEN, TABULA_CLOUD_URL: 'https://cloud.example.com', TABULA_CLOUD_WORKSPACE_ID: WORKSPACE };

  const run = (env: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-cloud-cfg-'));
    try {
      const out = spawnSync(process.execPath, ['server/relay.mjs'], {
        env: { ...baseEnv(BASE_PORT + 800 + launched++, dir), ...env },
        encoding: 'utf8',
        timeout: 8000,
      });
      return { status: out.status, stderr: out.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each<[string, Record<string, string>, string]>([
    ['only the token is set', { TABULA_CLOUD_TOKEN: TOKEN }, 'TABULA_CLOUD_TOKEN, TABULA_CLOUD_URL, TABULA_CLOUD_WORKSPACE_ID must be set together (missing TABULA_CLOUD_URL, TABULA_CLOUD_WORKSPACE_ID)'],
    ['the token is too short', { ...LOCAL_CLOUD_ENV, TABULA_CLOUD_TOKEN: 'short' }, 'TABULA_CLOUD_TOKEN must be at least 32 characters'],
    ['the URL is plain http to a remote host', { ...LOCAL_CLOUD_ENV, TABULA_CLOUD_URL: 'http://cloud.example.com' }, 'TABULA_CLOUD_URL must be an https:// URL'],
  ])('fails with a clear message when %s', (_name, env, message) => {
    const out = run(env);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(message);
  });

  it('reads a deprecated MIRA_ cloud variable, names the TABULA_ ones and warns once', () => {
    const out = run({ MIRA_CLOUD_TOKEN: TOKEN });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('must be set together (missing TABULA_CLOUD_URL, TABULA_CLOUD_WORKSPACE_ID)');
    expect(out.stderr.match(/Deprecated environment variables/g)).toHaveLength(1);
    expect(out.stderr).toContain('MIRA_CLOUD_TOKEN (use TABULA_CLOUD_TOKEN)');
  });
});

// ---------------------------------------------------------------- off

describe('without the cloud variables', () => {
  it('has no internal or billing routes, and no workspace in /api/me', async () => {
    const srv = await launch();
    const c = client(srv);
    const owner = await c.signIn(OWNER);
    expect((await c.internal('GET', '/api/internal/usage')).status).toBe(404);
    expect((await c.internal('PUT', '/api/internal/limits', { readOnly: true })).status).toBe(404);
    expect((await c.api(owner.cookie, 'POST', '/api/billing/portal')).status).toBe(404);
    expect((await c.api(owner.cookie, 'GET', '/api/me')).body).toEqual({ user: owner.user, teams: [] });
    expect(seen).toEqual([]);
  });

  it('ignores the variables when accounts mode is off', async () => {
    const srv = await launch({ ...CLOUD_ENV(), TABULA_AUTH: 'off' });
    const c = client(srv);
    expect((await c.api(undefined, 'GET', '/api/config')).body).toEqual({ authEnabled: false });
    expect((await c.internal('GET', '/api/internal/usage')).status).toBe(404);
  });
});

// ---------------------------------------------------------------- on

describe('a hosted workspace', () => {
  let srv: Server;
  let c: ReturnType<typeof client>;
  let owner: Account;

  beforeAll(async () => {
    srv = await launch(CLOUD_ENV());
    c = client(srv);
    owner = await c.signIn(OWNER);
  });

  describe('internal endpoints', () => {
    it('refuse a missing or wrong token and accept the right one with no cookie', async () => {
      for (const token of [null, 'nope', 'c'.repeat(47), 'c'.repeat(49)]) {
        expect((await c.internal('GET', '/api/internal/usage', undefined, token)).status).toBe(401);
        expect((await c.internal('PUT', '/api/internal/limits', { readOnly: true }, token)).status).toBe(401);
      }
      expect((await c.api(owner.cookie, 'GET', '/api/internal/usage')).status).toBe(401);
      const usage = await c.internal('GET', '/api/internal/usage');
      expect(usage.status).toBe(200);
      expect(usage.body).toEqual({ seats: 1, guests: 0, members: 1 });
    });

    it('validate strictly and answer with what is stored, leaving an audit row with no actor', async () => {
      for (const body of [{}, { seatLimit: 0 }, { readOnly: 'yes' }, { banner: 'a\nb' }, { nope: 1 }]) {
        expect((await c.internal('PUT', '/api/internal/limits', body)).status).toBe(400);
      }
      const set = await c.internal('PUT', '/api/internal/limits', { seatLimit: 50, banner: 'Welcome' });
      expect(set).toMatchObject({ status: 200, body: { seatLimit: 50, readOnly: false, banner: 'Welcome' } });

      const me = await c.api(owner.cookie, 'GET', '/api/me');
      expect(me.body.workspace).toEqual({ readOnly: false, banner: 'Welcome', seatLimit: 50, seatsUsed: 1 });

      const audit = await c.api(owner.cookie, 'GET', '/api/admin/audit?action=cloud.');
      expect(audit.body.entries[0]).toMatchObject({
        action: 'cloud.limits',
        actorId: null,
        actorEmail: null,
        detail: { seatLimit: 50, readOnly: false, banner: 'Welcome' },
      });
      await c.internal('PUT', '/api/internal/limits', { seatLimit: null, banner: null });
    });
  });

  describe('read-only', () => {
    it('refuses writes over HTTP while sign-in, reading and the limits endpoint keep working', async () => {
      const member = await c.joinTeam(owner.cookie, (await c.newTeam(owner.cookie)).id);
      await c.internal('PUT', '/api/internal/limits', { readOnly: true, banner: 'Payment overdue' });
      try {
        const refused = await c.api(owner.cookie, 'POST', '/api/teams', { name: 'Nope' });
        expect(refused.status).toBe(402);
        expect(refused.body).toMatchObject({ error: 'read_only' });
        expect((await c.api(member.cookie, 'POST', '/api/boards', { id: unique('b') })).status).toBe(402);
        expect((await c.api(owner.cookie, 'GET', '/api/teams')).status).toBe(200);
        expect((await c.api(owner.cookie, 'GET', '/api/me')).body.workspace).toMatchObject({ readOnly: true, banner: 'Payment overdue' });
        const again = await c.signIn(member.email);
        expect(again.user.id).toBe(member.user.id);
        expect((await c.api(again.cookie, 'POST', '/api/auth/logout')).status).toBe(204);
      } finally {
        await c.internal('PUT', '/api/internal/limits', { readOnly: false, banner: null });
      }
      expect((await c.api(owner.cookie, 'POST', '/api/teams', { name: 'Fine now' })).status).toBe(201);
    });

    it('drops board and comment updates from open sockets and new ones, and lets writes resume', async () => {
      const team = await c.newTeam(owner.cookie);
      const editor = await c.joinTeam(owner.cookie, team.id);
      const reader = await c.joinTeam(owner.cookie, team.id);
      const board = await c.newBoard(editor.cookie, { teamId: team.id });

      const boardA = c.connect(board, editor.cookie);
      const boardB = c.connect(board, reader.cookie);
      const talkA = c.connect(`${board}~comments`, editor.cookie);
      const talkB = c.connect(`${board}~comments`, reader.cookie);
      // Edits that were dropped leave a gap the server cannot fill until the client syncs again, so writing after the lock needs a socket that wrote nothing during it.
      const quietBoard = c.connect(board, editor.cookie);
      const quietTalk = c.connect(`${board}~comments`, editor.cookie);
      for (const x of [boardA, boardB, talkA, talkB, quietBoard, quietTalk]) await c.synced(x);

      boardA.doc.getMap('objects').set('before', 1);
      talkA.doc.getMap('threads').set('before', 1);
      await until(() => boardB.doc.getMap('objects').get('before') === 1 && talkB.doc.getMap('threads').get('before') === 1);

      expect((await c.internal('PUT', '/api/internal/limits', { readOnly: true })).status).toBe(200);
      try {
        boardA.doc.getMap('objects').set('during', 2);
        talkA.doc.getMap('threads').set('during', 2);
        const late = c.connect(board, editor.cookie);
        await c.synced(late);
        late.doc.getMap('objects').set('late', 3);
        await c.flush(boardA, boardB);
        await c.flush(late, boardB);
        await c.flush(talkA, talkB);
        expect(boardB.doc.getMap('objects').get('during')).toBeUndefined();
        expect(boardB.doc.getMap('objects').get('late')).toBeUndefined();
        expect(talkB.doc.getMap('threads').get('during')).toBeUndefined();
        expect(boardB.doc.getMap('objects').get('before')).toBe(1);
      } finally {
        await c.internal('PUT', '/api/internal/limits', { readOnly: false });
      }

      quietBoard.doc.getMap('objects').set('after', 4);
      quietTalk.doc.getMap('threads').set('after', 4);
      await until(() => boardB.doc.getMap('objects').get('after') === 4 && talkB.doc.getMap('threads').get('after') === 4);
    });
  });

  describe('seat limit', () => {
    it('refuses new invites and sign-ins through them, without using up the invite or the link, until a seat is free', async () => {
      const team = await c.newTeam(owner.cookie);
      const token = await c.invite(owner.cookie, team.id);
      const usage = async () => (await c.internal('GET', '/api/internal/usage')).body as { seats: number; guests: number; members: number };
      const { seats } = await usage();
      try {
        await c.internal('PUT', '/api/internal/limits', { seatLimit: seats });

        const refused = await c.api(owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member' });
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ error: 'seat_limit' });

        const email = `${unique('late')}@example.com`;
        const link = await c.requestLink(email, token);
        expect(link).toMatchObject({ mails: 1, res: { status: 200, body: { ok: true } } });
        const blocked = await c.api(undefined, 'POST', '/api/auth/verify', { token: link.token });
        expect(blocked.status).toBe(409);
        expect(blocked.body).toMatchObject({ error: 'seat_limit' });
        expect(((await c.api(owner.cookie, 'GET', '/api/members')).body as Body[]).some((m) => m.email === email)).toBe(false);
        expect(((await c.api(owner.cookie, 'GET', `/api/teams/${team.id}/invites`)).body as Body[])[0].uses).toBe(0);
        expect(await usage()).toMatchObject({ seats });

        await c.internal('PUT', '/api/internal/limits', { seatLimit: seats + 1 });
        const joined = await c.api(undefined, 'POST', '/api/auth/verify', { token: link.token });
        expect(joined.status).toBe(200);
        expect(joined.body.user.email).toBe(email);
        expect(await usage()).toMatchObject({ seats: seats + 1 });

        expect((await c.api(owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member' })).status).toBe(409);
      } finally {
        await c.internal('PUT', '/api/internal/limits', { seatLimit: null });
      }
    });

    it('refuses to enable a disabled member or promote a guest past the limit', async () => {
      const team = await c.newTeam(owner.cookie);
      const off = await c.joinTeam(owner.cookie, team.id);
      const guest = await c.joinTeam(owner.cookie, team.id);
      expect((await c.api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' })).status).toBe(200);
      expect((await c.api(owner.cookie, 'PATCH', `/api/members/${off.user.id}`, { disabled: true })).status).toBe(200);
      const { seats } = (await c.internal('GET', '/api/internal/usage')).body as { seats: number };
      try {
        await c.internal('PUT', '/api/internal/limits', { seatLimit: seats });
        const enable = await c.api(owner.cookie, 'PATCH', `/api/members/${off.user.id}`, { disabled: false });
        expect(enable).toMatchObject({ status: 409, body: { error: 'seat_limit' } });
        const promote = await c.api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'member' });
        expect(promote).toMatchObject({ status: 409, body: { error: 'seat_limit' } });
        await c.internal('PUT', '/api/internal/limits', { seatLimit: seats + 2 });
        expect((await c.api(owner.cookie, 'PATCH', `/api/members/${off.user.id}`, { disabled: false })).status).toBe(200);
        expect((await c.api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'member' })).status).toBe(200);
      } finally {
        await c.internal('PUT', '/api/internal/limits', { seatLimit: null });
      }
    });
  });

  describe('billing portal', () => {
    it('asks the control plane for the owner and hands back the URL', async () => {
      const res = await c.api(owner.cookie, 'POST', '/api/billing/portal');
      expect(res).toMatchObject({ status: 200, body: { url: PORTAL } });
      expect(portalCalls()).toHaveLength(1);
      expect(portalCalls()[0]).toMatchObject({ method: 'POST', url: `/v1/workspaces/${WORKSPACE}/portal`, authorization: `Bearer ${TOKEN}` });
    });

    it('is for the owner only and answers 502 for a bad answer from the control plane', async () => {
      const team = await c.newTeam(owner.cookie);
      const member = await c.joinTeam(owner.cookie, team.id);
      expect((await c.api(member.cookie, 'POST', '/api/billing/portal')).status).toBe(403);
      expect((await c.api(undefined, 'POST', '/api/billing/portal')).status).toBe(401);
      expect(portalCalls()).toEqual([]);

      reply = { status: 200, body: { url: 'http://billing.example.com/p' } };
      expect((await c.api(owner.cookie, 'POST', '/api/billing/portal')).status).toBe(502);
      reply = { status: 500, body: { error: 'boom' } };
      const failed = await c.api(owner.cookie, 'POST', '/api/billing/portal');
      expect(failed).toMatchObject({ status: 502, body: { error: 'bad_gateway' } });
      expect(JSON.stringify(failed.body)).not.toContain(TOKEN);
    });
  });

  describe('restart', () => {
    it('keeps the limits', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-cloud-keep-'));
      const first = await launch(CLOUD_ENV(), dir);
      const a = client(first);
      const who = await a.signIn(OWNER);
      await a.internal('PUT', '/api/internal/limits', { seatLimit: 7, readOnly: true, banner: 'Kept' });
      await stopRelay(first.proc);

      const second = await launch(CLOUD_ENV(), dir);
      const b = client(second);
      const again = await b.signIn(OWNER);
      expect(again.user.id).toBe(who.user.id);
      expect((await b.api(again.cookie, 'GET', '/api/me')).body.workspace).toEqual({ readOnly: true, banner: 'Kept', seatLimit: 7, seatsUsed: 1 });
      expect((await b.api(again.cookie, 'POST', '/api/teams', { name: 'x' })).status).toBe(402);
    });
  });
});
