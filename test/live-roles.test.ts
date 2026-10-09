import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// Sockets that are already open when somebody's access changes (docs/accounts.md, "Relay"). The relay runs as a child
// process in accounts mode. A "write" here is a real Yjs update sent over the member's own socket from a fresh document
// (a new client id each time, so a dropped update leaves no gap that would hold back the next one), and a second
// connection that watches the same room tells whether it arrived. Awareness travels behind it on the same socket: once
// it has arrived, the update has too, if it was let through.

const MAIN_PORT = await freePort();
const TIMED_PORT = await freePort();
const OWNER = 'owner@example.com';
const COMMENTS = '~comments';
const ROLE_RECHECK_MS = 5000; // server/relay.mjs

type Body = any;
type Res = { status: number; body: Body; headers: Headers };
type Account = { cookie: string; user: Body; email: string; verifiedBetween: [number, number] };
type Role = 'editor' | 'commenter' | 'viewer';

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
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('relay did not start'));
    }, RELAY_START_MS);
    p.stdout!.on('data', (d) => {
      if (String(d).includes('Tabula relay')) {
        clearTimeout(timer);
        resolve(p);
      }
    });
    p.stderr!.on('data', () => {});
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code}`));
    });
  });

const stopRelay = (p: ChildProcess) =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill('SIGTERM');
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
};

const within = <T>(p: Promise<T>, ms = 4000) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error('timed out')))]) as Promise<T>;

/** A comment thread as the relay accepts it: anything else in the threads map is taken out again. */
const threadValue = (id: string) => {
  const m = new Y.Map<unknown>([['id', id], ['createdAt', 1], ['text', 'hi'], ['anchor', { x: 0, y: 0 }], ['resolved', false]]);
  m.set('replies', new Y.Map());
  return m;
};

const updateFrame = (map: string, key: string) => {
  const doc = new Y.Doc();
  doc.getMap(map).set(key, map === 'threads' ? threadValue(key) : 1);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
};

const awarenessFrame = (name: string) => {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc());
  awareness.setLocalState({ user: { name } });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]));
  awareness.destroy();
  return encoding.toUint8Array(enc);
};

const MAY_WRITE: Record<Role, [boolean, boolean]> = { editor: [true, true], commenter: [false, true], viewer: [false, false] };

type Conn = { doc: Y.Doc; provider: WebsocketProvider; closes: number[] };
type Pair = { board: Conn; comments: Conn };

/** One relay, and everything a test needs to talk to it. */
function harness(port: number, getDir: () => string) {
  const baseUrl = `http://127.0.0.1:${port}`;
  let seq = 0;
  const unique = (tag: string) => `${tag}${++seq}x${Math.random().toString(36).slice(2, 7)}`;
  const emailOf = (tag: string) => `${unique(tag)}@example.com`;
  let ipSeq = 0;
  const nextIp = () => `10.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}.11`;

  async function api(cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(baseUrl + urlPath, {
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
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  type Mail = { to: string; subject: string; text: string };
  const outbox = () => path.join(getDir(), 'outbox.jsonl');
  const mailCount = () => (fs.existsSync(outbox()) ? fs.readFileSync(outbox(), 'utf8').split('\n').filter(Boolean).length : 0);
  const mailsSince = (n: number): Mail[] =>
    fs.readFileSync(outbox(), 'utf8').split('\n').filter(Boolean).slice(n).map((l) => JSON.parse(l));
  const tokenOf = (mail: Mail) => decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);

  async function signIn(email: string, invite?: string): Promise<Account> {
    const before = mailCount();
    const res = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': nextIp() });
    const mails = mailCount() > before ? mailsSince(before) : [];
    if (res.status !== 200 || mails.length !== 1) throw new Error(`no sign-in mail for ${email} (status ${res.status})`);
    const from = Date.now();
    const verify = await api(undefined, 'POST', '/api/auth/verify', { token: tokenOf(mails[0]) });
    const to = Date.now();
    if (verify.status !== 200) throw new Error(`verify failed with ${verify.status}`);
    const cookie = /tabula_session=[^;]+/.exec(verify.headers.getSetCookie()[0])![0];
    return { cookie, user: verify.body.user, email, verifiedBetween: [from, to] };
  }

  async function newTeam(cookie: string) {
    const res = await api(cookie, 'POST', '/api/teams', { name: unique('Team') });
    if (res.status !== 201) throw new Error(`could not create a team (${res.status})`);
    return res.body as Body;
  }

  async function inviteToken(adminCookie: string, teamId: string) {
    const invite = await api(adminCookie, 'POST', `/api/teams/${teamId}/invites`, { role: 'member' });
    if (invite.status !== 201) throw new Error(`could not create an invite (${invite.status})`);
    return invite.body.token as string;
  }

  const joinTeam = async (adminCookie: string, teamId: string) => signIn(emailOf('user'), await inviteToken(adminCookie, teamId));

  async function newBoard(cookie: string, extra: Record<string, unknown> = {}) {
    const id = unique('board');
    const res = await api(cookie, 'POST', '/api/boards', { id, ...extra });
    if (res.status !== 201) throw new Error(`could not create a board (${res.status} ${JSON.stringify(res.body)})`);
    return id;
  }

  const share = (cookie: string, board: string, principalType: 'user' | 'team', principalId: string, role: Role) =>
    api(cookie, 'POST', `/api/boards/${board}/shares`, { principalType, principalId, role });

  const roleOn = async (cookie: string, board: string) =>
    ((await api(cookie, 'GET', '/api/boards')).body as Body[]).find((b) => b.id === board)?.role ?? null;

  // ------------------------------------------------------------ websocket helpers

  const wsHeaders = (cookie?: string): Record<string, string> => ({ Origin: baseUrl, ...(cookie ? { Cookie: cookie } : {}) });

  const sockets = new Set<WebSocket>();
  const providers = new Set<WebsocketProvider>();

  function dispose() {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    for (const p of providers) p.destroy();
    providers.clear();
  }

  function rawSocket(room: string, cookie: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/${room}`, { headers: wsHeaders(cookie) });
    sockets.add(ws);
    ws.on('error', () => {});
    const closed = new Promise<{ code: number; at: number }>((resolve) => ws.on('close', (code) => resolve({ code, at: Date.now() })));
    const joined = new Promise<void>((resolve) => ws.once('message', () => resolve()));
    return { ws, closed, joined };
  }

  const wsFor = (cookie: string) =>
    class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols, { headers: wsHeaders(cookie) });
      }
    };

  function connect(room: string, cookie: string): Conn {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/sync`, room, doc, {
      WebSocketPolyfill: wsFor(cookie) as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    providers.add(provider);
    const closes: number[] = [];
    provider.on('connection-close', (event) => closes.push(event?.code ?? 0));
    return { doc, provider, closes };
  }

  const pair = (board: string, cookie: string): Pair => ({ board: connect(board, cookie), comments: connect(`${board}${COMMENTS}`, cookie) });
  const synced = (c: Conn) => until(() => c.provider.wsconnected && c.provider.synced);
  const pairSynced = (p: Pair) => Promise.all([synced(p.board), synced(p.comments)]);
  const peers = (c: Conn, name: string) => [...c.provider.awareness.getStates().values()].some((s) => s.user?.name === name);

  /** `from` sends a real document update and then awareness over its own socket; resolves to whether `to` received the update. */
  async function writes(from: Conn, to: Conn, map: string, key: string) {
    const name = unique('marker');
    const ws = from.provider.ws!;
    ws.send(updateFrame(map, key));
    ws.send(awarenessFrame(name));
    await until(() => peers(to, name));
    return to.doc.getMap(map).has(key);
  }

  /** Whether `key` made it from one side's board room and comments room to the other's. */
  async function lands(from: Pair, to: Pair, key: string) {
    return [await writes(from.board, to.board, 'objects', key), await writes(from.comments, to.comments, 'threads', key)];
  }

  const stillOpen = (p: Pair) => [p.board, p.comments].map((c) => c.provider.wsconnected && c.closes.length === 0);

  const roomFile = (room: string) => path.join(getDir(), `${room}.yjs`);
  const fileHas = (room: string, map: string, key: string) => {
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, fs.readFileSync(roomFile(room)));
      return doc.getMap(map).has(key);
    } catch {
      return false; // not saved yet, or the relay is replacing the file right now (Windows)
    }
  };
  /** What the relay saved for the board room and the comments room. */
  const stored = (board: string, key: string) => [fileHas(board, 'objects', key), fileHas(`${board}${COMMENTS}`, 'threads', key)];

  return {
    baseUrl, api, signIn, newTeam, inviteToken, joinTeam, newBoard, share, roleOn, unique,
    rawSocket, pair, pairSynced, lands, stillOpen, stored, fileHas, dispose,
  };
}

// ---------------------------------------------------------------- roles that change under open sockets

describe('open sockets follow role changes', { timeout: 30_000 }, () => {
  let dir = '';
  const h = harness(MAIN_PORT, () => dir);
  const { api, signIn, newTeam, joinTeam, newBoard, share, roleOn, rawSocket, pair, pairSynced, lands, stillOpen, stored } = h;
  let relay: ChildProcess;
  let owner: Account;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-live-roles-'));
    relay = await startRelay(MAIN_PORT, dir, {});
    owner = await signIn(OWNER);
  });

  afterEach(() => h.dispose());

  afterAll(async () => {
    h.dispose();
    if (relay && relay.exitCode === null && relay.signalCode === null) await stopRelay(relay);
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A board owned by `creator`, and `person(role)` for somebody who gets that role on it through a share. */
  async function setup() {
    const team = await newTeam(owner.cookie);
    const creator = await joinTeam(owner.cookie, team.id);
    const board = await newBoard(creator.cookie);
    const person = async (role: Role) => {
      const who = await joinTeam(owner.cookie, team.id);
      expect((await share(creator.cookie, board, 'user', who.user.id, role)).status).toBe(201);
      return who;
    };
    return { team, creator, board, person };
  }

  const TRANSITIONS: [Role, Role][] = [
    ['editor', 'viewer'],
    ['commenter', 'viewer'],
    ['editor', 'commenter'],
    ['commenter', 'editor'],
    ['viewer', 'commenter'],
    ['viewer', 'editor'],
  ];

  it.each(TRANSITIONS)('changes %s to %s on the same two sockets, and what was dropped never reaches the stored rooms', async (from, to) => {
    const { creator, board, person } = await setup();
    const guest = await person(from);
    const watcher = pair(board, creator.cookie);
    const mine = pair(board, guest.cookie);
    await Promise.all([pairSynced(watcher), pairSynced(mine)]);
    const sockets = [mine.board.provider.ws, mine.comments.provider.ws];

    expect(await lands(mine, watcher, 'before')).toEqual(MAY_WRITE[from]);
    expect((await share(creator.cookie, board, 'user', guest.user.id, to)).status).toBe(201);
    expect(await lands(mine, watcher, 'after')).toEqual(MAY_WRITE[to]);

    // still connected to the same sockets, and still receiving in both rooms
    expect(await lands(watcher, mine, 'fromWatcher')).toEqual([true, true]);
    expect(mine.board.provider.ws).toBe(sockets[0]);
    expect(mine.comments.provider.ws).toBe(sockets[1]);
    expect(stillOpen(mine)).toEqual([true, true]);

    await until(() => stored(board, 'fromWatcher').every(Boolean));
    expect(stored(board, 'before')).toEqual(MAY_WRITE[from]);
    expect(stored(board, 'after')).toEqual(MAY_WRITE[to]);
  });

  it('turns a team editor into a viewer when they are removed from the team, and back when they rejoin', async () => {
    const team = await newTeam(owner.cookie);
    const creator = await joinTeam(owner.cookie, team.id);
    const member = await joinTeam(owner.cookie, team.id);
    const board = await newBoard(creator.cookie, { teamId: team.id });
    expect((await share(creator.cookie, board, 'user', member.user.id, 'viewer')).status).toBe(201);
    expect(await roleOn(member.cookie, board)).toBe('editor');

    const watcher = pair(board, creator.cookie);
    const mine = pair(board, member.cookie);
    await Promise.all([pairSynced(watcher), pairSynced(mine)]);
    expect(await lands(mine, watcher, 'asTeamEditor')).toEqual([true, true]);

    // the team gave the editor role, the share only gives viewer: leaving the team is a downgrade, not the end of access
    expect((await api(owner.cookie, 'DELETE', `/api/teams/${team.id}/members/${member.user.id}`)).status).toBe(204);
    expect(await roleOn(member.cookie, board)).toBe('viewer');
    expect(await lands(mine, watcher, 'asViewer')).toEqual([false, false]);
    expect(await lands(watcher, mine, 'toViewer')).toEqual([true, true]);
    expect(stillOpen(mine)).toEqual([true, true]);

    // and joining again is an upgrade on the very same sockets
    const joined = await api(member.cookie, 'POST', `/api/invites/${await h.inviteToken(owner.cookie, team.id)}/accept`);
    expect(joined.status).toBe(200);
    expect(await lands(mine, watcher, 'asTeamEditorAgain')).toEqual([true, true]);
    expect(stillOpen(mine)).toEqual([true, true]);

    await until(() => stored(board, 'toViewer').every(Boolean));
    expect(stored(board, 'asTeamEditor')).toEqual([true, true]);
    expect(stored(board, 'asViewer')).toEqual([false, false]);
    expect(stored(board, 'asTeamEditorAgain')).toEqual([true, true]);
  });

  it('follows the role of a team a board is shared with, until the share is removed (4410)', async () => {
    const { creator, board } = await setup();
    const crew = await newTeam(owner.cookie);
    const member = await joinTeam(owner.cookie, crew.id);
    const setRole = async (role: Role) => expect((await share(owner.cookie, board, 'team', crew.id, role)).status).toBe(201);
    await setRole('editor');

    const watcher = pair(board, creator.cookie);
    const mine = pair(board, member.cookie);
    await Promise.all([pairSynced(watcher), pairSynced(mine)]);
    expect(await lands(mine, watcher, 'asEditor')).toEqual([true, true]);
    await setRole('commenter');
    expect(await lands(mine, watcher, 'asCommenter')).toEqual([false, true]);
    await setRole('viewer');
    expect(await lands(mine, watcher, 'asViewer')).toEqual([false, false]);
    await setRole('editor');
    expect(await lands(mine, watcher, 'asEditorAgain')).toEqual([true, true]);
    expect(stillOpen(mine)).toEqual([true, true]);

    expect((await api(owner.cookie, 'DELETE', `/api/boards/${board}/shares/team/${crew.id}`)).status).toBe(204);
    await until(() => mine.board.closes.length > 0 && mine.comments.closes.length > 0);
    expect([mine.board.closes[0], mine.comments.closes[0]]).toEqual([4410, 4410]);
    expect(stillOpen(watcher)).toEqual([true, true]);
  });

  it('downgrades team members when the board leaves the team, and upgrades them when it comes back', async () => {
    const team = await newTeam(owner.cookie);
    const creator = await joinTeam(owner.cookie, team.id);
    const member = await joinTeam(owner.cookie, team.id);
    const board = await newBoard(creator.cookie, { teamId: team.id });
    expect((await share(creator.cookie, board, 'user', member.user.id, 'commenter')).status).toBe(201);

    const watcher = pair(board, creator.cookie);
    const mine = pair(board, member.cookie);
    await Promise.all([pairSynced(watcher), pairSynced(mine)]);
    expect(await lands(mine, watcher, 'inTeam')).toEqual([true, true]);

    expect((await api(creator.cookie, 'PATCH', `/api/boards/${board}`, { teamId: null })).status).toBe(200);
    expect(await lands(mine, watcher, 'outOfTeam')).toEqual([false, true]);
    expect((await api(creator.cookie, 'PATCH', `/api/boards/${board}`, { teamId: team.id })).status).toBe(200);
    expect(await lands(mine, watcher, 'backInTeam')).toEqual([true, true]);
    expect(stillOpen(mine)).toEqual([true, true]);
  });

  it('follows a change of workspace role: guests lose what their team gave them, admins gain every board', async () => {
    const team = await newTeam(owner.cookie);
    const creator = await joinTeam(owner.cookie, team.id);
    const member = await joinTeam(owner.cookie, team.id);
    const board = await newBoard(creator.cookie, { teamId: team.id });
    expect((await share(creator.cookie, board, 'user', member.user.id, 'viewer')).status).toBe(201);
    const setWorkspaceRole = async (role: string) =>
      expect((await api(owner.cookie, 'PATCH', `/api/members/${member.user.id}`, { role })).status).toBe(200);

    const watcher = pair(board, creator.cookie);
    const mine = pair(board, member.cookie);
    await Promise.all([pairSynced(watcher), pairSynced(mine)]);
    expect(await lands(mine, watcher, 'asMember')).toEqual([true, true]);

    await setWorkspaceRole('guest'); // guests only have what is shared with them
    expect(await lands(mine, watcher, 'asGuest')).toEqual([false, false]);
    await setWorkspaceRole('admin'); // admins own every board
    expect(await lands(mine, watcher, 'asAdmin')).toEqual([true, true]);
    await setWorkspaceRole('member');
    expect(await lands(mine, watcher, 'asMemberAgain')).toEqual([true, true]);
    expect(stillOpen(mine)).toEqual([true, true]);

    // an admin who is demoted to a member falls back to their share on a board their team does not own
    const other = await newBoard(creator.cookie);
    expect((await share(creator.cookie, other, 'user', member.user.id, 'viewer')).status).toBe(201);
    await setWorkspaceRole('admin');
    const second = pair(other, member.cookie);
    const secondWatcher = pair(other, creator.cookie);
    await Promise.all([pairSynced(second), pairSynced(secondWatcher)]);
    expect(await lands(second, secondWatcher, 'asAdmin')).toEqual([true, true]);
    await setWorkspaceRole('member');
    expect(await lands(second, secondWatcher, 'asMember')).toEqual([false, false]);
    expect(stillOpen(second)).toEqual([true, true]);
  });

  it('picks up an access change that raises no event within the 5 second recheck', async () => {
    const team = await newTeam(owner.cookie);
    const creator = await joinTeam(owner.cookie, team.id);
    const board = await newBoard(creator.cookie, { teamId: team.id });
    const elsewhere = await newTeam(owner.cookie);
    const guest = await joinTeam(owner.cookie, elsewhere.id);
    expect((await share(owner.cookie, board, 'user', guest.user.id, 'viewer')).status).toBe(201);

    const watcher = pair(board, creator.cookie);
    const mine = pair(board, guest.cookie);
    await Promise.all([pairSynced(watcher), pairSynced(mine)]);
    expect(await lands(mine, watcher, 'asViewer')).toEqual([false, false]);

    // signing in again with an invite adds an existing person to the team; no event is emitted for it
    await signIn(guest.email, await h.inviteToken(owner.cookie, team.id));
    expect(await roleOn(guest.cookie, board)).toBe('editor');

    let landed = [false, false];
    const t0 = Date.now();
    for (let n = 0; Date.now() - t0 < ROLE_RECHECK_MS + 4000 && !landed.every(Boolean); n++) {
      landed = await lands(mine, watcher, `poll${n}`);
      if (!landed.every(Boolean)) await sleep(250);
    }
    expect(landed).toEqual([true, true]);
    expect(stillOpen(mine)).toEqual([true, true]);
  });

  it('keeps a disabled or removed member out: the sockets close with 4410 and the old cookie only gets 4401', async () => {
    const { board, person } = await setup();
    const a = await person('editor');
    const b = await person('commenter');
    const open = (who: Account) => [rawSocket(board, who.cookie), rawSocket(`${board}${COMMENTS}`, who.cookie)];
    const sa = open(a);
    const sb = open(b);
    await within(Promise.all([...sa, ...sb].map((s) => s.joined)));

    expect((await api(owner.cookie, 'PATCH', `/api/members/${a.user.id}`, { disabled: true })).status).toBe(200);
    expect((await within(Promise.all(sa.map((s) => s.closed)))).map((c) => c.code)).toEqual([4410, 4410]);
    expect(sb.every((s) => s.ws.readyState === WebSocket.OPEN)).toBe(true);
    expect((await within(rawSocket(board, a.cookie).closed)).code).toBe(4401);

    // enabling someone again does not bring their old sessions back
    expect((await api(owner.cookie, 'PATCH', `/api/members/${a.user.id}`, { disabled: false })).status).toBe(200);
    expect((await within(rawSocket(board, a.cookie).closed)).code).toBe(4401);
    const again = rawSocket(board, (await signIn(a.email)).cookie);
    await within(again.joined);
    expect(again.ws.readyState).toBe(WebSocket.OPEN);

    expect((await api(owner.cookie, 'DELETE', `/api/members/${b.user.id}`)).status).toBe(204);
    expect((await within(Promise.all(sb.map((s) => s.closed)))).map((c) => c.code)).toEqual([4410, 4410]);
    expect((await within(rawSocket(board, b.cookie).closed)).code).toBe(4401);
  });
});

// ---------------------------------------------------------------- sessions that run out

describe('open sockets follow their session', { timeout: 40_000 }, () => {
  // 0.00004 days is 3.456 seconds
  const SESSION_MS = 0.00004 * 24 * 60 * 60 * 1000;
  let dir = '';
  const h = harness(TIMED_PORT, () => dir);
  const { api, signIn, newBoard, rawSocket } = h;
  let relay: ChildProcess;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-live-session-'));
    relay = await startRelay(TIMED_PORT, dir, { TABULA_SESSION_DAYS: '0.00004' });
  });

  afterEach(() => h.dispose());

  afterAll(async () => {
    h.dispose();
    if (relay && relay.exitCode === null && relay.signalCode === null) await stopRelay(relay);
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('closes a socket with 4401 once its session has run out, and keeps one whose session slides past the first expiry', async () => {
    // the relay looks at each socket at most every 5 seconds, so a dead session is noticed up to 5 seconds (plus a 1 second tick) late
    const LATE_MS = ROLE_RECHECK_MS + 1000 + 1500;
    const first = await signIn(OWNER);
    const board = await newBoard(first.cookie);
    const plain = await signIn(OWNER);
    const sliding = await signIn(OWNER);
    const rooms = [board, `${board}${COMMENTS}`];
    const plainSockets = rooms.map((room) => rawSocket(room, plain.cookie));
    const slidingSockets = rooms.map((room) => rawSocket(room, sliding.cookie));
    await within(Promise.all([...plainSockets, ...slidingSockets].map((s) => s.joined)));

    // nobody touches `plain`: its sockets close with 4401, not before the session ends and not much later than the next recheck
    const plainClosing = within(Promise.all(plainSockets.map((s) => s.closed)), SESSION_MS + LATE_MS + 2000);
    let plainDoneAt = 0;
    const noteDone = () => {
      plainDoneAt = Date.now();
    };
    plainClosing.then(noteDone, noteDone);

    // meanwhile `sliding` is used through the API, which extends its session past the original end. The relay looks at
    // each socket on its own schedule, so keep going for a while after `plain` was closed: by then it has looked at
    // `sliding` after the original end, and the socket must have survived that
    const originalEnd = sliding.verifiedBetween[1] + SESSION_MS;
    let slidAt: [number, number] = [0, 0];
    let slides = 0;
    while (plainDoneAt === 0 || Date.now() < plainDoneAt + 1500) {
      const from = Date.now();
      const res = await api(sliding.cookie, 'GET', '/api/me');
      expect(res.status).toBe(200);
      if (res.headers.get('set-cookie')) {
        slides++;
        slidAt = [from, Date.now()];
      }
      await sleep(300);
    }
    expect(slides).toBeGreaterThan(0);
    expect(Date.now()).toBeGreaterThan(originalEnd);
    expect(slidingSockets.map((s) => s.ws.readyState)).toEqual([WebSocket.OPEN, WebSocket.OPEN]);

    const plainClosed = await plainClosing;
    expect(plainClosed.map((c) => c.code)).toEqual([4401, 4401]);
    for (const { at } of plainClosed) {
      expect(at).toBeGreaterThanOrEqual(plain.verifiedBetween[0] + SESSION_MS - 100);
      expect(at).toBeLessThanOrEqual(plain.verifiedBetween[1] + SESSION_MS + LATE_MS);
    }
    expect((await api(plain.cookie, 'GET', '/api/me')).status).toBe(401);
    expect((await within(rawSocket(board, plain.cookie).closed)).code).toBe(4401);

    // once the activity stops, the extended session runs out like any other
    const slidingClosed = await within(Promise.all(slidingSockets.map((s) => s.closed)), SESSION_MS + LATE_MS + 2000);
    expect(slidingClosed.map((c) => c.code)).toEqual([4401, 4401]);
    for (const { at } of slidingClosed) {
      expect(at).toBeGreaterThanOrEqual(slidAt[0] + SESSION_MS - 100);
      expect(at).toBeLessThanOrEqual(slidAt[1] + SESSION_MS + LATE_MS);
    }
    expect((await api(sliding.cookie, 'GET', '/api/me')).status).toBe(401);
  });
});
