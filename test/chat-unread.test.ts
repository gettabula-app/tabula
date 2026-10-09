import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHAT_MIGRATIONS, openChat, readChatSettings } from '../server/chat.mjs';

// The chat store on its own (docs/chat.md, Schema and Unread): ordering, idempotent sends, tombstones, read markers.

let store: ReturnType<typeof openChat> | null = null;
const dirs: string[] = [];

afterEach(() => {
  store?.close();
  store = null;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const open = () => (store = openChat(':memory:'));
let n = 0;
const post = (s: ReturnType<typeof openChat>, authorId: string, extra: Record<string, unknown> = {}) =>
  s.insertMessage({ kind: 'board', ref: 'b1', authorId, authorName: authorId, body: `m${++n}`, clientId: `client-${n}-xyz`, ...extra }).message;

describe('the chat database', () => {
  it('is created on first open with its own schema version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-chat-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'chat.sqlite');
    openChat(file).close();
    const db = new DatabaseSync(file);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CHAT_MIGRATIONS.length);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(['chat_messages', 'chat_mentions', 'chat_reactions', 'chat_reads']));
      db.exec('PRAGMA user_version = 99');
    } finally {
      db.close();
    }
    expect(() => openChat(file)).toThrow(/newer Tabula/);
  });

  it('orders by id, pages backwards with before, and says where the next page starts', () => {
    const s = open();
    const ids = Array.from({ length: 7 }, () => post(s, 'ana').id);
    const first = s.listMessages('board', 'b1', { limit: 3 });
    expect(first.messages.map((m) => m.id)).toEqual(ids.slice(4));
    expect(first.next).toBe(ids[4]);
    const second = s.listMessages('board', 'b1', { limit: 3, before: first.next });
    expect(second.messages.map((m) => m.id)).toEqual(ids.slice(1, 4));
    const last = s.listMessages('board', 'b1', { limit: 3, before: second.next });
    expect(last.messages.map((m) => m.id)).toEqual(ids.slice(0, 1));
    expect(last.next).toBeNull();
    expect(s.listMessages('board', 'other').messages).toEqual([]);
  });

  it('stores a clientId once per author and channel', () => {
    const s = open();
    const a = s.insertMessage({ kind: 'board', ref: 'b1', authorId: 'ana', authorName: 'Ana', body: 'first', clientId: 'same-client-id' });
    const again = s.insertMessage({ kind: 'board', ref: 'b1', authorId: 'ana', authorName: 'Ana', body: 'changed', clientId: 'same-client-id' });
    expect(a.created).toBe(true);
    expect(again).toEqual({ message: a.message, created: false });
    const other = s.insertMessage({ kind: 'board', ref: 'b1', authorId: 'ben', authorName: 'Ben', body: 'mine', clientId: 'same-client-id' });
    expect(other.created).toBe(true);
  });

  it('overwrites the text of a deleted message and drops its mentions', () => {
    const s = open();
    const m = post(s, 'ana', { mentions: ['ben'] });
    expect(s.getMessage(m.id)!.mentions).toEqual(['ben']);
    const gone = s.deleteMessage(m.id, 'ana');
    expect(gone).toMatchObject({ body: '', deletedBy: 'ana', mentions: [] });
    expect(gone!.deletedAt).toBeGreaterThan(0);
  });

  it('marks an edit and replaces the mentions', () => {
    const s = open();
    const m = post(s, 'ana', { mentions: ['ben'] });
    const edited = s.editMessage(m.id, 'new', ['cy']);
    expect(edited).toMatchObject({ body: 'new', mentions: ['cy'] });
    expect(edited!.editedAt).toBeGreaterThan(0);
  });
});

describe('read markers and unread counts', () => {
  it('start caught up for someone who never read the channel', () => {
    const s = open();
    post(s, 'ana');
    post(s, 'ana');
    expect(s.channelUnread('ben', 'board', 'b1')).toMatchObject({ unread: 0, mentions: 0 });
    post(s, 'ana');
    expect(s.channelUnread('ben', 'board', 'b1')).toMatchObject({ unread: 1, mentions: 0 });
  });

  it('count from the first message of a channel that was empty when the person was first seen', () => {
    const s = open();
    expect(s.unreadSummary('ben', 'board', ['b1'])).toEqual([]);
    post(s, 'ana');
    expect(s.unreadSummary('ben', 'board', ['b1'])).toMatchObject([{ kind: 'board', ref: 'b1', unread: 1, mentions: 0 }]);
  });

  it('always count a mention, even before the person was first seen', () => {
    const s = open();
    post(s, 'ana');
    const mention = post(s, 'ana', { mentions: ['ben'] });
    post(s, 'ana');
    expect(s.channelUnread('ben', 'board', 'b1')).toMatchObject({ unread: 2, mentions: 1, lastId: mention.id - 1 });
  });

  it('move forward only, and never past the newest message', () => {
    const s = open();
    const a = post(s, 'ana');
    const b = post(s, 'ana');
    expect(s.markRead('ben', 'board', 'b1', b.id)).toBe(b.id);
    expect(s.markRead('ben', 'board', 'b1', a.id)).toBe(b.id);
    expect(s.markRead('ben', 'board', 'b1', b.id + 1000)).toBe(b.id);
    expect(s.markRead('ben', 'board', 'b1', -5)).toBe(b.id);
  });

  it('do not count the person’s own messages or tombstones', () => {
    const s = open();
    s.markRead('ben', 'board', 'b1', 0);
    post(s, 'ben');
    const gone = post(s, 'ana', { mentions: ['ben'] });
    s.deleteMessage(gone.id, 'ana');
    post(s, 'ana');
    expect(s.channelUnread('ben', 'board', 'b1')).toMatchObject({ unread: 1, mentions: 0 });
  });

  it('count mentions after the marker only', () => {
    const s = open();
    s.markRead('ben', 'board', 'b1', 0);
    const old = post(s, 'ana', { mentions: ['ben'] });
    s.markRead('ben', 'board', 'b1', old.id);
    post(s, 'ana', { mentions: ['ben'] });
    post(s, 'ana');
    expect(s.channelUnread('ben', 'board', 'b1')).toMatchObject({ unread: 2, mentions: 1 });
  });

  it('summarise only the channels asked for that have something unread', () => {
    const s = open();
    for (const ref of ['b1', 'b2', 'b3']) s.markRead('ben', 'board', ref, 0);
    s.insertMessage({ kind: 'board', ref: 'b1', authorId: 'ana', authorName: 'Ana', body: 'x', clientId: 'cid-b1-0001' });
    s.insertMessage({ kind: 'board', ref: 'b3', authorId: 'ana', authorName: 'Ana', body: 'x', clientId: 'cid-b3-0001' });
    expect(s.unreadSummary('ben', 'board', ['b1', 'b2']).map((c) => c.ref)).toEqual(['b1']);
  });
});

describe('chat settings', () => {
  const dir = (values: Record<string, string>) => ({ getSetting: (key: string) => values[key] ?? null });

  it('default to viewers reading only and keeping messages for a year', () => {
    expect(readChatSettings(dir({}))).toEqual({ viewersMayPost: false, retentionDays: 365 });
  });

  it('read what was stored, and fall back on a value that is not a choice', () => {
    expect(readChatSettings(dir({ 'chat.viewersMayPost': '1', 'chat.retentionDays': '30' }))).toEqual({ viewersMayPost: true, retentionDays: 30 });
    expect(readChatSettings(dir({ 'chat.retentionDays': 'forever' }))).toEqual({ viewersMayPost: false, retentionDays: null });
    expect(readChatSettings(dir({ 'chat.retentionDays': '7' }))).toEqual({ viewersMayPost: false, retentionDays: 365 });
  });
});
