// What the notifications bell shows (proto/designer-preview/notifications/SPEC.md; server: .manager/design-notifications.md): the
// counts for the badge, and the list the panel draws. Rows read here are read for good (the chat and the tracker read the same
// rows), reading is optimistic and rolled back when it fails, and a row never moves under the cursor: rows that arrive while the
// panel is open wait behind a "Show N new" line.
import {
  applyRead, countOf, matchesFilter, parseCounts, parsePage,
  type NotificationCounts, type NotificationFilter, type NotificationItem, type NotificationPage,
} from './ui/notifications-logic';

export const POLL_MS = 60_000;
/** Rows kept in a list: the server pages by 50 and the panel shows no more than this. */
export const MAX_ROWS = 50;

export interface NotificationsApi {
  page(before?: string | null): Promise<unknown>;
  counts(): Promise<unknown>;
  read(body: { ids: string[] } | { all: true }): Promise<unknown>;
}

export interface ListState {
  /** `idle` before the first load; `error` only while there is nothing to show (a failed refresh keeps the list and sets `failed`). */
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: NotificationItem[];
  nextCursor: string | null;
  /** A refresh failed after a first success: the list stays, with a slim error line. */
  failed: boolean;
  /** New rows that arrived while the panel was open; shown on request. */
  pending: NotificationItem[];
  /** The list was loaded before something changed and is fetched again when the panel next opens. */
  stale: boolean;
}

export interface NotificationsState {
  counts: NotificationCounts;
  /** Which chip is on. The server has one list; Mentions is the same list narrowed to chat mentions (`matchesFilter`). */
  filter: NotificationFilter;
  open: boolean;
  list: ListState;
}

interface Deps {
  api: NotificationsApi;
  /** Told when a read could not be saved (the dots return). */
  onReadFailed?: () => void;
  hidden?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const emptyList = (): ListState => ({ status: 'idle', items: [], nextCursor: null, failed: false, pending: [], stale: false });

export function createNotificationsStore(deps: Deps) {
  const { api } = deps;
  const hidden = deps.hidden ?? (() => typeof document !== 'undefined' && document.hidden);
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const state: NotificationsState = { counts: { unread: 0, unreadMentions: 0 }, filter: 'all', open: false, list: emptyList() };
  const listeners = new Set<() => void>();
  const emit = () => { for (const fn of Array.from(listeners)) fn(); };
  /** Bumped by every list change so a late answer for an older request is ignored. */
  let seq = 0;
  let timer: unknown;

  const stopTimer = () => { if (timer !== undefined) { clearTimer(timer); timer = undefined; } };

  async function load(mode: 'first' | 'refresh' | 'more') {
    const list = state.list;
    const mine = ++seq;
    if (mode === 'first') { list.status = 'loading'; list.failed = false; }
    emit();
    let page: NotificationPage;
    try {
      page = parsePage(await api.page(mode === 'more' ? list.nextCursor : null));
    } catch {
      if (mine !== seq) return;
      if (list.status === 'ready') list.failed = true;
      else list.status = 'error';
      emit();
      return;
    }
    if (mine !== seq) return;
    state.counts = page.counts;
    list.failed = false;
    list.stale = false;
    if (mode === 'more') {
      const have = new Set(list.items.map((i) => i.id));
      list.items = [...list.items, ...page.items.filter((i) => !have.has(i.id))].slice(0, MAX_ROWS * 4);
      list.nextCursor = page.nextCursor;
    } else if (mode === 'refresh' && list.status === 'ready') {
      // the rows already on screen stay where they are (read state may change); new ones wait behind "Show N new"
      const have = new Map(list.items.map((i) => [i.id, i]));
      const fresh = page.items.filter((i) => !have.has(i.id));
      list.items = list.items.map((i) => ({ ...i, read: page.items.find((p) => p.id === i.id)?.read ?? i.read }));
      const held = new Set(list.pending.map((i) => i.id));
      list.pending = [...fresh.filter((i) => !held.has(i.id)), ...list.pending].sort((a, b) => b.at - a.at);
    } else {
      list.items = page.items;
      list.nextCursor = page.nextCursor;
      list.pending = [];
    }
    list.status = 'ready';
    emit();
  }

  async function refreshCounts() {
    try {
      const counts = parseCounts(await api.counts());
      state.counts = counts;
      emit();
    } catch {
      // the badge keeps its last value
    }
  }

  /** The bell's number changed on the server (a `notify` frame, a poll): the badge follows, and an open list takes in what is new. */
  function changed(counts?: NotificationCounts) {
    if (counts) state.counts = counts;
    const list = state.list;
    if (list.status === 'ready') {
      if (state.open) void load('refresh');
      else list.stale = true;
    }
    if (!counts) void refreshCounts();
    emit();
  }

  /** Saves a read, optimistically; puts everything back and says so when it cannot be saved. */
  async function save(ids: Set<string> | 'all') {
    const before = { counts: { ...state.counts }, items: state.list.items };
    const readNow = before.items.filter((i) => !i.read && (ids === 'all' || ids.has(i.id)));
    state.list.items = applyRead(before.items, ids);
    state.counts = ids === 'all'
      ? { unread: 0, unreadMentions: 0 }
      : {
        unread: Math.max(0, state.counts.unread - readNow.length),
        unreadMentions: Math.max(0, state.counts.unreadMentions - readNow.filter((i) => matchesFilter(i, 'mentions')).length),
      };
    emit();
    try {
      const body = ids === 'all' ? { all: true as const } : { ids: [...ids].slice(0, 100) };
      state.counts = parseCounts(await api.read(body));
      emit();
    } catch {
      state.list.items = before.items;
      state.counts = before.counts;
      emit();
      deps.onReadFailed?.();
    }
  }

  return {
    state: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** The panel opened or closed. Opening loads the list (or fetches it again when it is stale). */
    setOpen(open: boolean) {
      state.open = open;
      if (open) {
        const list = state.list;
        if (list.status === 'idle' || list.status === 'error') void load('first');
        else if (list.stale) void load('refresh');
      }
      emit();
    },
    setFilter(filter: NotificationFilter) {
      state.filter = filter;
      emit();
    },
    retry() { void load('first'); },
    loadMore() { if (state.list.nextCursor) void load('more'); },
    /** "Show N new". */
    showNew() {
      const list = state.list;
      if (!list.pending.length) return;
      list.items = [...list.pending, ...list.items];
      list.pending = [];
      emit();
    },
    markRead: (ids: string[]) => save(new Set(ids)),
    markAllRead: () => save('all'),
    /** The server says the numbers changed (a `notify` frame). */
    notified: (counts?: NotificationCounts) => changed(counts),
    refreshCounts,
    /** The first value, and the poll that stands in for the socket where there is none. */
    start(options: { poll: boolean }) {
      void refreshCounts();
      stopTimer();
      if (options.poll) timer = setTimer(() => { if (!hidden()) void refreshCounts().then(() => changed(state.counts)); }, POLL_MS);
    },
    stop() { stopTimer(); },
    countsOf: () => countOf(state.list.items),
  };
}

export type NotificationsStore = ReturnType<typeof createNotificationsStore>;
