import { describe, expect, it, vi } from 'vitest';
import { POLL_MS, createNotificationsStore, type NotificationsApi } from '../src/notifications';

// The bell's counts and the panel's list: loading, a failed refresh that keeps the list, new rows behind "Show N new", optimistic
// reads that roll back, and the poll that stands in for the socket.

const row = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'chat_mention', at: 1000 - Number(id.replace(/\D/g, '') || 0), read: false, actor: { id: 'u', name: 'Ana' }, board: { id: 'b', title: 'Board' }, team: null, snippet: null, target: '#/b/b', ...over });
const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ items, nextCursor: null, unread: items.length, unreadMentions: items.length, ...over });

function setup(over: Partial<{ pages: Record<string, unknown[]>; readFails: boolean }> = {}) {
  const calls = { page: [] as unknown[], read: [] as unknown[], counts: 0 };
  let timer: (() => void) | null = null;
  let hidden = false;
  const data = { all: [row('n_1'), row('n_2', { kind: 'board_shared' })] } as Record<string, unknown[]>;
  Object.assign(data, over.pages);
  const api: NotificationsApi = {
    page: vi.fn<NotificationsApi['page']>(async (before) => { calls.page.push(before ?? null); return page(data.all, { unread: 2, unreadMentions: 1 }); }),
    counts: vi.fn<NotificationsApi['counts']>(async () => { calls.counts++; return { unread: 5, unreadMentions: 2 }; }),
    read: vi.fn<NotificationsApi['read']>(async (body) => { calls.read.push(body); if (over.readFails) throw new Error('offline'); return { unread: 1, unreadMentions: 0 }; }),
  };
  const onReadFailed = vi.fn<() => void>();
  const store = createNotificationsStore({ api, onReadFailed, hidden: () => hidden, setTimer: (fn, ms) => { expect(ms).toBe(POLL_MS); timer = fn; return 1; }, clearTimer: () => { timer = null; } });
  return { store, api, calls, data, onReadFailed, tick: () => timer?.(), hide: (h: boolean) => { hidden = h; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('loading', () => {
  it('loads the list when the panel opens, with the counts from the page, and not again while it is fresh', async () => {
    const s = setup();
    s.store.setOpen(true);
    expect(s.store.state().list.status).toBe('loading');
    await settle();
    expect([s.store.state().list.status, s.store.state().list.items.length, s.store.state().counts]).toEqual(['ready', 2, { unread: 2, unreadMentions: 1 }]);
    s.store.setOpen(false);
    s.store.setOpen(true);
    await settle();
    expect(s.calls.page).toHaveLength(1);
  });

  it('narrows to Mentions without asking the server again', async () => {
    const s = setup();
    s.store.setOpen(true);
    await settle();
    s.store.setFilter('mentions');
    expect(s.store.state().filter).toBe('mentions');
    s.store.setFilter('all');
    await settle();
    expect(s.calls.page).toHaveLength(1);
  });

  it('shows an error with nothing to show, and tries again', async () => {
    const s = setup();
    vi.mocked(s.api.page).mockRejectedValueOnce(new Error('down'));
    s.store.setOpen(true);
    await settle();
    expect(s.store.state().list.status).toBe('error');
    s.store.retry();
    await settle();
    expect(s.store.state().list.status).toBe('ready');
  });

  it('pages on with a cursor and does not repeat a row', async () => {
    const s = setup();
    vi.mocked(s.api.page).mockResolvedValueOnce(page([row('n_1'), row('n_2')], { nextCursor: 'c1' })).mockResolvedValueOnce(page([row('n_2'), row('n_3')]));
    s.store.setOpen(true);
    await settle();
    s.store.loadMore();
    await settle();
    expect(s.store.state().list.items.map((i) => i.id)).toEqual(['n_1', 'n_2', 'n_3']);
    expect(s.store.state().list.nextCursor).toBeNull();
  });
});

describe('live changes', () => {
  it('puts new rows behind "Show N new" while the panel is open and never moves the rows on screen', async () => {
    const s = setup();
    s.store.setOpen(true);
    await settle();
    s.data.all = [row('n_9', { at: 5000 }), row('n_1'), row('n_2', { kind: 'board_shared', read: true })];
    s.store.notified({ unread: 3, unreadMentions: 2 });
    await settle();
    const list = s.store.state().list;
    expect(list.items.map((i) => i.id)).toEqual(['n_1', 'n_2']);
    expect(list.pending.map((i) => i.id)).toEqual(['n_9']);
    expect(list.items[1].read).toBe(true); // a read that happened elsewhere shows at once
    expect(s.store.state().counts.unread).toBe(2); // the page's own counts follow the fetch
    s.store.showNew();
    expect(s.store.state().list.items.map((i) => i.id)).toEqual(['n_9', 'n_1', 'n_2']);
    expect(s.store.state().list.pending).toEqual([]);
  });

  it('keeps the list and sets a slim error when a refresh fails, and takes the badge from the frame when closed', async () => {
    const s = setup();
    s.store.setOpen(true);
    await settle();
    vi.mocked(s.api.page).mockRejectedValueOnce(new Error('down'));
    s.store.notified({ unread: 4, unreadMentions: 1 });
    await settle();
    expect([s.store.state().list.status, s.store.state().list.failed, s.store.state().list.items.length]).toEqual(['ready', true, 2]);
    s.store.setOpen(false);
    s.store.notified({ unread: 6, unreadMentions: 1 });
    expect(s.store.state().counts.unread).toBe(6);
    expect(s.store.state().list.stale).toBe(true);
    s.store.setOpen(true); // a stale list is fetched again on opening
    await settle();
    expect(s.store.state().list.stale).toBe(false);
  });

  it('polls the counts every 60 s while visible when there is no socket, and not while hidden', async () => {
    const s = setup();
    s.store.start({ poll: true });
    await settle();
    expect(s.calls.counts).toBe(1);
    s.tick();
    await settle();
    expect(s.calls.counts).toBe(2);
    s.hide(true);
    s.tick();
    await settle();
    expect(s.calls.counts).toBe(2);
    s.store.stop();
  });
});

describe('reading', () => {
  it('marks a row read at once, drops the counts, and saves it', async () => {
    const s = setup();
    s.store.setOpen(true);
    await settle();
    const done = s.store.markRead(['n_1']);
    expect(s.store.state().list.items[0].read).toBe(true);
    expect(s.store.state().counts).toEqual({ unread: 1, unreadMentions: 0 });
    await done;
    expect(s.calls.read).toEqual([{ ids: ['n_1'] }]);
    expect(s.store.state().counts).toEqual({ unread: 1, unreadMentions: 0 }); // the server's answer
  });

  it('puts the dots back and says so when a read cannot be saved', async () => {
    const s = setup({ readFails: true });
    s.store.setOpen(true);
    await settle();
    await s.store.markRead(['n_1']);
    expect(s.store.state().list.items.every((i) => !i.read)).toBe(true);
    expect(s.store.state().counts).toEqual({ unread: 2, unreadMentions: 1 });
    expect(s.onReadFailed).toHaveBeenCalledTimes(1);
  });

  it('marks everything read, and rolls that back too', async () => {
    const ok = setup();
    ok.store.setOpen(true);
    await settle();
    await ok.store.markAllRead();
    expect(ok.calls.read).toEqual([{ all: true }]);
    expect(ok.store.state().list.items.every((i) => i.read)).toBe(true);
    const bad = setup({ readFails: true });
    bad.store.setOpen(true);
    await settle();
    await bad.store.markAllRead();
    expect(bad.store.state().list.items.every((i) => !i.read)).toBe(true);
    expect(bad.onReadFailed).toHaveBeenCalledTimes(1);
  });

  it('sends at most 100 ids in one read', async () => {
    const s = setup();
    await s.store.markRead(Array.from({ length: 150 }, (_, i) => `n_${i}`));
    expect((s.calls.read[0] as { ids: string[] }).ids).toHaveLength(100);
  });
});
