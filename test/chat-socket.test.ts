import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { CHAT_CLOSE, createChatHub } from '../server/chat-hub.mjs';
import { createHarness, until, type Account } from './mcp-harness';

// docs/chat.md, "Live delivery": the /chat socket over a real relay (accounts mode, TABULA_CHAT=on, a hosted workspace
// so the read-only switch can be flipped), then the hub on its own with fake sockets for what a relay cannot show
// reliably (a slow consumer, the caps).

const CLOUD_TOKEN = 'chat-socket-cloud-token-0123456789abcdef';
const h = createHarness({
  accounts: true,
  settings: { CHAT: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'chat-ws' },
});
let owner: Account;

type Frame = Record<string, any>;
type Client = { ws: WebSocket; frames: Frame[]; closed: { code: number; reason: string } | null; status: number | null };
const clients = new Set<Client>();

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
});
afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  await until(() => [...clients].every((c) => c.ws.readyState === WebSocket.CLOSED));
  clients.clear();
});
afterAll(() => h.cleanup());

function connect(cookie?: string, origin = h.base): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/chat`, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
  const c: Client = { ws, frames: [], closed: null, status: null };
  ws.on('message', (data) => c.frames.push(JSON.parse(String(data))));
  ws.on('close', (code, reason) => (c.closed = { code, reason: String(reason) }));
  ws.on('unexpected-response', (_req, res) => {
    c.status = res.statusCode ?? null;
    res.resume();
    ws.terminate();
  });
  ws.on('error', () => {});
  clients.add(c);
  return c;
}

const has = (c: Client, pred: (f: Frame) => boolean) => c.frames.some(pred);
const ready = async (cookie: string) => {
  const c = connect(cookie);
  await until(() => has(c, (f) => f.t === 'hello'));
  return c;
};
const subscribe = async (c: Client, ref: string, kind = 'board') => {
  const before = c.frames.length;
  c.ws.send(JSON.stringify({ t: 'sub', kind, ref }));
  await until(() => c.frames.slice(before).some((f) => (f.t === 'subscribed' || f.t === 'denied') && f.ref === ref));
  return c.frames.slice(before).find((f) => f.ref === ref)!;
};
/** Everything the server queued to this socket before now has arrived (frames are in order on one socket). */
const flushed = async (c: Client) => {
  const before = c.frames.filter((f) => f.t === 'pong').length;
  c.ws.send(JSON.stringify({ t: 'ping' }));
  await until(() => c.frames.filter((f) => f.t === 'pong').length > before);
};
const send = (who: Account, board: string, text: string) =>
  h.api(who.cookie, 'POST', `/api/chat/board/${board}/messages`, { clientId: crypto.randomUUID(), text });

async function setup({ teamBoard = false } = {}) {
  const team = await h.newTeam(owner.cookie);
  const creator = await h.joinTeam(owner.cookie, team.id);
  const board = await h.newBoard(creator.cookie, teamBoard ? { teamId: team.id } : {});
  const person = async (role: 'editor' | 'commenter' | 'viewer') => {
    const who = await h.joinTeam(owner.cookie, team.id);
    await h.share(creator.cookie, board, who.user.id, role);
    return who;
  };
  const outsider = async () => h.joinTeam(owner.cookie, (await h.newTeam(owner.cookie)).id);
  return { team, creator, board, person, outsider };
}

describe('the /chat socket', { timeout: 60_000 }, () => {
  it('needs a session and the app origin', async () => {
    const anonymous = connect();
    await until(() => anonymous.closed !== null);
    expect(anonymous.closed!.code).toBe(CHAT_CLOSE.unauthenticated);
    expect(anonymous.frames).toEqual([]);

    const foreign = connect(owner.cookie, 'https://evil.example.com');
    await until(() => foreign.status !== null || foreign.closed !== null);
    expect(foreign.status).toBe(403);
  });

  it('says hello with the unread summary', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('commenter');
    (await ready(ben.cookie)).ws.close(); // Ben is seen before anything is said
    await send(ana, board, 'one');
    const c = await ready(ben.cookie);
    expect(c.frames[0]).toMatchObject({ t: 'hello', readOnly: false });
    expect(c.frames[0].channels).toContainEqual({ kind: 'board', ref: board, lastId: 0, unread: 1, mentions: 0 });
  });

  it('subscribes to a channel the person can read and denies the others alike', async () => {
    const { board, person, outsider } = await setup();
    const ana = await person('viewer');
    const stranger = await outsider();
    const c = await ready(ana.cookie);
    expect(await subscribe(c, board)).toEqual({ t: 'subscribed', kind: 'board', ref: board });
    const s = await ready(stranger.cookie);
    expect(await subscribe(s, board)).toEqual({ t: 'denied', kind: 'board', ref: board });
    expect(await subscribe(s, 'no-such-board')).toEqual({ t: 'denied', kind: 'board', ref: 'no-such-board' });
    expect(await subscribe(s, 'team1', 'team')).toEqual({ t: 'denied', kind: 'team', ref: 'team1' });
    expect(s.closed).toBeNull();
  });

  it('sends the message to subscribers, counts to other readers, and nothing to anyone else', async () => {
    const { board, person, outsider } = await setup();
    const ana = await person('commenter');
    const ben = await person('commenter');
    const stranger = await outsider();
    const watching = await ready(ben.cookie);
    await subscribe(watching, board);
    const elsewhere = await ready(ben.cookie); // Ben's other tab, on the Boards page
    const strangers = await ready(stranger.cookie);
    await subscribe(strangers, board);
    const anasOther = await ready(ana.cookie); // the author's own tab, not subscribed

    const posted = (await send(ana, board, 'the secret plan')).body.message;
    await until(() => has(watching, (f) => f.t === 'message'));
    expect(watching.frames.find((f) => f.t === 'message')).toEqual({ t: 'message', kind: 'board', ref: board, message: posted });

    await until(() => has(elsewhere, (f) => f.t === 'unread'));
    expect(elsewhere.frames.find((f) => f.t === 'unread')).toEqual({ t: 'unread', kind: 'board', ref: board, unread: 1, mentions: 0 });
    await Promise.all([flushed(elsewhere), flushed(strangers), flushed(anasOther)]);
    for (const c of [elsewhere, strangers, anasOther]) expect(JSON.stringify(c.frames)).not.toContain('secret');
    expect(has(anasOther, (f) => f.t === 'unread')).toBe(false);
  });

  it('sends edits and deletes to subscribers', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const c = await ready(ana.cookie);
    await subscribe(c, board);
    const posted = (await send(ana, board, 'draft')).body.message;
    await h.api(ana.cookie, 'PATCH', `/api/chat/messages/${posted.id}`, { text: 'final' });
    await until(() => has(c, (f) => f.t === 'edit'));
    expect(c.frames.find((f) => f.t === 'edit')).toMatchObject({ kind: 'board', ref: board, message: { id: posted.id, text: 'final' } });
    await h.api(ana.cookie, 'DELETE', `/api/chat/messages/${posted.id}`);
    await until(() => has(c, (f) => f.t === 'delete'));
    expect(c.frames.find((f) => f.t === 'delete')).toEqual({ t: 'delete', kind: 'board', ref: board, id: posted.id, by: 'author' });
  });

  it('closes a channel when a share is removed, and sends nothing more from it', async () => {
    const { creator, board, person } = await setup();
    const ana = await person('commenter');
    const c = await ready(ana.cookie);
    await subscribe(c, board);
    expect((await h.api(creator.cookie, 'DELETE', `/api/boards/${board}/shares/user/${ana.user.id}`)).status).toBe(204);
    await until(() => has(c, (f) => f.t === 'closed'));
    expect(c.frames.find((f) => f.t === 'closed')).toEqual({ t: 'closed', kind: 'board', ref: board });
    await send(creator, board, 'after she left');
    await flushed(c);
    expect(JSON.stringify(c.frames)).not.toContain('after she left');
    expect(c.closed).toBeNull();
  });

  it('closes a channel when a team change takes the board away', async () => {
    const { team, board } = await setup({ teamBoard: true });
    const member = await h.joinTeam(owner.cookie, team.id);
    const c = await ready(member.cookie);
    expect(await subscribe(c, board)).toMatchObject({ t: 'subscribed' });
    expect((await h.api(owner.cookie, 'DELETE', `/api/teams/${team.id}/members/${member.user.id}`)).status).toBe(204);
    await until(() => has(c, (f) => f.t === 'closed'));
    expect(c.frames.find((f) => f.t === 'closed')).toEqual({ t: 'closed', kind: 'board', ref: board });
  });

  it('mirrors a read marker to every tab of the person', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('commenter');
    const one = await ready(ben.cookie);
    const two = await ready(ben.cookie);
    const anas = await ready(ana.cookie);
    const posted = (await send(ana, board, 'read me')).body.message;
    await h.api(ben.cookie, 'PUT', `/api/chat/board/${board}/read`, { lastId: posted.id });
    for (const c of [one, two]) {
      await until(() => has(c, (f) => f.t === 'read'));
      expect(c.frames.find((f) => f.t === 'read')).toEqual({ t: 'read', kind: 'board', ref: board, lastId: posted.id });
    }
    await flushed(anas);
    expect(has(anas, (f) => f.t === 'read')).toBe(false);
  });

  it('closes with 4401 when the session ends, and leaves the person’s other sessions open', async () => {
    const { person } = await setup();
    const ana = await person('commenter');
    const again = await h.signIn(ana.email);
    const first = await ready(ana.cookie);
    const second = await ready(again.cookie);
    expect((await h.api(ana.cookie, 'POST', '/api/auth/logout')).status).toBe(204);
    await until(() => first.closed !== null);
    expect(first.closed!.code).toBe(CHAT_CLOSE.unauthenticated);
    await flushed(second);
    expect(second.closed).toBeNull();
    // a disabled person is signed out everywhere
    expect((await h.api(owner.cookie, 'PATCH', `/api/members/${ana.user.id}`, { disabled: true })).status).toBe(200);
    await until(() => second.closed !== null);
    expect(second.closed!.code).toBe(CHAT_CLOSE.unauthenticated);
  });

  it('allows ten sockets per person', async () => {
    const { person } = await setup();
    const ana = await person('commenter');
    const ten = await Promise.all(Array.from({ length: 10 }, () => ready(ana.cookie)));
    const eleventh = connect(ana.cookie);
    await until(() => eleventh.closed !== null);
    expect(eleventh.closed!.code).toBe(CHAT_CLOSE.tooManySockets);
    for (const c of ten) expect(c.closed).toBeNull();
  });

  it('tells sockets when the workspace turns read-only and back', async () => {
    const c = await ready(owner.cookie);
    const internal = (body: unknown) => h.api(undefined, 'PUT', '/api/internal/limits', body, { authorization: `Bearer ${CLOUD_TOKEN}` });
    try {
      await internal({ readOnly: true });
      await until(() => has(c, (f) => f.t === 'readonly' && f.on === true));
    } finally {
      await internal({ readOnly: false });
    }
    await until(() => has(c, (f) => f.t === 'readonly' && f.on === false));
    expect(c.frames.filter((f) => f.t === 'readonly')).toEqual([{ t: 'readonly', on: true }, { t: 'readonly', on: false }]);
  });

  it('ignores frames it does not understand', async () => {
    const c = await ready(owner.cookie);
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ t: 'message', kind: 'board', ref: 'x', text: 'writes are REST only' }));
    c.ws.send(JSON.stringify(null));
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await flushed(c);
    expect(c.closed).toBeNull();
    expect(c.frames.map((f) => f.t)).toEqual(['hello', 'pong']);
  });
});

// ---------------------------------------------------------------- the hub on its own

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Frame[] = [];
  closedWith: number | null = null;
  terminated = false;
  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(JSON.parse(data));
    cb?.();
  }
  close(code: number) {
    this.closedWith = code;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
  ping() {}
  frame(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}

describe('the chat hub', () => {
  const users: Record<string, { id: string; role: string; disabled?: boolean }> = {
    ana: { id: 'ana', role: 'member' },
    ben: { id: 'ben', role: 'member' },
    cy: { id: 'cy', role: 'member' },
  };
  const readers = new Set(['ana', 'ben']);
  const hubWith = (limits = {}) =>
    createChatHub({
      auth: { authenticate: (cookie: unknown) => (typeof cookie === 'string' && users[cookie] ? { user: users[cookie], sessionId: `s-${cookie}`, expiresAt: Date.now() + 60_000 } : null) },
      directory: { getUser: (id: string) => users[id] ?? null },
      access: (user: { id: string } | null, kind: unknown, ref: unknown) => (user && kind === 'board' && ref === 'b1' && readers.has(user.id) ? { read: true } : null),
      summary: () => [],
      channelUnread: () => ({ unread: 3, mentions: 1 }),
      limits,
      timers: false,
    });
  const join = (hub: ReturnType<typeof createChatHub>, who: string) => {
    const ws = new FakeSocket();
    hub.connect(ws, { headers: { cookie: who } } as never);
    return ws;
  };

  it('drops a socket that is not keeping up instead of buffering for it', () => {
    const hub = hubWith({ queueBytes: 1024 });
    const slow = join(hub, 'ana');
    const fine = join(hub, 'ben');
    slow.frame({ t: 'sub', kind: 'board', ref: 'b1' });
    fine.frame({ t: 'sub', kind: 'board', ref: 'b1' });
    slow.bufferedAmount = 1000;
    hub.publish('board', 'b1', { t: 'message', kind: 'board', ref: 'b1', message: { text: 'x'.repeat(100) } });
    expect(slow.terminated).toBe(true);
    expect(slow.sent.some((f) => f.t === 'message')).toBe(false);
    expect(fine.sent.some((f) => f.t === 'message')).toBe(true);
    expect(hub.stats()).toMatchObject({ users: 1, sockets: 1 });
  });

  it('gives counts, never text, to readers who are not subscribed, and nothing to the author or to others', () => {
    const hub = hubWith();
    const author = join(hub, 'ana');
    const reader = join(hub, 'ben');
    const other = join(hub, 'cy');
    hub.publish('board', 'b1', { t: 'message', kind: 'board', ref: 'b1', message: { text: 'hidden' } }, { authorId: 'ana' });
    expect(reader.sent.at(-1)).toEqual({ t: 'unread', kind: 'board', ref: 'b1', unread: 3, mentions: 1 });
    expect(author.sent.map((f) => f.t)).toEqual(['hello']);
    expect(other.sent.map((f) => f.t)).toEqual(['hello']);
  });

  it('caps the subscriptions of a socket', () => {
    readers.add('cy');
    const hub = createChatHub({
      auth: { authenticate: () => ({ user: users.cy, sessionId: 's', expiresAt: Date.now() + 60_000 }) },
      directory: { getUser: (id: string) => users[id] ?? null },
      access: () => ({ read: true }),
      summary: () => [],
      channelUnread: () => ({ unread: 0, mentions: 0 }),
      limits: { subscriptionsPerSocket: 2 },
      timers: false,
    });
    const ws = join(hub, 'cy');
    for (const ref of ['a', 'b', 'c']) ws.frame({ t: 'sub', kind: 'board', ref });
    expect(ws.sent.slice(1)).toEqual([
      { t: 'subscribed', kind: 'board', ref: 'a' },
      { t: 'subscribed', kind: 'board', ref: 'b' },
      { t: 'denied', kind: 'board', ref: 'c', reason: 'too_many' },
    ]);
    readers.delete('cy');
  });

  it('closes a socket once its session has expired and cannot be renewed', () => {
    let t = 1_000_000;
    let valid = true;
    const hub = createChatHub({
      auth: { authenticate: () => (valid ? { user: users.ana, sessionId: 's', expiresAt: t + 10 } : null) },
      directory: { getUser: (id: string) => users[id] ?? null },
      access: () => null,
      summary: () => [],
      channelUnread: () => ({ unread: 0, mentions: 0 }),
      now: () => t,
      timers: false,
    });
    const ws = join(hub, 'ana');
    t += 20; // past the expiry, but the session slid on (it is still valid)
    hub.tick();
    expect(ws.closedWith).toBeNull();
    valid = false;
    t += 20;
    hub.tick();
    expect(ws.closedWith).toBe(CHAT_CLOSE.unauthenticated);
  });

  it('closes a socket that floods it with frames', () => {
    const hub = hubWith({ frames: 3 });
    const ws = join(hub, 'ana');
    for (let i = 0; i < 4; i++) ws.frame({ t: 'ping' });
    expect(ws.closedWith).toBe(CHAT_CLOSE.policy);
    expect(hub.stats().sockets).toBe(0);
  });

  it('re-checks subscriptions when access changes, and closes the sockets of a removed person', () => {
    const events = new EventEmitter();
    const allowed = new Set(['ana', 'ben']);
    const hub = createChatHub({
      auth: { authenticate: (cookie: unknown) => (typeof cookie === 'string' && users[cookie] ? { user: users[cookie], sessionId: 's', expiresAt: Date.now() + 60_000 } : null) },
      directory: { getUser: (id: string) => users[id] ?? null },
      access: (user: { id: string } | null) => (user && allowed.has(user.id) ? { read: true } : null),
      summary: () => [],
      channelUnread: () => ({ unread: 0, mentions: 0 }),
      events,
      timers: false,
    });
    const ana = join(hub, 'ana');
    const ben = join(hub, 'ben');
    ana.frame({ t: 'sub', kind: 'board', ref: 'b1' });
    ben.frame({ t: 'sub', kind: 'board', ref: 'b1' });
    allowed.delete('ana');
    events.emit('access-changed', { boardId: 'b1' });
    expect(ana.sent.at(-1)).toEqual({ t: 'closed', kind: 'board', ref: 'b1' });
    expect(ben.sent.at(-1)).toEqual({ t: 'subscribed', kind: 'board', ref: 'b1' });
    events.emit('user-removed', { userId: 'ben' });
    expect(ben.closedWith).toBe(CHAT_CLOSE.unauthenticated);
    hub.stop();
    expect(events.listenerCount('access-changed')).toBe(0);
  });
});
