const WINDOW_MS = 60_000;
const IDLE_WINDOWS = 2;
const PRUNE_AFTER_KEYS = 1000;
const PRUNE_EVERY = 1000;
const MAX_LIMITER_KEYS = 50_000;

export const TICKET_CREATES_PER_WINDOW = 10;

/** Sliding-window limiter shared by MCP and tracker writers. */
export function createWindowLimiter(max, now = Date.now) {
  const hits = new Map();
  let operations = 0;

  function pruneIdle(instant) {
    let removed = 0;
    for (const [key, entry] of hits) {
      if (instant < entry.lastSeen || instant - entry.lastSeen > IDLE_WINDOWS * WINDOW_MS) {
        hits.delete(key);
        removed++;
      }
    }
    return removed;
  }

  return {
    /** Counts one hit; returns the seconds to wait when the key was already at its limit. */
    hit(key) {
      const instant = now();
      const entry = hits.get(key);
      const live = (entry?.stamps ?? []).filter((stamp) => stamp > instant - WINDOW_MS);
      hits.delete(key);
      if (live.length >= max) {
        hits.set(key, { stamps: live, lastSeen: instant });
        operations++;
        if (hits.size > PRUNE_AFTER_KEYS && operations % PRUNE_EVERY === 0) pruneIdle(instant);
        return Math.max(1, Math.ceil((live[0] + WINDOW_MS - instant) / 1000));
      }
      hits.set(key, { stamps: [...live, instant], lastSeen: instant });
      operations++;
      if (hits.size > PRUNE_AFTER_KEYS && operations % PRUNE_EVERY === 0) pruneIdle(instant);
      if (hits.size > MAX_LIMITER_KEYS) hits.delete(hits.keys().next().value);
      return 0;
    },
    pruneIdle() { return pruneIdle(now()); },
    get size() { return hits.size; },
  };
}
