import type { Workspace } from './api';

// The notice before a server restart (docs/cloud.md, Restart). /api/me says how many seconds are left, as the server counted
// them when it answered. The page never compares server times (the clocks may be skewed): it remembers when the answer
// arrived on its own clock and counts down from there. Pure logic: the clock and the storage are passed in.

/** The server expires a planned restart two minutes after its time. */
const EXPIRY_MS = 120_000;
const MINUTE_S = 60;
const DISMISSED_KEY = 'tabula:restart-notice-dismissed';
/** Dismissed ids kept in the session. A restart id is only ever sent while its restart is planned, so the cap is generous. */
const MAX_DISMISSED = 50;
const MAX_ID_LENGTH = 200;

/** The part of Storage this module uses. sessionStorage fits; so does a test double. */
export interface RestartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RestartView {
  id: string;
  /** One of two fixed sentences (see restartText): the server's own text is never shown. */
  text: string;
}

export interface RestartNotice {
  /** Each /api/me answer: the workspace of that answer, or null/undefined when there is none (signed out). */
  update(workspace: Workspace | null | undefined): void;
  /** What to show now, or null when nothing is planned, the id was dismissed, or the restart is past its expiry. */
  view(): RestartView | null;
  /** Hides the notice for this id for the rest of the session. A new id shows again. */
  dismiss(id: string): void;
}

interface Pending {
  id: string;
  secondsLeft: number;
  receivedAt: number;
}

/** The notice text for the seconds left. Whole minutes round up, so the page never says less time than the server still has. */
export function restartText(remaining: number): string {
  if (remaining >= MINUTE_S) {
    const minutes = Math.ceil(remaining / MINUTE_S);
    return `The server restarts in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Your changes are kept and the page reconnects by itself.`;
  }
  return 'The server restarts in less than a minute. Your changes are kept and the page reconnects by itself.';
}

function validRestart(restart: { secondsLeft: unknown; id: unknown }): restart is { secondsLeft: number; id: string } {
  return typeof restart.id === 'string'
    && restart.id.length > 0
    && restart.id.length <= MAX_ID_LENGTH
    && typeof restart.secondsLeft === 'number'
    && Number.isFinite(restart.secondsLeft);
}

function sessionStore(): RestartStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // some browsers throw when the page reads sessionStorage at all (blocked site data)
    return null;
  }
}

function readDismissed(storage: RestartStorage | null): string[] {
  try {
    const raw = storage?.getItem(DISMISSED_KEY) ?? null;
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(storage: RestartStorage | null, ids: string[]): void {
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // the memory copy still hides the notice for this page's life
  }
}

/**
 * `now` is the page's clock in milliseconds. `storage` keeps dismissed ids for the session; leave it out for sessionStorage,
 * pass null for memory only. Every storage access is guarded, and the in-memory set always holds the dismissals too.
 */
export function createRestartNotice(options: { now?: () => number; storage?: RestartStorage | null } = {}): RestartNotice {
  const now = options.now ?? (() => Date.now());
  const storage = options.storage === undefined ? sessionStore() : options.storage;
  const dismissed = new Set<string>(readDismissed(storage));
  let pending: Pending | null = null;

  return {
    update(workspace) {
      const restart = workspace?.restart;
      if (!restart || !validRestart(restart)) {
        pending = null;
        return;
      }
      // a repeated answer with the same id re-bases the countdown on this answer too
      pending = { id: restart.id, secondsLeft: Math.max(0, restart.secondsLeft), receivedAt: now() };
    },
    view() {
      if (!pending) return null;
      const at = now();
      const elapsedMs = Math.max(0, at - pending.receivedAt);
      // the server's restart time is receipt + secondsLeft; the notice ends two minutes after it
      if (elapsedMs - pending.secondsLeft * 1000 > EXPIRY_MS) return null;
      if (dismissed.has(pending.id)) return null;
      const remaining = Math.max(0, pending.secondsLeft - elapsedMs / 1000);
      return { id: pending.id, text: restartText(remaining) };
    },
    dismiss(id) {
      dismissed.add(id);
      writeDismissed(storage, [...dismissed].slice(-MAX_DISMISSED));
    },
  };
}
