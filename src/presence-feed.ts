// The live feed of "Here now" for the Boards page (server side: .manager/design-boards-presence.md). Over the chat socket when
// chat is on (`presence.snapshot` after a connect, `presence.update` per changed board, `presence.clear` when nobody is left),
// else `GET /api/boards/presence` every POLL_MS while the page is visible. Either way the first value is fetched once.
import type { PresenceSource, PresenceStore } from './presence';
import type { PresenceSummary, PresenceUser } from './ui/presence-logic';

export const POLL_MS = 15_000;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function parseUser(x: unknown): PresenceUser | null {
  if (!isObject(x) || typeof x.userId !== 'string' || !x.userId) return null;
  return {
    userId: x.userId,
    name: typeof x.name === 'string' ? x.name : '',
    colour: typeof x.colour === 'string' ? x.colour : null,
    joinedAt: typeof x.joinedAt === 'number' && Number.isFinite(x.joinedAt) ? x.joinedAt : 0,
    ...(x.guest === true ? { guest: true } : {}),
  };
}

/** A summary from the server, or null when it is not one. Only what the row draws is kept. */
export function parseSummary(x: unknown): PresenceSummary | null {
  if (!isObject(x) || typeof x.boardId !== 'string' || !x.boardId) return null;
  const people = (Array.isArray(x.people) ? x.people : []).map(parseUser).filter((u): u is PresenceUser => u !== null).slice(0, 8);
  const count = typeof x.count === 'number' && Number.isFinite(x.count) ? Math.max(0, Math.floor(x.count)) : people.length;
  return { boardId: x.boardId, count, people, ...(x.me === true ? { me: true } : {}) };
}

export function parseList(list: unknown): PresenceSummary[] {
  return (Array.isArray(list) ? list : []).map(parseSummary).filter((s): s is PresenceSummary => s !== null);
}

/** Applies one socket frame to the store; false when it is not a presence frame it understands. */
export function applyPresenceFrame(store: Pick<PresenceStore, 'set' | 'replaceAll'>, f: Record<string, unknown>): boolean {
  if (f.t === 'presence.snapshot') {
    store.replaceAll(parseList(f.boards ?? f.presence));
    return true;
  }
  if (f.t === 'presence.update') {
    const summary = parseSummary(f.board ?? f.presence ?? f);
    if (!summary) return false;
    store.set(summary.boardId, summary.count > 0 || summary.people.length > 0 ? summary : null);
    return true;
  }
  if (f.t === 'presence.clear') {
    const id = typeof f.boardId === 'string' ? f.boardId : '';
    if (!id) return false;
    store.set(id, null);
    return true;
  }
  return false;
}

export interface FeedDeps {
  store: Pick<PresenceStore, 'set' | 'replaceAll'>;
  /** The page is still showing the Boards list; false stops the feed. */
  alive: () => boolean;
  /** Chat is on: the socket carries the changes, and `onFrame` hands them over. */
  chatOn: boolean;
  onFrame: (fn: (f: Record<string, unknown>) => void) => () => void;
  /** Keeps the chat socket up while the page is open (no-op without chat). */
  keepSocket?: (signal: AbortSignal) => void;
  fetchList: () => Promise<unknown[]>;
  pollMs?: number;
  hidden?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** A source for `store.connect`. The first value is fetched once; changes come by socket or by a visible-page poll. */
export function createPresenceFeed(deps: FeedDeps): PresenceSource {
  const hidden = deps.hidden ?? (() => typeof document !== 'undefined' && document.hidden);
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  return {
    subscribe() {
      const life = new AbortController();
      let timer: unknown;
      let offFrame: (() => void) | undefined;
      const pull = async () => {
        if (life.signal.aborted) return;
        if (!deps.alive()) { stop(); return; }
        try {
          const list = await deps.fetchList();
          if (!life.signal.aborted) deps.store.replaceAll(parseList(list));
        } catch {
          // an endpoint that is not there, or a dropped connection: the rows keep what they have
        }
      };
      const stop = () => {
        life.abort();
        if (timer !== undefined) clearTimer(timer);
        offFrame?.();
      };
      void pull();
      if (deps.chatOn) {
        deps.keepSocket?.(life.signal);
        offFrame = deps.onFrame((f) => {
          if (!deps.alive()) { stop(); return; }
          applyPresenceFrame(deps.store, f);
        });
      } else {
        timer = setTimer(() => { if (!hidden()) void pull(); }, deps.pollMs ?? POLL_MS);
      }
      return stop;
    },
  };
}
