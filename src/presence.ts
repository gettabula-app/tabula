// Who is on which board right now, for the Boards page (proto/designer-preview/presence/SPEC.md, Behaviour; the server side is
// .manager/design-boards-presence.md). The live data comes from a source injected by the page; this holds what the rows draw from:
// - a summary that grows shows at once; one that shrinks (a person left) is shown as it was for LEAVE_MS, then the latest
//   one replaces it, so a reload or a brief reconnect does not flicker;
// - while the page is hidden, summaries wait and the latest per board is applied together when it is visible again;
// - a snapshot replaces everything (after a reconnect), a clear removes one board.
import type { PresenceSummary } from './ui/presence-logic';

export const LEAVE_MS = 3000;

/** Pushes each board's summary when it changes (`null`: nobody else is there now). Returns what to call to stop. */
export interface PresenceSource {
  subscribe(push: (boardId: string, summary: PresenceSummary | null) => void): () => void;
}

interface Deps {
  leaveMs?: number;
  hidden?: () => boolean;
  /** Called with `apply` when the page becomes visible; returns the unsubscribe. */
  onVisible?: (apply: () => void) => () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface BoardState {
  shown: PresenceSummary | null;
  /** The latest summary that arrived while a shrink was being held back. */
  next: PresenceSummary | null;
  timer: unknown;
}

const sizeOf = (s: PresenceSummary | null) => (s ? Math.max(s.count, s.people.length) : 0);

export function createPresenceStore(deps: Deps = {}) {
  const leaveMs = deps.leaveMs ?? LEAVE_MS;
  const hidden = deps.hidden ?? (() => typeof document !== 'undefined' && document.hidden);
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const boards = new Map<string, BoardState>();
  const watchers = new Map<string, Set<() => void>>();
  /** The latest summary per board that arrived while hidden. */
  const held = new Map<string, PresenceSummary | null>();
  let offVisible: (() => void) | null = null;

  const stateOf = (id: string): BoardState => {
    let s = boards.get(id);
    if (!s) boards.set(id, (s = { shown: null, next: null, timer: undefined }));
    return s;
  };
  const notify = (id: string) => { for (const cb of Array.from(watchers.get(id) ?? [])) cb(); };
  const same = (a: PresenceSummary | null, b: PresenceSummary | null) => JSON.stringify(a) === JSON.stringify(b);

  function apply(id: string, summary: PresenceSummary | null) {
    const s = stateOf(id);
    if (sizeOf(summary) >= sizeOf(s.shown)) {
      // nobody left (or someone arrived): show it now and forget a pending shrink
      if (s.timer !== undefined) { clearTimer(s.timer); s.timer = undefined; }
      s.next = null;
      if (same(s.shown, summary)) return;
      s.shown = summary;
      notify(id);
      return;
    }
    s.next = summary;
    if (s.timer !== undefined) return;
    s.timer = setTimer(() => {
      s.timer = undefined;
      s.shown = s.next;
      s.next = null;
      notify(id);
    }, leaveMs);
  }

  function set(id: string, summary: PresenceSummary | null) {
    if (hidden()) { held.set(id, summary); return; }
    apply(id, summary);
  }

  function catchUp() {
    if (hidden()) return;
    const waiting = Array.from(held);
    held.clear();
    for (const [id, summary] of waiting) apply(id, summary);
  }

  function stopTimers() {
    for (const s of boards.values()) {
      if (s.timer !== undefined) clearTimer(s.timer);
      s.timer = undefined;
      s.next = null;
    }
  }

  return {
    /** What a board's row draws now. */
    get(id: string): PresenceSummary | null {
      return boards.get(id)?.shown ?? null;
    },
    set,
    /** A full list after a (re)connect: boards it does not mention have nobody else on them. */
    replaceAll(list: readonly PresenceSummary[]) {
      const ids = new Set(list.map((b) => b.boardId));
      for (const b of list) set(b.boardId, b);
      for (const id of boards.keys()) if (!ids.has(id)) set(id, null);
    },
    /** Redraw when `id` changes. Returns what to call to stop. */
    watch(id: string, cb: () => void): () => void {
      let set = watchers.get(id);
      if (!set) watchers.set(id, (set = new Set()));
      set.add(cb);
      return () => { set!.delete(cb); };
    },
    /** Take the live feed from `source` until the returned function is called. Pauses with the page. */
    connect(source: PresenceSource): () => void {
      offVisible ??= deps.onVisible?.(catchUp) ?? (typeof document !== 'undefined'
        ? (() => { document.addEventListener('visibilitychange', catchUp); return () => document.removeEventListener('visibilitychange', catchUp); })()
        : null);
      const stop = source.subscribe(set);
      return () => {
        stop();
        offVisible?.();
        offVisible = null;
        held.clear();
        stopTimers();
      };
    },
    /** Forget everything (leaving the page). */
    reset() {
      stopTimers();
      boards.clear();
      held.clear();
    },
  };
}

/** The store the Boards page draws from. */
export const boardsPresence = createPresenceStore();

export type PresenceStore = ReturnType<typeof createPresenceStore>;
