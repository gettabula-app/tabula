/** Sliding-window limiter: at most `limit` hits per `windowMs` for each key. Memory is bounded by pruning idle keys. */
export function createLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  const hits = new Map();
  return {
    /** @returns {{ ok: boolean, retryAfterMs: number }} */
    hit(key, now = Date.now()) {
      let list = hits.get(key);
      if (!list) {
        if (hits.size >= maxKeys) {
          for (const [k, v] of hits) {
            if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
            if (hits.size < maxKeys) break;
          }
        }
        list = [];
        hits.set(key, list);
      }
      while (list.length && now - list[0] >= windowMs) list.shift();
      if (list.length >= limit) return { ok: false, retryAfterMs: windowMs - (now - list[0]) };
      list.push(now);
      return { ok: true, retryAfterMs: 0 };
    },
  };
}
