import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { openDirectory } from '../server/directory.mjs';
import pkg from '../package.json';

// docs/admin.md. The relay runs as a child process in accounts mode (and once in open mode), exactly as `npm start`
// would: revoking sessions has to close real sockets, and the events that do it only reach the relay in-process.

const BASE_PORT = 21000 + Math.floor(Math.random() * 900);
const OWNER = 'owner@example.com';
const DAY = 24 * 60 * 60 * 1000;

type Body = any;
type Res = { status: number; body: Body; headers: Headers; text: string };
type Account = { cookie: string; token: string; user: Body; email: string };
type Server = { port: number; base: string; dir: string; proc: ChildProcess };
type Client = ReturnType<typeof client>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const within = <T>(p: Promise<T>, ms = 4000) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error('timed out')))]) as Promise<T>;

async function eventually(fn: () => Promise<void>, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(50);
    }
  }
}

const startRelay = (port: number, dir: string, env: Record<string, string>) =>
  new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ['server/relay.mjs'], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        HOST: '127.0.0.1',
        TABULA_AUTH: 'on',
        TABULA_OWNER_EMAIL: OWNER,
        TABULA_MAIL: 'file',
        TABULA_BASE_URL: `http://127.0.0.1:${port}`,
        TABULA_TRUST_PROXY: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

const servers: Server[] = [];

async function launch(env: Record<string, string> = {}): Promise<Server> {
  const port = BASE_PORT + servers.length;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-admin-'));
  const server = { port, base: `http://127.0.0.1:${port}`, dir, proc: await startRelay(port, dir, env) };
  servers.push(server);
  return server;
}

afterAll(async () => {
  for (const s of servers) {
    if (s.proc.exitCode === null && s.proc.signalCode === null) await stopRelay(s.proc);
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

const sockets = new Set<WebSocket>();
afterEach(() => {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
});

let seq = 0;
const unique = (tag: string) => `${tag}${++seq}x${Math.random().toString(36).slice(2, 7)}`;
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function client(srv: Server) {
  const outbox = path.join(srv.dir, 'outbox.jsonl');
  let ipSeq = 0;
  const nextIp = () => `10.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}.7`;

  async function api(cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(srv.base + urlPath, {
      method,
      headers: {
        'x-tabula': '1',
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers, text };
  }

  const mails = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean) : []);

  async function signIn(email: string, invite?: string): Promise<Account> {
    const before = mails().length;
    const asked = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': nextIp() });
    const sent = mails().slice(before);
    if (asked.status !== 200 || sent.length !== 1) throw new Error(`no sign-in mail for ${email} (status ${asked.status})`);
    const token = decodeURIComponent(/token=([^\s&"\\]+)/.exec(JSON.parse(sent[0]).text)![1]);
    const verify = await api(undefined, 'POST', '/api/auth/verify', { token });
    if (verify.status !== 200) throw new Error(`verify failed with ${verify.status}`);
    const session = /tabula_session=([^;]+)/.exec(verify.headers.getSetCookie()[0])![1];
    return { cookie: `tabula_session=${session}`, token: session, user: verify.body.user, email };
  }

  async function newTeam(cookie: string, name = unique('Team')) {
    const res = await api(cookie, 'POST', '/api/teams', { name });
    if (res.status !== 201) throw new Error(`could not create a team (${res.status})`);
    return res.body as Body;
  }

  async function invite(cookie: string, teamId: string) {
    const res = await api(cookie, 'POST', `/api/teams/${teamId}/invites`, { role: 'member' });
    if (res.status !== 201) throw new Error(`could not create an invite (${res.status})`);
    return res.body.token as string;
  }

  async function joinTeam(adminCookie: string, teamId: string, role?: 'admin' | 'guest' | 'owner') {
    const account = await signIn(`${unique('user')}@example.com`, await invite(adminCookie, teamId));
    if (role) {
      const res = await api(adminCookie, 'PATCH', `/api/members/${account.user.id}`, { role });
      if (res.status !== 200) throw new Error(`could not make ${role} (${res.status})`);
      account.user.role = role;
    }
    return account;
  }

  async function newBoard(cookie: string, extra: Record<string, unknown> = {}) {
    const id = unique('board');
    const res = await api(cookie, 'POST', '/api/boards', { id, ...extra });
    if (res.status !== 201) throw new Error(`could not create a board (${res.status} ${JSON.stringify(res.body)})`);
    return id;
  }

  function rawSocket(board: string, cookie: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/sync/${board}`, { headers: { Origin: srv.base, Cookie: cookie } });
    sockets.add(ws);
    ws.on('error', () => {});
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    const joined = new Promise<void>((resolve) => ws.once('message', () => resolve()));
    return { ws, closed, joined };
  }

  const health = async () => (await fetch(`${srv.base}/api/health`).then((r) => r.json())) as { ok: boolean; rooms: number; connections: number };

  const sessionsOf = async (cookie: string, userId: string) =>
    ((await api(cookie, 'GET', '/api/admin/sessions')).body as Body[]).filter((s) => s.userId === userId);

  const auditOf = async (cookie: string, action: string) => (await api(cookie, 'GET', `/api/admin/audit?limit=200&action=${encodeURIComponent(action)}`)).body.entries as Body[];

  return { api, signIn, newTeam, invite, joinTeam, newBoard, rawSocket, health, sessionsOf, auditOf };
}

const keys = (value: object) => Object.keys(value).sort();

// For setup code outside a test body, where `expect` is not allowed.
function ensure(res: Res, status: number) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${res.text}`);
}

const BOARD_KEYS = ['createdAt', 'deletedAt', 'id', 'ownerId', 'ownerName', 'shareCount', 'teamId', 'teamName', 'title', 'updatedAt'];

// ---------------------------------------------------------------- access

describe('admin API access', () => {
  let srv: Server;
  let c: Client;
  let owner: Account;
  let admin: Account;
  let member: Account;
  let guest: Account;
  let victim: Account;
  let board: string;
  let calls: [string, string][];

  beforeAll(async () => {
    srv = await launch();
    c = client(srv);
    owner = await c.signIn(OWNER);
    const team = await c.newTeam(owner.cookie);
    admin = await c.joinTeam(owner.cookie, team.id, 'admin');
    member = await c.joinTeam(owner.cookie, team.id);
    guest = await c.joinTeam(owner.cookie, team.id, 'guest');
    victim = await c.joinTeam(owner.cookie, team.id);
    board = await c.newBoard(victim.cookie);
    ensure(await c.api(victim.cookie, 'DELETE', `/api/boards/${board}`), 204);
    const [victimSession] = await c.sessionsOf(owner.cookie, victim.user.id);
    calls = [
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/members'],
      ['POST', `/api/admin/members/${victim.user.id}/revoke-sessions`],
      ['GET', '/api/admin/sessions'],
      ['DELETE', `/api/admin/sessions/${victimSession.id}`],
      ['GET', '/api/admin/boards'],
      ['POST', `/api/admin/boards/${board}/restore`],
      ['GET', '/api/admin/audit'],
      ['GET', `/api/admin/boards/${board}`],
    ];
  });

  it('answers 401 when signed out, with no cookie or an unknown one', async () => {
    for (const [method, url] of calls) {
      for (const cookie of [undefined, 'tabula_session=not-a-session']) {
        const res = await c.api(cookie, method, url);
        expect([method, url, res.status, res.body.error]).toEqual([method, url, 401, 'unauthenticated']);
      }
    }
  });

  it('answers 403 to members and guests and changes nothing', async () => {
    for (const who of [member, guest]) {
      for (const [method, url] of calls) {
        const res = await c.api(who.cookie, method, url);
        expect([who.email, method, url, res.status, res.body.error]).toEqual([who.email, method, url, 403, 'forbidden']);
      }
    }
    expect((await c.api(victim.cookie, 'GET', '/api/me')).status).toBe(200);
    const boards = (await c.api(owner.cookie, 'GET', '/api/admin/boards?deleted=1')).body as Body[];
    expect(boards.find((b) => b.id === board)!.deletedAt).toEqual(expect.any(Number));
    expect(await c.auditOf(owner.cookie, 'admin.')).toEqual([]);
    expect(await c.auditOf(owner.cookie, 'board.restore')).toEqual([]);
  });

  it('lets workspace owners and admins read every list', async () => {
    for (const who of [owner, admin]) {
      for (const [method, url] of calls.filter(([m]) => m === 'GET')) {
        expect([who.email, url, (await c.api(who.cookie, method, url)).status]).toEqual([who.email, url, 200]);
      }
    }
  });

  it('applies the CSRF rules to mutations', async () => {
    for (const [method, url] of [calls[2], calls[4], calls[6]]) {
      const bare = await c.api(owner.cookie, method, url, undefined, { 'x-tabula': '' });
      expect([method, bare.status, bare.body.error]).toEqual([method, 403, 'csrf']);
      const foreign = await c.api(owner.cookie, method, url, undefined, { origin: 'http://evil.example' });
      expect([method, foreign.status, foreign.body.error]).toEqual([method, 403, 'csrf']);
    }
    expect((await c.api(victim.cookie, 'GET', '/api/me')).status).toBe(200);
    expect(await c.auditOf(owner.cookie, 'admin.')).toEqual([]);
  });

  it('answers 404 to unknown admin paths', async () => {
    expect((await c.api(owner.cookie, 'GET', '/api/admin/nothing')).status).toBe(404);
    expect((await c.api(owner.cookie, 'GET', '/api/admin')).status).toBe(404);
  });

  it('answers 404 to every admin route in open mode', async () => {
    const open = await launch({ TABULA_AUTH: 'off' });
    const oc = client(open);
    for (const [method, url] of calls) {
      const res = await oc.api(undefined, method, url);
      expect([method, url, res.status, res.body]).toEqual([method, url, 404, { error: 'not_found' }]);
    }
  });
});

// ---------------------------------------------------------------- overview, members, sessions

describe('admin overview, members and sessions', () => {
  let srv: Server;
  let c: Client;
  let owner: Account;
  let admin: Account;
  let team: Body;
  const everyone: Account[] = [];

  beforeAll(async () => {
    srv = await launch();
    c = client(srv);
    owner = await c.signIn(OWNER);
    team = await c.newTeam(owner.cookie, 'Crew');
    admin = await c.joinTeam(owner.cookie, team.id, 'admin');
    everyone.push(owner, admin);
  });

  it('counts exactly what the other admin endpoints list', async () => {
    const member = await c.joinTeam(owner.cookie, team.id);
    const off = await c.joinTeam(owner.cookie, team.id);
    const guest = await c.joinTeam(owner.cookie, team.id, 'guest');
    everyone.push(member, off, guest);
    expect((await c.api(owner.cookie, 'PATCH', `/api/members/${off.user.id}`, { disabled: true })).status).toBe(200);
    const archived = await c.newTeam(owner.cookie, 'Old');
    expect((await c.api(owner.cookie, 'PATCH', `/api/teams/${archived.id}`, { archived: true })).status).toBe(200);
    const kept = await c.newBoard(member.cookie, { teamId: team.id });
    const gone = await c.newBoard(member.cookie);
    expect((await c.api(member.cookie, 'DELETE', `/api/boards/${gone}`)).status).toBe(204);
    const socket = c.rawSocket(kept, member.cookie);
    await within(socket.joined);

    const overview = (await c.api(owner.cookie, 'GET', '/api/admin/overview')).body;
    expect(keys(overview)).toEqual(['boards', 'instance', 'live', 'members', 'sessions', 'signIns7d', 'teams']);
    expect(keys(overview.members)).toEqual(['active', 'byRole', 'disabled', 'total']);
    expect(keys(overview.members.byRole)).toEqual(['admin', 'guest', 'member', 'owner']);
    expect(keys(overview.teams)).toEqual(['archived', 'total']);
    expect(keys(overview.boards)).toEqual(['deleted', 'total']);
    expect(keys(overview.sessions)).toEqual(['active']);
    expect(keys(overview.live)).toEqual(['connections', 'rooms']);

    const members = (await c.api(owner.cookie, 'GET', '/api/admin/members')).body as Body[];
    const roleCount = (role: string) => members.filter((m) => m.role === role).length;
    expect(overview.members).toEqual({
      total: members.length,
      active: members.filter((m) => !m.disabled).length,
      disabled: 1,
      byRole: { owner: roleCount('owner'), admin: roleCount('admin'), member: roleCount('member'), guest: roleCount('guest') },
    });
    expect(overview.members.byRole).toEqual({ owner: 1, admin: 1, member: 2, guest: 1 });

    const teams = (await c.api(owner.cookie, 'GET', '/api/teams')).body as Body[];
    expect(overview.teams).toEqual({ total: teams.length, archived: teams.filter((t) => t.archived).length });
    expect(overview.teams).toEqual({ total: 2, archived: 1 });

    const boards = (await c.api(owner.cookie, 'GET', '/api/admin/boards?deleted=1')).body as Body[];
    expect(overview.boards).toEqual({ total: boards.length, deleted: boards.filter((b) => b.deletedAt !== null).length });
    expect(overview.boards).toEqual({ total: 2, deleted: 1 });

    expect(overview.sessions.active).toBe(((await c.api(owner.cookie, 'GET', '/api/admin/sessions')).body as Body[]).length);
    expect(overview.sessions.active).toBe(4); // the disabled member's session ended with the disable

    await eventually(async () => {
      const health = await c.health();
      const live = (await c.api(owner.cookie, 'GET', '/api/admin/overview')).body.live;
      expect(live).toEqual({ rooms: health.rooms, connections: health.connections });
      expect(live.connections).toBeGreaterThanOrEqual(1);
      expect(live.rooms).toBeGreaterThanOrEqual(1);
    });

    expect(overview.instance).toEqual({ authEnabled: true, baseUrl: srv.base, mail: 'file', version: pkg.version });
  });

  it('counts sign-ins of the last seven days', async () => {
    const read = async () => (await c.api(owner.cookie, 'GET', '/api/admin/overview')).body.signIns7d as number;
    const before = await read();
    expect(before).toBeGreaterThanOrEqual(1);
    const person = await c.joinTeam(owner.cookie, team.id);
    everyone.push(person);
    expect(await read()).toBe(before + 1);
    expect(await read()).toBe(before + 1);
    expect(await c.auditOf(owner.cookie, 'auth.login')).toHaveLength(before + 1);
  });

  it('lists members with their activity', async () => {
    const other = await c.newTeam(owner.cookie, 'Other');
    const person = await c.joinTeam(owner.cookie, team.id);
    const second = await c.signIn(person.email);
    everyone.push(person, second);
    expect((await c.api(person.cookie, 'POST', `/api/invites/${await c.invite(owner.cookie, other.id)}/accept`)).status).toBe(200);
    await c.newBoard(person.cookie);
    await c.newBoard(person.cookie, { teamId: team.id });
    const gone = await c.newBoard(person.cookie);
    await c.newBoard(owner.cookie);
    expect((await c.api(person.cookie, 'DELETE', `/api/boards/${gone}`)).status).toBe(204);

    const list = await c.api(owner.cookie, 'GET', '/api/admin/members');
    const row = (list.body as Body[]).find((m) => m.id === person.user.id)!;
    expect(keys(row)).toEqual(['activeSessions', 'boardCount', 'createdAt', 'disabled', 'email', 'id', 'lastSeenAt', 'name', 'role', 'teams']);
    expect(row).toMatchObject({ email: person.email, role: 'member', disabled: false, activeSessions: 2, boardCount: 2 });
    expect(row.createdAt).toEqual(expect.any(Number));
    expect(row.teams).toEqual([
      { id: team.id, name: 'Crew', role: 'member' },
      { id: other.id, name: 'Other', role: 'member' },
    ]);
    expect(keys(row.teams[0])).toEqual(['id', 'name', 'role']);
    const sessions = await c.sessionsOf(owner.cookie, person.user.id);
    expect(row.lastSeenAt).toBe(Math.max(...sessions.map((s) => s.lastSeen)));

    const ownerRow = (list.body as Body[]).find((m) => m.id === owner.user.id)!;
    expect(ownerRow).toMatchObject({ role: 'owner', boardCount: 1 });
    expect(ownerRow.teams.map((t: Body) => t.role)).toContain('admin');
  });

  it('lists active sessions, newest first, with the caller marked and no secrets', async () => {
    const person = await c.joinTeam(owner.cookie, team.id);
    const second = await c.signIn(person.email);
    everyone.push(person, second);
    expect((await c.api(person.cookie, 'POST', '/api/auth/logout')).status).toBe(204);

    const res = await c.api(admin.cookie, 'GET', '/api/admin/sessions');
    const list = res.body as Body[];
    for (const s of list) expect(keys(s)).toEqual(['createdAt', 'current', 'email', 'expiresAt', 'id', 'lastSeen', 'userId', 'userName']);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.find((s) => s.current)).toMatchObject({ userId: admin.user.id, email: admin.email });
    expect(list.map((s) => s.lastSeen)).toEqual(list.map((s) => s.lastSeen).sort((a, b) => b - a));
    expect(list.filter((s) => s.userId === person.user.id)).toHaveLength(1);
    expect(list.every((s) => s.expiresAt > Date.now())).toBe(true);
    expect(list.find((s) => s.userId === person.user.id)).toMatchObject({ userName: person.email.split('@')[0], current: false });

    for (const body of [res.text, (await c.api(owner.cookie, 'GET', '/api/admin/members')).text]) {
      for (const who of everyone) {
        expect(body).not.toContain(who.token);
        expect(body).not.toContain(sha256(who.token));
      }
      expect(body).not.toMatch(/"[A-Za-z_]*(token|hash)[A-Za-z_]*"\s*:/i);
    }
  });

  it('signs a member out everywhere: cookies die, every socket closes, nobody else is touched', async () => {
    const mate = await c.joinTeam(owner.cookie, team.id);
    const victim = await c.joinTeam(owner.cookie, team.id);
    const phone = await c.signIn(victim.email);
    everyone.push(mate, victim, phone);
    const board = await c.newBoard(victim.cookie, { teamId: team.id });
    const a = c.rawSocket(board, victim.cookie);
    const b = c.rawSocket(board, phone.cookie);
    const bystander = c.rawSocket(board, mate.cookie);
    await within(Promise.all([a.joined, b.joined, bystander.joined]));

    const res = await c.api(admin.cookie, 'POST', `/api/admin/members/${victim.user.id}/revoke-sessions`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await within(Promise.all([a.closed, b.closed]))).toEqual([4401, 4401]);
    expect((await c.api(victim.cookie, 'GET', '/api/me')).status).toBe(401);
    expect((await c.api(phone.cookie, 'GET', '/api/me')).status).toBe(401);
    expect(await c.sessionsOf(owner.cookie, victim.user.id)).toEqual([]);
    await sleep(1200);
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN);
    expect((await c.api(mate.cookie, 'GET', '/api/me')).status).toBe(200);

    const row = ((await c.api(owner.cookie, 'GET', '/api/admin/members')).body as Body[]).find((m) => m.id === victim.user.id)!;
    expect(row).toMatchObject({ disabled: false, activeSessions: 0, role: 'member' });
    expect(row.lastSeenAt).toEqual(expect.any(Number));
    const [entry] = await c.auditOf(owner.cookie, 'admin.sessions.revoke');
    expect(entry).toMatchObject({ actorId: admin.user.id, actorEmail: admin.email, action: 'admin.sessions.revoke', detail: { userId: victim.user.id, count: 2 } });

    const again = await c.signIn(victim.email);
    everyone.push(again);
    expect((await c.api(again.cookie, 'GET', '/api/me')).status).toBe(200);
  });

  it('refuses unknown members and protects owners', async () => {
    expect((await c.api(admin.cookie, 'POST', '/api/admin/members/nobody/revoke-sessions')).status).toBe(404);
    expect((await c.api(admin.cookie, 'POST', '/api/admin/members/nobody/revoke-sessions')).body.error).toBe('not_found');

    const second = await c.joinTeam(owner.cookie, team.id, 'owner');
    everyone.push(second);
    const denied = await c.api(admin.cookie, 'POST', `/api/admin/members/${second.user.id}/revoke-sessions`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden');
    const [theirs] = await c.sessionsOf(owner.cookie, second.user.id);
    expect((await c.api(admin.cookie, 'DELETE', `/api/admin/sessions/${theirs.id}`)).status).toBe(403);
    expect((await c.api(second.cookie, 'GET', '/api/me')).status).toBe(200);

    expect((await c.api(second.cookie, 'POST', `/api/admin/members/${admin.user.id}/revoke-sessions`)).status).toBe(204);
    expect((await c.api(admin.cookie, 'GET', '/api/me')).status).toBe(401);
    admin = await c.signIn(admin.email);
    everyone.push(admin);
  });

  it('lets an admin sign themselves out, clearing the cookie', async () => {
    const self = await c.joinTeam(owner.cookie, team.id, 'admin');
    everyone.push(self);
    const res = await c.api(self.cookie, 'POST', `/api/admin/members/${self.user.id}/revoke-sessions`);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await c.api(self.cookie, 'GET', '/api/me')).status).toBe(401);
  });

  it('revokes one session only: that socket and cookie die, the same person stays in elsewhere', async () => {
    const person = await c.joinTeam(owner.cookie, team.id);
    const [first] = await c.sessionsOf(owner.cookie, person.user.id);
    const phone = await c.signIn(person.email);
    everyone.push(person, phone);
    const sessions = await c.sessionsOf(owner.cookie, person.user.id);
    expect(sessions).toHaveLength(2);
    const second = sessions.find((s) => s.id !== first.id)!;
    const board = await c.newBoard(person.cookie);
    const a = c.rawSocket(board, person.cookie);
    const b = c.rawSocket(board, phone.cookie);
    await within(Promise.all([a.joined, b.joined]));

    const res = await c.api(admin.cookie, 'DELETE', `/api/admin/sessions/${first.id}`);
    expect(res.status).toBe(204);
    expect(await within(a.closed)).toBe(4401);
    expect((await c.api(person.cookie, 'GET', '/api/me')).status).toBe(401);
    expect((await c.api(phone.cookie, 'GET', '/api/me')).status).toBe(200);
    await sleep(1200);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect((await c.sessionsOf(owner.cookie, person.user.id)).map((s) => s.id)).toEqual([second.id]);
    expect(await within(c.rawSocket(board, person.cookie).closed)).toBe(4401);

    const gone = await c.api(admin.cookie, 'DELETE', `/api/admin/sessions/${first.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('not_found');
    expect((await c.api(admin.cookie, 'DELETE', '/api/admin/sessions/nope')).status).toBe(404);

    const [entry] = await c.auditOf(owner.cookie, 'admin.session.revoke');
    expect(entry).toMatchObject({ actorId: admin.user.id, action: 'admin.session.revoke', detail: { sessionId: first.id, userId: person.user.id } });
  });

  it('lets an admin end their own current session from the list', async () => {
    const self = await c.joinTeam(owner.cookie, team.id, 'admin');
    everyone.push(self);
    const current = ((await c.api(self.cookie, 'GET', '/api/admin/sessions')).body as Body[]).find((s) => s.current)!;
    const res = await c.api(self.cookie, 'DELETE', `/api/admin/sessions/${current.id}`);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await c.api(self.cookie, 'GET', '/api/me')).status).toBe(401);
  });
});

// ---------------------------------------------------------------- boards

describe('admin boards', () => {
  let srv: Server;
  let c: Client;
  let owner: Account;
  let admin: Account;
  let member: Account;
  let team: Body;

  beforeAll(async () => {
    srv = await launch();
    c = client(srv);
    owner = await c.signIn(OWNER);
    team = await c.newTeam(owner.cookie, 'Crew');
    admin = await c.joinTeam(owner.cookie, team.id, 'admin');
    member = await c.joinTeam(owner.cookie, team.id);
  });

  it('lists boards by last update with owner, team and share count, and hides deleted ones by default', async () => {
    const mate = await c.joinTeam(owner.cookie, team.id);
    const shared = await c.newBoard(member.cookie, { title: 'Roadmap', teamId: team.id });
    const personal = await c.newBoard(member.cookie, { title: 'Scratch' });
    const deleted = await c.newBoard(member.cookie, { title: 'Old news' });
    const share = await c.api(member.cookie, 'POST', `/api/boards/${shared}/shares`, { principalType: 'user', principalId: mate.user.id, role: 'viewer' });
    expect(share.status).toBe(201);
    expect((await c.api(member.cookie, 'DELETE', `/api/boards/${deleted}`)).status).toBe(204);

    const res = await c.api(admin.cookie, 'GET', '/api/admin/boards');
    const list = res.body as Body[];
    for (const b of list) expect(keys(b)).toEqual(BOARD_KEYS);
    expect(list.map((b) => b.id)).toEqual(expect.arrayContaining([shared, personal]));
    expect(list.map((b) => b.id)).not.toContain(deleted);
    expect(list.find((b) => b.id === shared)).toMatchObject({
      title: 'Roadmap',
      ownerId: member.user.id,
      ownerName: member.email.split('@')[0],
      teamId: team.id,
      teamName: 'Crew',
      deletedAt: null,
      shareCount: 1,
    });
    expect(list.find((b) => b.id === personal)).toMatchObject({ ownerId: member.user.id, teamId: null, teamName: null, deletedAt: null, shareCount: 0 });
    expect(list.map((b) => b.updatedAt)).toEqual(list.map((b) => b.updatedAt).sort((x, y) => y - x));

    const all = (await c.api(admin.cookie, 'GET', '/api/admin/boards?deleted=1')).body as Body[];
    expect(all.map((b) => b.id)).toEqual(expect.arrayContaining([shared, personal, deleted]));
    expect(all.find((b) => b.id === deleted)).toMatchObject({ title: 'Old news', deletedAt: expect.any(Number) });
    expect(all.map((b) => b.updatedAt)).toEqual(all.map((b) => b.updatedAt).sort((x, y) => y - x));
    const off = (await c.api(admin.cookie, 'GET', '/api/admin/boards?deleted=0')).body as Body[];
    expect(off.map((b) => b.id)).not.toContain(deleted);
  });

  it('restores a deleted board, once, and its owner can open it again', async () => {
    const board = await c.newBoard(member.cookie, { title: 'Back from the dead' });
    expect((await c.api(member.cookie, 'DELETE', `/api/boards/${board}`)).status).toBe(204);
    expect(await within(c.rawSocket(board, member.cookie).closed)).toBe(4404);
    expect(((await c.api(member.cookie, 'GET', '/api/boards')).body as Body[]).map((b) => b.id)).not.toContain(board);
    // an admin can still look a deleted board up, so the app can open it read-only
    const one = await c.api(admin.cookie, 'GET', `/api/admin/boards/${board}`);
    expect(one.status).toBe(200);
    expect(keys(one.body)).toEqual(BOARD_KEYS);
    expect(one.body).toMatchObject({ id: board, deletedAt: expect.any(Number) });
    expect((await c.api(admin.cookie, 'GET', '/api/admin/boards/nobody')).status).toBe(404);

    const res = await c.api(admin.cookie, 'POST', `/api/admin/boards/${board}/restore`);
    expect(res.status).toBe(200);
    expect(keys(res.body)).toEqual([...BOARD_KEYS, 'role'].sort());
    expect(res.body).toMatchObject({ id: board, title: 'Back from the dead', ownerId: member.user.id, deletedAt: null, role: 'owner' });
    const listed = ((await c.api(admin.cookie, 'GET', '/api/admin/boards')).body as Body[]).find((b) => b.id === board)!;
    expect(listed.deletedAt).toBeNull();
    expect(((await c.api(member.cookie, 'GET', '/api/boards')).body as Body[]).map((b) => b.id)).toContain(board);
    await within(c.rawSocket(board, member.cookie).joined);

    const again = await c.api(admin.cookie, 'POST', `/api/admin/boards/${board}/restore`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('not_deleted');
    expect((await c.api(admin.cookie, 'POST', '/api/admin/boards/nobody/restore')).status).toBe(404);
    expect((await c.api(admin.cookie, 'POST', `/api/admin/boards/${await c.newBoard(member.cookie)}/restore`)).status).toBe(409);

    const entries = await c.auditOf(owner.cookie, 'board.restore');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorId: admin.user.id, action: 'board.restore', detail: { boardId: board } });
  });

  it('shows a null owner once the owner has been removed', async () => {
    const leaver = await c.joinTeam(owner.cookie, team.id);
    const board = await c.newBoard(leaver.cookie, { teamId: team.id });
    expect((await c.api(owner.cookie, 'DELETE', `/api/members/${leaver.user.id}`)).status).toBe(204);
    const row = ((await c.api(admin.cookie, 'GET', '/api/admin/boards')).body as Body[]).find((b) => b.id === board)!;
    expect(keys(row)).toEqual(BOARD_KEYS);
    expect(row).toMatchObject({ ownerId: null, ownerName: null, teamId: team.id, teamName: 'Crew' });
  });
});

// ---------------------------------------------------------------- audit

describe('admin audit log', () => {
  let srv: Server;
  let c: Client;
  let owner: Account;
  let member: Account;
  let departed: Account;
  let departedId: string;
  let inviteToken: string;
  const everyone: Account[] = [];

  const page = async (query = '') => (await c.api(owner.cookie, 'GET', `/api/admin/audit${query}`)).body as { entries: Body[]; next: number | null };

  async function walkEntries(query: string, limit: number) {
    const entries: Body[] = [];
    let before: number | null = null;
    for (let guard = 0; guard < 1000; guard++) {
      const res: { entries: Body[]; next: number | null } = await page(`?limit=${limit}${query}${before === null ? '' : `&before=${before}`}`);
      entries.push(...res.entries);
      if (res.next === null) return entries;
      before = res.next;
    }
    throw new Error('the audit log never ended');
  }
  const walk = async (query: string, limit: number) => (await walkEntries(query, limit)).map((e) => e.id as number);

  beforeAll(async () => {
    srv = await launch();
    c = client(srv);
    owner = await c.signIn(OWNER);
    const team = await c.newTeam(owner.cookie, 'Crew');
    inviteToken = await c.invite(owner.cookie, team.id);
    member = await c.joinTeam(owner.cookie, team.id);
    departed = await c.joinTeam(owner.cookie, team.id);
    departedId = departed.user.id;
    everyone.push(owner, member, departed);
    ensure(await c.api(departed.cookie, 'PATCH', '/api/me', { name: 'Soon gone' }), 200);
    ensure(await c.api(member.cookie, 'POST', '/api/auth/logout-all'), 204);
    for (let i = 0; i < 210; i++) ensure(await c.api(owner.cookie, 'PATCH', '/api/me', { name: `Owner ${i}` }), 200);
    ensure(await c.api(owner.cookie, 'DELETE', `/api/members/${departedId}`), 204);
  });

  it('returns newest first with the exact entry shape and the actor joined in', async () => {
    const { entries, next } = await page();
    expect(entries).toHaveLength(50);
    expect(next).toBe(entries[49].id);
    for (const e of entries) expect(keys(e)).toEqual(['action', 'actorEmail', 'actorId', 'actorName', 'detail', 'id', 'ts']);
    expect(entries.map((e) => e.id)).toEqual(entries.map((e) => e.id).sort((a, b) => b - a));
    expect(entries[0]).toMatchObject({ action: 'member.remove', actorId: owner.user.id, actorName: 'Owner 209', actorEmail: OWNER, detail: { userId: departedId } });
    expect(entries[0].ts).toBeLessThanOrEqual(Date.now());
    expect(entries[1]).toMatchObject({ action: 'me.update', detail: {} });
  });

  it('clamps the limit to 1..200 and falls back to 50', async () => {
    expect((await page('?limit=0')).entries).toHaveLength(1);
    expect((await page('?limit=-5')).entries).toHaveLength(1);
    expect((await page('?limit=7.9')).entries).toHaveLength(7);
    expect((await page('?limit=1000')).entries).toHaveLength(200);
    expect((await page('?limit=200')).entries).toHaveLength(200);
    expect((await page('?limit=abc')).entries).toHaveLength(50);
    expect((await page('?limit=')).entries).toHaveLength(50);
  });

  it('pages by id with before, never repeating or skipping an entry, and ends with next null', async () => {
    const whole = await walk('', 200);
    expect(whole.length).toBeGreaterThan(210);
    expect(new Set(whole).size).toBe(whole.length);
    expect(whole).toEqual([...whole].sort((a, b) => b - a));

    expect(await walk('', 37)).toEqual(whole);
    expect(await walk('', 1)).toEqual(whole);

    const exact = await page(`?limit=${Math.min(whole.length, 200)}`);
    expect(exact.next).toBe(whole.length > 200 ? exact.entries[199].id : null);
    const lastPage = await page(`?limit=200&before=${whole[whole.length - 1]}`);
    expect(lastPage).toEqual({ entries: [], next: null });

    const middle = whole[100];
    const after = await page(`?limit=3&before=${middle}`);
    expect(after.entries.map((e) => e.id)).toEqual(whole.slice(101, 104));
    expect(after.next).toBe(whole[103]);
  });

  it('ends the log with next null when the last page is exactly full', async () => {
    const whole = await walk('&action=auth.', 200);
    expect(whole.length).toBeGreaterThanOrEqual(3);
    const full = await page(`?action=auth.&limit=${whole.length}`);
    expect(full.entries.map((e) => e.id)).toEqual(whole);
    expect(full.next).toBeNull();
    const short = await page(`?action=auth.&limit=${whole.length - 1}`);
    expect(short.next).toBe(whole[whole.length - 2]);
  });

  it('rejects an invalid before or an oversized action', async () => {
    for (const before of ['abc', '-1', '1.5', '1e3', '9'.repeat(30)]) {
      const res = await c.api(owner.cookie, 'GET', `/api/admin/audit?before=${before}`);
      expect([before, res.status, res.body.error]).toEqual([before, 400, 'bad_request']);
    }
    expect((await c.api(owner.cookie, 'GET', `/api/admin/audit?action=${'a'.repeat(101)}`)).status).toBe(400);
    expect((await page(`?action=${'a'.repeat(100)}`)).entries).toEqual([]);
  });

  it('filters by literal, case-sensitive action prefix', async () => {
    const mine = (await page('?action=me.update&limit=200')).entries;
    expect(mine).toHaveLength(200);
    expect(mine.every((e) => e.action === 'me.update')).toBe(true);
    expect(await walk('&action=me.update', 200)).toHaveLength(211);
    expect(await walk('&action=me.', 50)).toHaveLength(211);
    expect(await walk('&action=me', 200)).toHaveLength(212); // member.remove starts with "me" too

    const auth = await walk('&action=auth.', 200);
    expect(auth.length).toBeGreaterThan(3);
    const actions = (await page('?action=auth.&limit=200')).entries.map((e) => e.action);
    expect(actions.every((a) => a.startsWith('auth.'))).toBe(true);
    expect(actions).toEqual(expect.arrayContaining(['auth.login', 'auth.logout_all']));
    expect((await page('?action=auth.logout_&limit=200')).entries.map((e) => e.action)).toEqual(['auth.logout_all']);
    expect((await page('?action=member.&limit=200')).entries.map((e) => e.action)).toEqual(['member.remove']);
    expect((await page('?action=')).entries).toHaveLength(50);

    for (const action of ['%', '_', '\\', 'me%', 'me_update', 'me.update%', 'me.updat_', '%.update', 'ME.UPDATE', 'Me.', 'AUTH.']) {
      const res = await page(`?action=${encodeURIComponent(action)}`);
      expect([action, res]).toEqual([action, { entries: [], next: null }]);
    }
  });

  it('names the actor, or null when the user is gone', async () => {
    const theirs = (await walkEntries('&action=me.update', 200)).filter((e) => e.actorId === departedId);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ actorId: departedId, actorName: null, actorEmail: null });
    const logins = (await page('?action=auth.login&limit=200')).entries;
    expect(logins.filter((e) => e.actorId === departedId)).toHaveLength(1);
    expect(logins.find((e) => e.actorId === member.user.id)).toMatchObject({ actorEmail: member.email, actorName: member.email.split('@')[0] });
  });

  it('never exposes tokens or hashes in any admin response', async () => {
    const texts = [
      ...(await Promise.all(
        ['overview', 'members', 'sessions', 'boards?deleted=1', 'audit?limit=200', 'audit?limit=200&action=invite.', 'audit?limit=200&action=auth.'].map(async (p) => (await c.api(owner.cookie, 'GET', `/api/admin/${p}`)).text),
      )),
      JSON.stringify(await walkEntries('&action=', 200)),
    ];
    expect((await page('?action=invite.create&limit=200')).entries.length).toBeGreaterThanOrEqual(2);
    for (const text of texts) {
      for (const secret of [inviteToken, sha256(inviteToken), ...everyone.flatMap((a) => [a.token, sha256(a.token)])]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/token_hash|tokenHash/);
    }
  });
});

// ---------------------------------------------------------------- the last owner

describe('the last owner through the existing endpoints', () => {
  it('cannot be demoted, disabled or removed, while signing themselves out stays possible', async () => {
    const srv = await launch();
    const c = client(srv);
    const owner = await c.signIn(OWNER);
    for (const patch of [{ role: 'admin' }, { disabled: true }]) {
      const res = await c.api(owner.cookie, 'PATCH', `/api/members/${owner.user.id}`, patch);
      expect([res.status, res.body.error]).toEqual([409, 'last_owner']);
    }
    const removal = await c.api(owner.cookie, 'DELETE', `/api/members/${owner.user.id}`);
    expect([removal.status, removal.body.error]).toEqual([409, 'last_owner']);

    expect((await c.api(owner.cookie, 'POST', `/api/admin/members/${owner.user.id}/revoke-sessions`)).status).toBe(204);
    expect((await c.api(owner.cookie, 'GET', '/api/me')).status).toBe(401);
    const back = await c.signIn(OWNER);
    const me = await c.api(back.cookie, 'GET', '/api/me');
    expect(me.body.user).toMatchObject({ id: owner.user.id, role: 'owner' });
    const row = ((await c.api(back.cookie, 'GET', '/api/admin/members')).body as Body[]).find((m) => m.id === owner.user.id)!;
    expect(row).toMatchObject({ disabled: false, role: 'owner', activeSessions: 1 });
  });
});

// ---------------------------------------------------------------- directory queries

describe('directory queries for the admin console', () => {
  const open = () => {
    const d = openDirectory(':memory:');
    return d;
  };

  it('counts sign-ins inside the seven day window only', () => {
    const d = open();
    const user = d.createUser({ email: 'a@example.com', role: 'owner' })!;
    const t0 = Date.now();
    d.audit(user.id, 'auth.login');
    d.audit(user.id, 'auth.logout');
    d.audit(user.id, 'auth.login_extra');
    const t1 = Date.now();
    expect(d.adminStats(t1).signIns7d).toBe(1);
    expect(d.adminStats(t0 + 7 * DAY).signIns7d).toBe(1);
    expect(d.adminStats(t1 + 7 * DAY + 1).signIns7d).toBe(0);
    d.close();
  });

  it('counts only live sessions, and reports never-seen members with null', () => {
    const d = open();
    const idle = d.createUser({ email: 'idle@example.com', role: 'member' })!;
    const busy = d.createUser({ email: 'busy@example.com', role: 'member' })!;
    const t = Date.now();
    const kept = d.createSession(busy.id, { ttlMs: DAY, now: t });
    const revoked = d.createSession(busy.id, { ttlMs: DAY, now: t + 5 });
    const short = d.createSession(busy.id, { ttlMs: 1000, now: t + 10 });
    d.revokeSession(revoked.id);

    const find = (now: number, id: string) => d.listMembersAdmin(now).find((m) => m.id === id)!;
    expect(find(t + 20, idle.id)).toMatchObject({ lastSeenAt: null, activeSessions: 0, boardCount: 0 });
    expect(find(t + 20, busy.id)).toMatchObject({ lastSeenAt: t + 10, activeSessions: 2 });
    expect(find(t + 2000, busy.id)).toMatchObject({ lastSeenAt: t + 10, activeSessions: 1 });
    expect(d.adminStats(t + 20).sessions.active).toBe(2);
    expect(d.adminStats(t + 2000).sessions.active).toBe(1);
    expect(d.adminStats(t + 2 * DAY).sessions.active).toBe(0);

    expect(d.listActiveSessions(t + 20).map((s) => s.id)).toEqual([short.id, kept.id]);
    expect(d.listActiveSessions(t + 2000).map((s) => s.id)).toEqual([kept.id]);
    expect(keys(d.listActiveSessions(t + 20)[0])).toEqual(['createdAt', 'email', 'expiresAt', 'id', 'lastSeen', 'userId', 'userName']);
    expect(d.getActiveSession(kept.id, t + 20)).toMatchObject({ id: kept.id, userId: busy.id, email: 'busy@example.com' });
    expect(d.getActiveSession(revoked.id, t + 20)).toBeNull();
    expect(d.getActiveSession(short.id, t + 2000)).toBeNull();
    expect(d.getActiveSession(undefined, t)).toBeNull();
    d.close();
  });

  it('pages the audit log with literal prefixes and null actors', () => {
    const d = open();
    const user = d.createUser({ email: 'a@example.com', role: 'owner' })!;
    d.audit(null, 'system.boot');
    d.audit(user.id, 'a_b');
    d.audit(user.id, 'axb');
    d.audit(user.id, 'weird\\%_x');
    d.audit(user.id, 'Weird');

    const names = (action: string) => d.listAuditPage({ action }).entries.map((e) => e.action);
    expect(names('a_')).toEqual(['a_b']);
    expect(names('a')).toEqual(['axb', 'a_b']);
    expect(names('weird\\')).toEqual(['weird\\%_x']);
    expect(names('weird\\%_')).toEqual(['weird\\%_x']);
    expect(names('weird%')).toEqual([]);
    expect(names('weird')).toEqual(['weird\\%_x']);
    expect(names('W')).toEqual(['Weird']);
    expect(names('w')).toEqual(['weird\\%_x']);

    const all = d.listAuditPage({ limit: 100 });
    expect(all.next).toBeNull();
    expect(all.entries[all.entries.length - 1]).toEqual({
      id: 1,
      ts: expect.any(Number),
      actorId: null,
      actorName: null,
      actorEmail: null,
      action: 'system.boot',
      detail: {},
    });
    expect(all.entries[0]).toMatchObject({ actorId: user.id, actorName: 'a', actorEmail: 'a@example.com' });

    const small = d.listAuditPage({ limit: 2 });
    expect(small.entries).toHaveLength(2);
    const after = small.next as number;
    expect(after).toBe(small.entries[1].id);
    expect(d.listAuditPage({ limit: 2, before: after }).entries.map((e) => e.id)).toEqual([after - 1, after - 2]);
    expect(d.listAuditPage({ limit: 0 }).entries).toHaveLength(1);
    expect(d.listAuditPage({ limit: 5000 }).entries).toHaveLength(5);
    d.close();
  });

  it('restores only boards that are deleted', () => {
    const d = open();
    const user = d.createUser({ email: 'a@example.com', role: 'owner' })!;
    d.createBoard({ id: 'b1', title: 'One', ownerId: user.id });
    expect(d.restoreBoard('b1')).toBe(false);
    d.deleteBoard('b1');
    expect(d.getBoardAdmin('b1')!.deletedAt).toEqual(expect.any(Number));
    expect(d.listBoardsAdmin().map((b) => b.id)).toEqual([]);
    expect(d.listBoardsAdmin({ includeDeleted: true }).map((b) => b.id)).toEqual(['b1']);
    expect(d.restoreBoard('b1')).toBe(true);
    expect(d.getBoardAdmin('b1')!.deletedAt).toBeNull();
    expect(d.restoreBoard('missing')).toBe(false);
    expect(d.getBoardAdmin('missing')).toBeNull();
    d.close();
  });
});
