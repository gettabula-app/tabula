const WINDOW_MS = 60_000;
const PRUNE_AFTER_KEYS = 1000;

export const TRACKER_SOCKET_GUARD_ENTRIES_PER_WINDOW = 1200;

/**
 * O(1) guard-entry budget per key (user and board), checked before the room snapshot. Keyed by person and board rather than
 * by socket, so a runaway client that reconnects is still cut until its minute is over.
 */
export function createTrackerSocketBudget({
  now = Date.now,
  max = TRACKER_SOCKET_GUARD_ENTRIES_PER_WINDOW,
} = {}) {
  const windows = new Map();

  function prune(instant) {
    for (const [key, entry] of windows) {
      if (instant < entry.startedAt || instant - entry.startedAt >= WINDOW_MS) windows.delete(key);
    }
  }

  return {
    /** @param {string} key */
    allow(key) {
      const instant = now();
      const current = windows.get(key);
      if (!current || instant < current.startedAt || instant - current.startedAt >= WINDOW_MS) {
        if (windows.size > PRUNE_AFTER_KEYS) prune(instant);
        windows.set(key, { startedAt: instant, count: 1 });
        return true;
      }
      if (current.count >= max) return false;
      current.count++;
      return true;
    },
    get size() { return windows.size; },
  };
}
