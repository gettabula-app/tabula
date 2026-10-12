// Who is on which board right now, for the Boards page (proto/designer-preview/presence/SPEC.md, Behaviour). The source of
// the live data is injected (the server endpoint lands separately); this holds the state the rows draw from:
// - a person who arrives shows at once, one who leaves is kept for LEAVE_MS so a reload or a brief reconnect does not flicker;
// - while the page is hidden, updates wait and are applied together when it is visible again.
import type { PresenceUser } from './ui/presence-logic';

export const LEAVE_MS = 3000;

/** Pushes the full list of people on a board each time it changes. Returns what to call to stop. */
export interface PresenceSource {
  subscribe(push: (boardId: string, users: PresenceUser[]) => void): () => void;
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
  shown: Map<string, PresenceUser>;
  leaving: Map<string, unknown>;
}

export function createPresenceStore(deps: Deps = {}) {
  const leaveMs = deps.leaveMs ?? LEAVE_MS;
  const hidden = deps.hidden ?? (() => typeof document !== 'undefined' && document.hidden);
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const boards = new Map<string, BoardState>();
  const watchers = new Map<string, Set<() => void>>();
  /** The latest list per board that arrived while hidden. */
  const held = new Map<string, PresenceUser[]>();
  let offVisible: (() => void) | null = null;

  const stateOf = (id: string): BoardState => {
    let s = boards.get(id);
    if (!s) boards.set(id, (s = { shown: new Map(), leaving: new Map() }));
    return s;
  };
  const notify = (id: string) => { for (const cb of Array.from(watchers.get(id) ?? [])) cb(); };

  function apply(id: string, users: readonly PresenceUser[]) {
    const s = stateOf(id);
    const now = new Set<string>();
    for (const u of users) {
      now.add(u.userId);
      s.shown.set(u.userId, u);
      const timer = s.leaving.get(u.userId);
      if (timer !== undefined) { clearTimer(timer); s.leaving.delete(u.userId); }
    }
    for (const userId of s.shown.keys()) {
      if (now.has(userId) || s.leaving.has(userId)) continue;
      s.leaving.set(userId, setTimer(() => {
        s.leaving.delete(userId);
        s.shown.delete(userId);
        notify(id);
      }, leaveMs));
    }
    notify(id);
  }

  function catchUp() {
    if (hidden()) return;
    const waiting = [...held];
    held.clear();
    for (const [id, users] of waiting) apply(id, users);
  }

  function set(id: string, users: readonly PresenceUser[]) {
    if (hidden()) { held.set(id, [...users]); return; }
    apply(id, users);
  }

  return {
    /** What a board's row draws now. */
    get(id: string): PresenceUser[] {
      return [...(boards.get(id)?.shown.values() ?? [])];
    },
    /** The list changed (or the first value arrived). */
    set,
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
        for (const s of boards.values()) {
          for (const timer of s.leaving.values()) clearTimer(timer);
          s.leaving.clear();
        }
      };
    },
    /** Forget everything (leaving the page). */
    reset() {
      for (const s of boards.values()) for (const timer of s.leaving.values()) clearTimer(timer);
      boards.clear();
      held.clear();
    },
  };
}

/** The store the Boards page draws from. */
export const boardsPresence = createPresenceStore();

export type PresenceStore = ReturnType<typeof createPresenceStore>;
