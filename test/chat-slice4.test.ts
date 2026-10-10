import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createHarness, until, type Account } from './mcp-harness';

// docs/chat.md, slice 4 over a real relay (accounts mode, TABULA_CHAT=on, mail in `file` mode so nothing leaves the machine):
// reactions, mention notices, the mention email and the preference. The email waits ten minutes in production; here 400 ms.

const CLOUD_TOKEN = 'chat-s4-cloud-token-0123456789abcdef';
const h = createHarness({
  accounts: true,
  settings: { CHAT: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'chat-ws' },
  env: { TABULA_CHAT_MENTION_MAIL_AFTER_MS: '400' },
});
let owner: Account;

type Frame = Record<string, any>;
type Client = { ws: WebSocket; frames: Frame[] };
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

function connect(cookie: string): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/chat`, { headers: { Origin: h.base, Cookie: cookie } });
  const c: Client = { ws, frames: [] };
  ws.on('message', (d) => c.frames.push(JSON.parse(String(d))));
  ws.on('error', () => {});
  clients.add(c);
  return c;
}
const ready = async (cookie: string) => {
  const c = connect(cookie);
  await until(() => c.frames.some((f) => f.t === 'hello'));
  return c;
};
const subscribe = async (c: Client, kind: string, ref: string) => {
  const before = c.frames.length;
  c.ws.send(JSON.stringify({ t: 'sub', kind, ref }));
  await until(() => c.frames.slice(before).some((f) => f.t === 'subscribed' && f.ref === ref));
};
const flushed = async (c: Client) => {
  const before = c.frames.filter((f) => f.t === 'pong').length;
  c.ws.send(JSON.stringify({ t: 'ping' }));
  await until(() => c.frames.filter((f) => f.t === 'pong').length > before);
};

const say = (who: Account, path: string, text: string) => h.api(who.cookie, 'POST', `/api/chat/${path}/messages`, { clientId: crypto.randomUUID(), text });
const reactPath = (id: number, emoji: string) => `/api/chat/messages/${id}/reactions/${encodeURIComponent(emoji)}`;

async function team() {
  const t = await h.newTeam(owner.cookie);
  const ana = await h.joinTeam(owner.cookie, t.id);
  const ben = await h.joinTeam(owner.cookie, t.id);
  return { t, ana, ben, path: `team/${t.id}` };
}
const mailsTo = (email: string) => h.mails().filter((m) => m.to === email);

describe('reactions', { timeout: 60_000 }, () => {
  it('toggles one of each emoji per person and returns the message’s reactions in the fixed order', async () => {
    const { ana, ben, path } = await team();
    const m = (await say(ana, path, 'ship it')).body.message;
    expect(m.reactions).toEqual([]);
    const a = await h.api(ben.cookie, 'PUT', reactPath(m.id, '🎉'));
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ id: m.id, reactions: [{ emoji: '🎉', userIds: [ben.user.id] }] });
    const b = await h.api(ana.cookie, 'PUT', reactPath(m.id, '👍'));
    expect(b.body.reactions.map((r: any) => r.emoji)).toEqual(['👍', '🎉']);
    // again: nothing changes
    expect((await h.api(ben.cookie, 'PUT', reactPath(m.id, '🎉'))).body.reactions).toEqual(b.body.reactions);
    const listed = (await h.api(ana.cookie, 'GET', `/api/chat/${path}/messages`)).body.messages[0];
    expect(listed.reactions).toEqual(b.body.reactions);
    const off = await h.api(ben.cookie, 'DELETE', reactPath(m.id, '🎉'));
    expect(off.body.reactions).toEqual([{ emoji: '👍', userIds: [ana.user.id] }]);
    expect((await h.api(ben.cookie, 'DELETE', reactPath(m.id, '🎉'))).status).toBe(200);
  });

  it('accepts only the fixed set', async () => {
    const { ana, path } = await team();
    const m = (await say(ana, path, 'x')).body.message;
    for (const emoji of ['🤔', 'x', '👍👍', '']) {
      const res = await h.api(ana.cookie, 'PUT', reactPath(m.id, emoji));
      expect(`${emoji} ${[400, 404].includes(res.status)}`).toBe(`${emoji} true`);
    }
  });

  it('is for people who may write there, and a 404 for people who cannot read it', async () => {
    const { ana, path } = await team();
    const outsider = await h.joinTeam(owner.cookie, (await h.newTeam(owner.cookie)).id);
    const m = (await say(ana, path, 'x')).body.message;
    expect((await h.api(outsider.cookie, 'PUT', reactPath(m.id, '👍'))).status).toBe(404);
    // a workspace owner reads a team they do not belong to, and cannot post or react there
    const theirs = await h.newTeam(ana.cookie);
    const note = (await say(ana, `team/${theirs.id}`, 'x')).body.message;
    expect((await h.api(owner.cookie, 'GET', `/api/chat/team/${theirs.id}/messages`)).status).toBe(200);
    expect((await h.api(owner.cookie, 'PUT', reactPath(note.id, '👍'))).status).toBe(403);
    expect((await h.api(undefined, 'PUT', reactPath(m.id, '👍'))).status).toBe(401);
  });

  it('refuses a deleted message and drops its reactions with it', async () => {
    const { ana, ben, path } = await team();
    const m = (await say(ana, path, 'x')).body.message;
    await h.api(ben.cookie, 'PUT', reactPath(m.id, '👀'));
    expect((await h.api(ana.cookie, 'DELETE', `/api/chat/messages/${m.id}`)).status).toBe(204);
    expect((await h.api(ben.cookie, 'PUT', reactPath(m.id, '👀'))).status).toBe(409);
    expect((await h.api(ana.cookie, 'GET', `/api/chat/${path}/messages`)).body.messages[0].reactions).toEqual([]);
  });

  it('tells subscribers, and nobody else, with the full list after the change', async () => {
    const { ana, ben, path, t } = await team();
    const outsider = await h.joinTeam(owner.cookie, (await h.newTeam(owner.cookie)).id);
    const m = (await say(ana, path, 'x')).body.message;
    const [a, o] = await Promise.all([ready(ana.cookie), ready(outsider.cookie)]);
    await subscribe(a, 'team', t.id);
    await h.api(ben.cookie, 'PUT', reactPath(m.id, '✅'));
    await until(() => a.frames.some((f) => f.t === 'reaction'));
    expect(a.frames.find((f) => f.t === 'reaction')).toMatchObject({ kind: 'team', ref: t.id, id: m.id, emoji: '✅', userId: ben.user.id, on: true, reactions: [{ emoji: '✅', userIds: [ben.user.id] }] });
    await h.api(ben.cookie, 'PUT', reactPath(m.id, '✅')); // no change, no frame
    await flushed(a);
    expect(a.frames.filter((f) => f.t === 'reaction')).toHaveLength(1);
    await flushed(o);
    expect(o.frames.some((f) => f.t === 'reaction')).toBe(false);
  });

  it('is limited to 60 a minute per person', async () => {
    const { ana, path } = await team();
    const m = (await say(ana, path, 'x')).body.message;
    let last = 200;
    for (let i = 0; i < 62; i++) last = (await h.api(ana.cookie, i % 2 ? 'DELETE' : 'PUT', reactPath(m.id, '👍'))).status;
    expect(last).toBe(429);
  });
});

describe('mention notices', { timeout: 60_000 }, () => {
  it('sends a notice to a person with the app open and not looking at the channel, with the first words only', async () => {
    const { ana, ben, path } = await team();
    const b = await ready(ben.cookie);
    await say(ana, path, `@{${ben.user.id}} ${'x'.repeat(300)}`);
    await until(() => b.frames.some((f) => f.t === 'mention'));
    const n = b.frames.find((f) => f.t === 'mention')!;
    expect(n).toMatchObject({ kind: 'team', from: { id: ana.user.id, name: ana.user.name } });
    expect(n.text.length).toBeLessThanOrEqual(140);
    expect(n.text.startsWith(`@${ben.user.name}`)).toBe(true);
  });

  it('sends nothing to a person who has the channel open, or to the author', async () => {
    const { ana, ben, path, t } = await team();
    const [a, b] = await Promise.all([ready(ana.cookie), ready(ben.cookie)]);
    await subscribe(b, 'team', t.id);
    await say(ana, path, `@{${ben.user.id}} @{${ana.user.id}} hi`);
    await until(() => b.frames.some((f) => f.t === 'message'));
    await flushed(a);
    await flushed(b);
    expect([...a.frames, ...b.frames].some((f) => f.t === 'mention')).toBe(false);
  });

  it('notices a mention added by an edit, not one that was already there', async () => {
    const { ana, ben, path } = await team();
    const b = await ready(ben.cookie);
    const m = (await say(ana, path, 'no one yet')).body.message;
    await h.api(ana.cookie, 'PATCH', `/api/chat/messages/${m.id}`, { text: `now @{${ben.user.id}}` });
    await until(() => b.frames.some((f) => f.t === 'mention'));
    await h.api(ana.cookie, 'PATCH', `/api/chat/messages/${m.id}`, { text: `still @{${ben.user.id}}!` });
    await flushed(b);
    expect(b.frames.filter((f) => f.t === 'mention')).toHaveLength(1);
  });
});

describe('the mention email', { timeout: 60_000 }, () => {
  it('is sent once when the person has no tab open and has not read it, with a generic subject', async () => {
    const { t, ana, ben, path } = await team();
    await h.api(ben.cookie, 'GET', '/api/chat/channels');
    const before = mailsTo(ben.email).length;
    await say(ana, path, `@{${ben.user.id}} can you check the room?`);
    await until(() => mailsTo(ben.email).length > before, 8000);
    const mail = mailsTo(ben.email).at(-1) as { subject?: string; text: string };
    expect(mail.text).toContain(`${ana.user.name} mentioned you in`);
    expect(mail.text).toContain('can you check the room?');
    expect(mail.text).toContain('#/chat/team/');
    await say(ana, path, `@{${ben.user.id}} again`);
    const cara = await h.joinTeam(owner.cookie, t.id);
    const caraBefore = mailsTo(cara.email).length;
    // This later positive email confirms the earlier duplicate's due timer has also been checked.
    await say(ana, path, `@{${cara.user.id}} timer check`);
    await until(() => mailsTo(cara.email).length > caraBefore, 8000);
    expect(mailsTo(ben.email).length).toBe(before + 1);
  });

  it('is not sent to a person who turned it off', async () => {
    const { t, ana, ben, path } = await team();
    expect((await h.api(ben.cookie, 'PUT', '/api/me/prefs', { emailMentions: false })).body).toEqual({ emailMentions: false });
    const before = mailsTo(ben.email).length;
    await say(ana, path, `@{${ben.user.id}} hello`);
    const cara = await h.joinTeam(owner.cookie, t.id);
    const caraBefore = mailsTo(cara.email).length;
    await say(ana, path, `@{${cara.user.id}} timer check`);
    await until(() => mailsTo(cara.email).length > caraBefore, 8000);
    expect(mailsTo(ben.email).length).toBe(before);
  });

  it('is not sent when the person opens the app before it is due', async () => {
    const { t, ana, ben, path } = await team();
    const before = mailsTo(ben.email).length;
    await say(ana, path, `@{${ben.user.id}} are you there`);
    const b = await ready(ben.cookie);
    const cara = await h.joinTeam(owner.cookie, t.id);
    const caraBefore = mailsTo(cara.email).length;
    await say(ana, path, `@{${cara.user.id}} timer check`);
    await until(() => mailsTo(cara.email).length > caraBefore, 8000);
    b.ws.terminate();
    expect(mailsTo(ben.email).length).toBe(before);
  });

  it('is not sent when the mention was read, or edited away', async () => {
    const { t, ana, ben, path } = await team();
    await h.api(ben.cookie, 'GET', '/api/chat/channels');
    const before = mailsTo(ben.email).length;
    const m = (await say(ana, path, `@{${ben.user.id}} one`)).body.message;
    await h.api(ben.cookie, 'PUT', `/api/chat/${path}/read`, { lastId: m.id });
    const cara = await h.joinTeam(owner.cookie, t.id);
    let caraBefore = mailsTo(cara.email).length;
    await say(ana, path, `@{${cara.user.id}} read timer check`);
    await until(() => mailsTo(cara.email).length > caraBefore, 8000);
    expect(mailsTo(ben.email).length).toBe(before);
    const n = (await say(ana, path, `@{${ben.user.id}} two`)).body.message;
    await h.api(ana.cookie, 'PATCH', `/api/chat/messages/${n.id}`, { text: 'two, nobody' });
    const dan = await h.joinTeam(owner.cookie, t.id);
    caraBefore = mailsTo(dan.email).length;
    await say(ana, path, `@{${dan.user.id}} edit timer check`);
    await until(() => mailsTo(dan.email).length > caraBefore, 8000);
    expect(mailsTo(ben.email).length).toBe(before);
  });
});

describe('chat preferences', { timeout: 60_000 }, () => {
  it('start with mention emails on, and are the person’s own', async () => {
    const { ana, ben } = await team();
    expect((await h.api(ana.cookie, 'GET', '/api/me/prefs')).body).toEqual({ emailMentions: true });
    await h.api(ana.cookie, 'PUT', '/api/me/prefs', { emailMentions: false });
    expect((await h.api(ana.cookie, 'GET', '/api/me/prefs')).body).toEqual({ emailMentions: false });
    expect((await h.api(ben.cookie, 'GET', '/api/me/prefs')).body).toEqual({ emailMentions: true });
  });

  it('refuse what they do not know', async () => {
    const { ana } = await team();
    expect((await h.api(ana.cookie, 'PUT', '/api/me/prefs', { emailMentions: 'yes' })).status).toBe(400);
    expect((await h.api(ana.cookie, 'PUT', '/api/me/prefs', { emailMentions: true, other: 1 })).status).toBe(400);
    expect((await h.api(ana.cookie, 'PUT', '/api/me/prefs', {})).status).toBe(400);
    expect((await h.api(undefined, 'GET', '/api/me/prefs')).status).toBe(401);
  });
});
