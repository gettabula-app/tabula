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
  // seconds until `n` more hits fit: the oldest hits are the ones that expire first; when even an empty window cannot take n
  // (n above max), the wait is the whole window, and the caller's refusal stands
  const waitFor = (list, t, n) => {
    const needed = list.length + n - max;
    if (needed <= 0) return 0;
    const expiring = list[Math.min(needed, list.length) - 1];
    return expiring === undefined ? Math.ceil(windowMs / 1000) : retryAfter([expiring], t);
  };
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
  const hitMany = (key, n) => {
    const t = now();
    const list = recent(key, t);
    // a key in use goes to the back of the map, so the bound below forgets the key idle longest, never one that is busy
    hits.delete(key);
    const wait = waitFor(list, t, n);
    if (wait) {
      hits.set(key, list);
      tick(t);
      return wait;
    }
    hits.set(key, [...list, ...Array.from({ length: n }, () => t)]);
    tick(t);
    if (hits.size > MAX_LIMITER_KEYS) hits.delete(hits.keys().next().value);
    return 0;
  };
  return {
    pruneIdle() { return pruneIdle(now()); },
    get size() { return hits.size; },
    /** Seconds to wait until `n` more hits fit in the window, 0 when they fit. Counts nothing. */
    wait(key, n = 1) {
      const t = now();
      return waitFor(recent(key, t), t, n);
    },
    /** Hits left in the window for this key. */
    remaining(key) {
      return Math.max(0, max - recent(key, now()).length);
    },
    /** Counts one hit; returns the seconds to wait when the key was already at its limit (and then counts nothing). */
    hit: (key) => hitMany(key, 1),
    /** Counts `n` hits together, all or nothing: when they do not all fit, counts none and returns the seconds to wait. */
    hitMany,
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
