// In-memory sliding-window limits shared by HTTP endpoints. OAuth limits include the
// public client id so connectors behind one provider IP do not share a bucket.
const WINDOW_MS = 60_000;
const MAX_LIMITER_KEYS = 50_000;
const IDLE_WINDOWS = 2;
const PRUNE_AFTER_KEYS = 1000;
const PRUNE_EVERY = 1000;

/** MCP's budget for ticket creation by an agent, per token and window. */
export const TICKET_CREATES_PER_WINDOW = 10;

// Sliding window per key (modelled on the sign-in limiter in auth.mjs).
export function createWindowLimiter(max, now = Date.now, windowMs = WINDOW_MS) {
  const hits = new Map();
  let operations = 0;
  const recent = (key, t) => (hits.get(key) ?? []).filter((ts) => ts > t - windowMs);
  const retryAfter = (list, t) => Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
  // keys idle for more than two windows are forgotten, on a cheap amortized schedule, so the map follows the active users
  function pruneIdle(t) {
    let removed = 0;
    for (const [key, list] of hits) {
      const last = list[list.length - 1];
      if (last === undefined || t < last || t - last > IDLE_WINDOWS * windowMs) {
        hits.delete(key);
        removed++;
      }
    }
    return removed;
  }
  const tick = (t) => {
    operations++;
    if (hits.size > PRUNE_AFTER_KEYS && operations % PRUNE_EVERY === 0) pruneIdle(t);
  };
  return {
    pruneIdle() { return pruneIdle(now()); },
    get size() { return hits.size; },
    wait(key) {
      const t = now();
      const list = recent(key, t);
      return list.length >= max ? retryAfter(list, t) : 0;
    },
    /** Counts one hit; returns the seconds to wait when the key was already at its limit (and then counts nothing). */
    hit(key) {
      const t = now();
      const list = recent(key, t);
      // a key in use goes to the back of the map, so the bound below forgets the key idle longest, never one that is busy
      hits.delete(key);
      if (list.length >= max) {
        hits.set(key, list);
        tick(t);
        return retryAfter(list, t);
      }
      hits.set(key, [...list, t]);
      tick(t);
      if (hits.size > MAX_LIMITER_KEYS) hits.delete(hits.keys().next().value);
      return 0;
    },
  };
}

export const clientAwareLimitKey = (ip, clientId) => JSON.stringify([
  String(ip || 'unknown').slice(0, 128),
  typeof clientId === 'string' ? clientId.slice(0, 128) : '',
]);

export function createClientAwareLimiter(max, now = Date.now, windowMs = WINDOW_MS) {
  const limiter = createWindowLimiter(max, now, windowMs);
  return {
    wait(ip, clientId) {
      return limiter.wait(clientId ? clientAwareLimitKey(ip, clientId) : `ip:${String(ip || 'unknown').slice(0, 128)}`);
    },
    hit(ip, clientId) {
      return limiter.hit(clientId ? clientAwareLimitKey(ip, clientId) : `ip:${String(ip || 'unknown').slice(0, 128)}`);
    },
  };
}
