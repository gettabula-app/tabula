import { describe, expect, it } from 'vitest';
import {
  TrackerError,
  createMockTrackerApi,
  createTrackerStore,
  type TrackerTicket,
} from '../src/tracker-data';

function ticket(overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    id: 'ticket-1', key: 'TAB-1', trackerId: 'tracker-demo', title: 'Original title', description: '',
    state: { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted' }, priority: 'none',
    assignee: null, creator: { type: 'user', id: 'user-me', name: 'You' }, labels: [], project: null,
    milestone: null, estimate: null, due: null, parent: null, relations: [], links: [], aliases: [],
    archivedAt: null, createdAt: 1, updatedAt: 2, updatedSeq: 3, ...overrides,
  };
}

function timerRig() {
  let next = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  return {
    tasks,
    setTimer(callback: () => void, delay: number) { const id = ++next; tasks.set(id, { callback, delay }); return id; },
    clearTimer(handle: unknown) { tasks.delete(handle as number); },
    fireNext() {
      const [id, task] = tasks.entries().next().value as [number, { callback: () => void; delay: number }];
      tasks.delete(id);
      task.callback();
      return task.delay;
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe('tracker store writes', () => {
  it('shows an optimistic edit and restores the prior row after a failed request', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const store = createTrackerStore(api);
    await store.loadList();
    let markStarted!: () => void;
    let rejectRequest!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    api.patchTicket = async () => {
      markStarted();
      return new Promise((_resolve, reject) => { rejectRequest = reject; });
    };
    const edit = store.updateTicket('TAB-1', { title: 'Optimistic title' });
    await started;
    expect(store.ticket('TAB-1').ticket?.title).toBe('Optimistic title');
    expect(store.list().tickets[0].title).toBe('Optimistic title');
    expect(store.ticket('TAB-1').pending).toBe(true);
    rejectRequest(new TrackerError('forbidden', 'Denied'));
    await expect(edit).rejects.toMatchObject({ code: 'forbidden' });
    expect(store.ticket('TAB-1').ticket?.title).toBe('Original title');
    expect(store.list().tickets[0].title).toBe('Original title');
    expect(store.ticket('TAB-1').pending).toBe(false);
    store.destroy();
  });

  it('re-bases a conflict from the server and exposes the current ticket to the UI', async () => {
    const current = ticket({ title: 'Remote edit', updatedSeq: 8 });
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const store = createTrackerStore(api);
    await store.loadList();
    api.patchTicket = async () => { throw new TrackerError('conflict', 'Stale', { current }); };
    await expect(store.updateTicket('TAB-1', { title: 'Local edit' })).rejects.toMatchObject({ code: 'conflict' });
    expect(store.ticket('TAB-1')).toMatchObject({ ticket: current, conflict: current, error: { code: 'conflict' }, pending: false });
    store.destroy();
  });

  it('keeps one feed timer for all watchers and stops it after the last unsubscribe', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const timers = timerRig();
    const store = createTrackerStore(api, { pollMs: 5000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    await store.loadTicket('TAB-1');
    await store.loadList();
    const unwatchTicket = store.watchTicket('TAB-1', () => undefined);
    const unwatchList = store.watchList({}, () => undefined);
    expect(timers.tasks.size).toBe(1);
    unwatchTicket();
    expect(timers.tasks.size).toBe(1);
    unwatchList();
    expect(timers.tasks.size).toBe(0);
    store.destroy();
  });

  it('caches normalized list queries, paging, and facets', async () => {
    const seeded = [
      ticket({ id: 't1', key: 'TAB-1', updatedSeq: 1 }),
      ticket({ id: 't2', key: 'TAB-2', updatedSeq: 2, updatedAt: 3 }),
      ticket({ id: 't3', key: 'TAB-3', updatedSeq: 3, updatedAt: 4 }),
    ];
    const api = createMockTrackerApi({ tickets: seeded });
    const store = createTrackerStore(api);
    const query = { filter: ['state:todo'], limit: 2, includeFacets: true };
    const first = await store.loadList(query);
    expect(first.tickets).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.facets?.states).toMatchObject([{ id: 'state-todo', count: 3 }]);
    const second = await store.loadMore(query);
    expect(second.tickets).toHaveLength(3);
    expect(store.list({ filter: ['STATE:TODO'], limit: 2, includeFacets: true }).tickets).toHaveLength(3);
    store.destroy();
  });

  it('backs off feed polling after failures and resets to pollMs after a successful poll', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const timers = timerRig();
    let feedCalls = 0;
    const originalFeed = api.feed;
    api.feed = async (since, options) => {
      feedCalls += 1;
      if (feedCalls === 1) throw new Error('temporarily unavailable');
      return originalFeed(since, options);
    };
    const store = createTrackerStore(api, { pollMs: 10, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    await store.loadTicket('TAB-1');
    const unwatch = store.watchTicket('TAB-1', () => undefined);
    expect(timers.fireNext()).toBe(10);
    await flushMicrotasks();
    expect(feedCalls).toBe(1);
    expect([...timers.tasks.values()].map((task) => task.delay)).toEqual([20]);
    expect(timers.fireNext()).toBe(20);
    await flushMicrotasks();
    expect(feedCalls).toBe(2);
    expect([...timers.tasks.values()].map((task) => task.delay)).toEqual([10]);
    unwatch();
    store.destroy();
  });

  it('rejects create immediately offline and replays an existing-ticket edit after reconnect', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    let online = false;
    const store = createTrackerStore(api, { isOnline: () => online });
    await store.loadList();
    await expect(store.createTicket({ title: 'Offline create' })).rejects.toMatchObject({ code: 'offline' });
    expect((await api.listTickets()).tickets).toHaveLength(1);

    const optimistic = await store.updateTicket('TAB-1', { title: 'Queued offline edit' });
    expect(optimistic.title).toBe('Queued offline edit');
    expect(store.ticket('TAB-1')).toMatchObject({ offlineQueued: true, pending: true });
    online = true;
    await store.replayOfflineQueue();
    expect((await api.getTicket('TAB-1')).ticket.title).toBe('Queued offline edit');
    expect(store.ticket('TAB-1')).toMatchObject({ offlineQueued: false, pending: false });
    store.destroy();
  });

  it('applies bulk edits optimistically and undoes them with the current sequence', async () => {
    const second = ticket({ id: 'ticket-2', key: 'TAB-2', title: 'Second ticket', updatedSeq: 4 });
    const api = createMockTrackerApi({ tickets: [ticket(), second] });
    const store = createTrackerStore(api);
    await store.loadList();
    const batch = await store.bulk(['TAB-1', 'TAB-2'], { priority: 'high' });
    expect(store.ticket('TAB-1').ticket?.priority).toBe('high');
    expect(store.ticket('TAB-2').ticket?.priority).toBe('high');
    const undone = await store.undo(batch);
    expect(undone.results.every((result) => result.ok)).toBe(true);
    expect((await api.getTicket('TAB-1')).ticket.priority).toBe('none');
    expect((await api.getTicket('TAB-2')).ticket.priority).toBe('none');
    store.destroy();
  });

  it('honors meta and server read-only responses and disables later writers', async () => {
    const writableMeta = await createMockTrackerApi().meta();
    const readonlyMeta = { ...writableMeta, me: { userId: 'user-me', canWrite: false } };
    const api = createMockTrackerApi({ meta: readonlyMeta, tickets: [ticket()] });
    const store = createTrackerStore(api);
    await store.loadMeta();
    await store.loadList();
    await expect(store.updateTicket('TAB-1', { title: 'Denied' })).rejects.toMatchObject({ code: 'read_only' });
    expect(store.snapshot().readOnly).toBe(true);
    store.destroy();

    const writableApi = createMockTrackerApi({ tickets: [ticket()] });
    const serverLocked = createTrackerStore(writableApi);
    await serverLocked.loadList();
    writableApi.patchTicket = async () => { throw new TrackerError('read_only', 'Workspace locked'); };
    await expect(serverLocked.updateTicket('TAB-1', { title: 'Denied' })).rejects.toMatchObject({ code: 'read_only' });
    expect(serverLocked.snapshot().readOnly).toBe(true);
    serverLocked.destroy();
  });
});
