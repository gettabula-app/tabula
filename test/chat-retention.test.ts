import { afterEach, describe, expect, it } from 'vitest';
import { openChat } from '../server/chat.mjs';
import { DAY_MS, createChatRetention } from '../server/chat-retention.mjs';

// docs/chat.md, Retention: the daily job that deletes messages older than "Keep chat messages", in batches, with
// their mentions and reactions, and leaves one audit row with counts only.

const NOW = Date.UTC(2026, 9, 9, 12);
const open = openChat;
const stores: ReturnType<typeof openChat>[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function fixture(days: number | null | 'default', { batch = 1000 } = {}) {
  const store = open(':memory:');
  stores.push(store);
  const audits: { user: string | null; action: string; detail: any }[] = [];
  const settings: Record<string, string> = days === 'default' ? {} : { 'chat.retentionDays': days === null ? 'forever' : String(days) };
  const directory = {
    getSetting: (key: string) => settings[key] ?? null,
    audit: (user: string | null, action: string, detail: any) => void audits.push({ user, action, detail }),
  };
  let paused = false;
  const job = createChatRetention({ directory, store: () => store, paused: () => paused, now: () => NOW, timers: false, batch });
  const add = (ageDays: number, text = 'm', ref = 'b1', kind = 'board') =>
    store.insertMessage({ kind, ref, authorId: 'ana', authorName: 'Ana', body: text, clientId: `c-${Math.random().toString(36).slice(2)}-${text}`, now: NOW - ageDays * DAY_MS }).message;
  return { store, audits, job, add, pause: (on: boolean) => (paused = on) };
}

describe('the retention job', () => {
  it('deletes messages older than the setting and keeps the rest', async () => {
    const { store, job, add, audits } = fixture(30);
    add(40, 'old');
    add(31, 'older');
    const keep = add(29, 'recent');
    add(0, 'today');
    expect(await job.run()).toBe(2);
    expect(store.listMessages('board', 'b1').messages.map((m) => m.body)).toEqual(['recent', 'today']);
    expect(store.getMessage(keep.id)?.body).toBe('recent');
    expect(audits).toEqual([{ user: null, action: 'chat.retention', detail: { days: 30, removed: 2 } }]);
  });

  it('keeps a year by default', async () => {
    const { store, job, add } = fixture('default');
    add(400, 'too old');
    add(364, 'kept');
    expect(await job.run()).toBe(1);
    expect(store.listMessages('board', 'b1').messages.map((m) => m.body)).toEqual(['kept']);
  });

  it('keeps everything when the setting is forever', async () => {
    const { store, job, add, audits } = fixture(null);
    add(2000, 'ancient');
    expect(await job.run()).toBe(0);
    expect(store.listMessages('board', 'b1').messages).toHaveLength(1);
    expect(audits).toEqual([]);
  });

  it('goes through every channel kind, takes mentions and reactions with the messages, and tombstones too', async () => {
    const { store, job, add } = fixture(90);
    const mention = store.insertMessage({ kind: 'team', ref: 't1', authorId: 'ana', authorName: 'Ana', body: '@{ben}', clientId: 'cid-mention-1', mentions: ['ben'], now: NOW - 100 * DAY_MS }).message;
    const gone = add(120, 'bye', 'main', 'workspace');
    store.deleteMessage(gone.id, 'ana', NOW - 119 * DAY_MS);
    const keep = add(1, 'keep', 'main', 'workspace');
    expect(await job.run()).toBe(2);
    expect(store.getMessage(mention.id)).toBeNull();
    expect(store.getMessage(gone.id)).toBeNull();
    expect(store.getMessage(keep.id)?.body).toBe('keep');
    expect(store.channelUnread('ben', 'team', 't1')).toMatchObject({ unread: 0, mentions: 0 });
  });

  it('works in batches until nothing is left, and audits once with the total', async () => {
    const { store, job, add, audits } = fixture(30, { batch: 3 });
    for (let i = 0; i < 10; i++) add(60 + i, `old${i}`);
    add(1, 'new');
    expect(await job.run()).toBe(10);
    expect(store.listMessages('board', 'b1').messages.map((m) => m.body)).toEqual(['new']);
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toEqual({ days: 30, removed: 10 });
  });

  it('does nothing while the workspace is being restored', async () => {
    const { store, job, add, pause } = fixture(30);
    add(60, 'old');
    pause(true);
    expect(await job.run()).toBe(0);
    pause(false);
    expect(store.listMessages('board', 'b1').messages).toHaveLength(1);
  });

  it('runs one pass at a time', async () => {
    const { job, add } = fixture(30);
    add(60, 'old');
    const [a, b] = await Promise.all([job.run(), job.run()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('never writes message text to the audit row', async () => {
    const { job, add, audits } = fixture(30);
    add(60, 'a secret text');
    await job.run();
    expect(JSON.stringify(audits)).not.toContain('secret');
  });

  it('lets the next unread count ignore what was removed', async () => {
    const { store, job, add } = fixture(30);
    store.markRead('ben', 'board', 'b1', 0);
    add(60, 'old');
    add(1, 'new');
    await job.run();
    expect(store.channelUnread('ben', 'board', 'b1').unread).toBe(1);
  });
});
