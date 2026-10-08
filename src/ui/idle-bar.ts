import type { Id } from '../types';

/**
 * What the idle session bar hides for one person on one board: the Session ready group, and the
 * results of one closed poll by id, so a newer poll shows again. Kept in this browser only.
 */
export interface IdleHidden {
  session: boolean;
  poll: Id | null;
}

/** The idle groups on screen. A dot results group is not hidable and is not part of this. */
export interface IdleShown {
  session: boolean;
  poll: boolean;
}

export const NOTHING_HIDDEN: IdleHidden = { session: false, poll: null };

export const idleHiddenKey = (userId: string, boardId: string) => `driftboard:idle-bar:${userId}:${boardId}`;

/** Reads what was stored. Anything unreadable hides nothing. */
export function parseIdleHidden(raw: string | null): IdleHidden {
  if (!raw) return NOTHING_HIDDEN;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return NOTHING_HIDDEN;
    const { session, poll } = v as Record<string, unknown>;
    return { session: session === true, poll: typeof poll === 'string' && poll ? poll : null };
  } catch {
    return NOTHING_HIDDEN;
  }
}

/** The groups that show: Session ready when the board has steps, poll results when a closed poll is not hidden. */
export function idleShown(hidden: IdleHidden, board: { hasSteps: boolean; latestClosedId: Id | null }): IdleShown {
  return {
    session: board.hasSteps && !hidden.session,
    poll: board.latestClosedId !== null && board.latestClosedId !== hidden.poll,
  };
}

/** Hides every group that is on screen. Esc uses this, so a group hides only if it was showing. */
export function hideShown(hidden: IdleHidden, shown: IdleShown, latestClosedId: Id | null): IdleHidden {
  return {
    session: hidden.session || shown.session,
    poll: shown.poll && latestClosedId ? latestClosedId : hidden.poll,
  };
}

export const hideSession = (h: IdleHidden): IdleHidden => ({ ...h, session: true });
export const showSession = (h: IdleHidden): IdleHidden => ({ ...h, session: false });
export const hidePoll = (h: IdleHidden, pollId: Id): IdleHidden => ({ ...h, poll: pollId });
export const showPoll = (h: IdleHidden): IdleHidden => ({ ...h, poll: null });

/** Storage can be blocked or full. Then nothing is hidden, and nothing is saved. */
export function loadIdleHidden(userId: string, boardId: string): IdleHidden {
  try {
    return parseIdleHidden(localStorage.getItem(idleHiddenKey(userId, boardId)));
  } catch {
    return NOTHING_HIDDEN;
  }
}

export function saveIdleHidden(userId: string, boardId: string, hidden: IdleHidden): void {
  try {
    const key = idleHiddenKey(userId, boardId);
    if (hidden.session || hidden.poll) localStorage.setItem(key, JSON.stringify(hidden));
    else localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
}

/** Opening the steps, adding a session template or starting a session shows Session ready again. */
export function reopenSession(userId: string, boardId: string): void {
  saveIdleHidden(userId, boardId, showSession(loadIdleHidden(userId, boardId)));
}

/** Starting a poll or using the poll tool shows the latest poll's results again. */
export function reopenPollResults(userId: string, boardId: string): void {
  saveIdleHidden(userId, boardId, showPoll(loadIdleHidden(userId, boardId)));
}
