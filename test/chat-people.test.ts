import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { openChat } from '../server/chat.mjs';
import { createHarness, until, type Account } from './mcp-harness';

// docs/chat.md, Removing and erasing people: a removed member's messages stay without an account, an administrator can
// erase a person's messages across every channel, and can take a copy of what a person wrote.

describe('the store, for one person leaving or being erased', () => {
  const stores: ReturnType<typeof openChat>[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });
  function world() {
    const s = openChat(':memory:');
    stores.push(s);
    const say = (kind: string, ref: string, author: string, body: string, mentions: string[] = [], replyTo: number | null = null) =>
      s.insertMessage({ kind, ref, authorId: author, authorName: author === 'ana' ? 'Ana Lima' : 'Ben', body, replyTo, clientId: `c-${Math.random().toString(36).slice(2)}-xx`, mentions, now: 1000 }).message;
    return { s, say };
  }

  it('anonymising keeps the messages and the name they were written under, and drops reactions, markers and mentions of the person', () => {
    const { s, say } = world();
    const a = say('board', 'b1', 'ana', 'hello');
    const b = say('team', 't1', 'ben', 'hi @ana', ['ana']);
    s.setReaction(b.id, 'ana', '👍', true);
    s.setReaction(a.id, 'ben', '🎉', true);
    s.markRead('ana', 'team', 't1', b.id);
    expect(s.anonymiseAuthor('ana')).toBe(1);
    expect(s.getMessage(a.id)).toMatchObject({ authorId: null, authorName: 'Ana Lima', body: 'hello', deletedAt: null });
    expect(s.getMessage(a.id)!.reactions).toEqual([{ emoji: '🎉', userIds: ['ben'] }]);
    expect(s.getMessage(b.id)).toMatchObject({ authorId: 'ben', mentions: [], reactions: [] });
    expect(s.readMarker('ana', 'team', 't1')).toBeNull();
  });

  it('erasing wipes every message of the person in every channel and says which were live', () => {
    const { s, say } = world();
    const a1 = say('board', 'b1', 'ana', 'one');
    const a2 = say('team', 't1', 'ana', 'two @ben', ['ben']);
    const a3 = say('workspace', 'main', 'ana', 'three');
    s.deleteMessage(a3.id, 'ana');
    const reply = say('team', 't1', 'ben', 'replying', [], a2.id);
    s.setReaction(a1.id, 'ben', '👀', true);
    const result = s.eraseAuthor('ana', 'admin1', 5000);
    expect(result.count).toBe(2);
    expect(result.messages.map((m) => m.id)).toEqual([a1.id, a2.id]);
    for (const m of [a1, a2, a3]) {
      expect(s.getMessage(m.id)).toMatchObject({ authorId: null, authorName: 'Former member', body: '', mentions: [], reactions: [] });
      expect(s.getMessage(m.id)!.deletedAt).not.toBeNull();
    }
    expect(s.getMessage(a1.id)).toMatchObject({ deletedAt: 5000, deletedBy: 'admin1' });
    // a message deleted before keeps who deleted it and when
    expect(s.getMessage(a3.id)!.deletedBy).toBe('ana');
    // the reply stays, and its quote now points at a tombstone
    expect(s.getMessage(reply.id)).toMatchObject({ body: 'replying', replyTo: a2.id });
    expect(s.channelUnread('ben', 'team', 't1').mentions).toBe(0);
  });

  it('erasing leaves other people alone and is harmless for someone who never wrote', () => {
    const { s, say } = world();
    const b = say('board', 'b1', 'ben', 'mine');
    expect(s.eraseAuthor('ana', 'admin1').count).toBe(0);
    expect(s.getMessage(b.id)).toMatchObject({ authorId: 'ben', body: 'mine', deletedAt: null });
  });

  it('exports what a person wrote, with deleted messages as bare tombstones, and the reactions they gave', () => {
    const { s, say } = world();
    const a1 = say('board', 'b1', 'ana', 'first @ben', ['ben']);
    const a2 = say('team', 't1', 'ana', 'second');
    const b = say('team', 't1', 'ben', 'not hers');
    s.deleteMessage(a2.id, 'ana');
    s.setReaction(b.id, 'ana', '❤️', true);
    const out = s.exportAuthor('ana');
    expect(out.messages.map((m) => m.id)).toEqual([a1.id, a2.id]);
    expect(out.messages[0]).toMatchObject({ channel: { kind: 'board', ref: 'b1' }, text: 'first @ben', mentions: ['ben'] });
    expect(out.messages[1]).toMatchObject({ text: null });
    expect(out.reactions).toEqual([{ messageId: b.id, emoji: '❤️' }]);
    expect(JSON.stringify(out)).not.toContain('not hers');
  });
});

const h = createHarness({ accounts: true, settings: { CHAT: 'on' } });
let owner: Account;
const clients = new Set<WebSocket>();

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
});
afterEach(async () => {
  for (const ws of clients) ws.terminate();
  await until(() => [...clients].every((w) => w.readyState === WebSocket.CLOSED));
  clients.clear();
});
afterAll(() => h.cleanup());

const say = (who: Account, path: string, text: string) => h.api(who.cookie, 'POST', `/api/chat/${path}/messages`, { clientId: crypto.randomUUID(), text });
async function team() {
  const t = await h.newTeam(owner.cookie);
  const ana = await h.joinTeam(owner.cookie, t.id);
  const ben = await h.joinTeam(owner.cookie, t.id);
  return { t, ana, ben, path: `team/${t.id}` };
}
const listed = async (who: Account, path: string) => (await h.api(who.cookie, 'GET', `/api/chat/${path}/messages`)).body.messages as any[];

describe('removing a member', { timeout: 60_000 }, () => {
  it('keeps their messages under the name they used, without an account', async () => {
    const { ana, ben, path } = await team();
    await say(ana, path, 'I was here');
    expect((await h.api(owner.cookie, 'DELETE', `/api/members/${ana.user.id}`)).status).toBe(204);
    await until(async () => (await listed(ben, path))[0]?.authorId === null);
    expect((await listed(ben, path))[0]).toMatchObject({ authorId: null, authorName: ana.user.name, text: 'I was here', deleted: false });
  });
});

describe('erasing a person’s messages', { timeout: 60_000 }, () => {
  it('wipes them everywhere, tells the people watching, and writes an audit row with a count and no text', async () => {
    const { t, ana, ben, path } = await team();
    await say(ana, path, 'secret one');
    await say(ana, 'workspace/main', 'secret two');
    await say(ben, path, 'unrelated');
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/chat`, { headers: { Origin: h.base, Cookie: ben.cookie } });
    clients.add(ws);
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    await until(() => frames.some((f) => f.t === 'hello'));
    ws.send(JSON.stringify({ t: 'sub', kind: 'team', ref: t.id }));
    await until(() => frames.some((f) => f.t === 'subscribed'));
    const res = await h.api(owner.cookie, 'POST', `/api/admin/members/${ana.user.id}/chat-erase`);
    expect(res.body).toEqual({ removed: 2 });
    const mine = await listed(ben, path);
    expect(mine.map((m) => [m.text, m.deleted, m.authorName])).toEqual([['', true, 'Former member'], ['unrelated', false, ben.user.name]]);
    expect(JSON.stringify(await listed(owner, 'workspace/main'))).not.toContain('secret');
    await until(() => frames.some((f) => f.t === 'delete' && f.kind === 'team'));
    const rows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?action=chat.erase')).body.entries;
    expect(rows[0]).toMatchObject({ actorId: owner.user.id, detail: { userId: ana.user.id, count: 2 } });
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('is for owners and admins, answers 404 for nobody, and keeps an owner’s messages from an admin', async () => {
    const { ana, ben } = await team();
    expect((await h.api(ana.cookie, 'POST', `/api/admin/members/${ben.user.id}/chat-erase`)).status).toBe(403);
    expect((await h.api(owner.cookie, 'POST', '/api/admin/members/nobody/chat-erase')).status).toBe(404);
    expect((await h.api(undefined, 'POST', `/api/admin/members/${ben.user.id}/chat-erase`)).status).toBe(401);
    expect((await h.api(owner.cookie, 'PATCH', `/api/members/${ana.user.id}`, { role: 'admin' })).status).toBe(200);
    expect((await h.api(ana.cookie, 'POST', `/api/admin/members/${owner.user.id}/chat-erase`)).status).toBe(403);
    expect((await h.api(ana.cookie, 'POST', `/api/admin/members/${ben.user.id}/chat-erase`)).status).toBe(200);
  });
});

describe('the export of a person’s messages', { timeout: 60_000 }, () => {
  it('is a file of what they wrote and the reactions they gave, and an audit row without text', async () => {
    const { ana, ben, path } = await team();
    const first = (await say(ana, path, 'for the record')).body.message;
    const theirs = (await say(ben, path, 'from ben')).body.message;
    await h.api(ana.cookie, 'PUT', `/api/chat/messages/${theirs.id}/reactions/${encodeURIComponent('👍')}`);
    const res = await h.api(owner.cookie, 'GET', `/api/admin/members/${ana.user.id}/chat-export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.body).toMatchObject({ format: 'tabula-chat-export', person: { id: ana.user.id, email: ana.email } });
    expect(res.body.messages.map((m: any) => [m.id, m.text])).toEqual([[first.id, 'for the record']]);
    expect(res.body.reactions).toEqual([{ messageId: theirs.id, emoji: '👍' }]);
    expect(JSON.stringify(res.body)).not.toContain('from ben');
    const rows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?action=chat.export')).body.entries;
    expect(rows[0]).toMatchObject({ detail: { userId: ana.user.id, count: 1 } });
    expect(JSON.stringify(rows)).not.toContain('for the record');
  });

  it('is for owners and admins only', async () => {
    const { ana, ben } = await team();
    expect((await h.api(ana.cookie, 'GET', `/api/admin/members/${ben.user.id}/chat-export`)).status).toBe(403);
    expect((await h.api(owner.cookie, 'GET', '/api/admin/members/nobody/chat-export')).status).toBe(404);
  });
});
