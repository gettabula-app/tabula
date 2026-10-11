const WINDOW_MS = 60_000;

export const TRACKER_SOCKET_GUARD_ENTRIES_PER_WINDOW = 1200;

/** O(1) per-socket guard-entry budget, checked before the room snapshot. */
export function createTrackerSocketBudget({
  now = Date.now,
  max = TRACKER_SOCKET_GUARD_ENTRIES_PER_WINDOW,
} = {}) {
  const windows = new WeakMap();

  return {
    allow(socket) {
      const instant = now();
      const current = windows.get(socket);
      if (!current || instant < current.startedAt || instant - current.startedAt >= WINDOW_MS) {
        windows.set(socket, { startedAt: instant, count: 1 });
        return true;
      }
      if (current.count >= max) return false;
      current.count++;
      return true;
    },
  };
}
