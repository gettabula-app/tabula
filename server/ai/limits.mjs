// In-memory limits of the AI layer (docs/ai.md, "Limits"). Everything here lives in the process: a restart forgets every
// count and every run in flight. Keys are opaque strings made by the caller (a person, a client address, the workspace);
// nothing here ever sees a provider key or board text.

const HOUR_MS = 60 * 60 * 1000;
const MAX_KEYS = 50_000;

/**
 * A sliding window counter per key. `check` says how long to wait (0 when there is room), `record` counts one use and
 * `undo` takes the newest one back. A key with no recent use is forgotten, and the map is bounded.
 * @param {{ windowMs?: number, now?: () => number }} [options]
 */
export function createWindowCounter({ windowMs = HOUR_MS, now = Date.now } = {}) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  function recent(key, t) {
    const list = (hits.get(key) ?? []).filter((ts) => ts > t - windowMs);
    // a key in use goes to the back of the map, so the bound in record forgets the key idle longest
    hits.delete(key);
    if (list.length > 0) hits.set(key, list);
    return list;
  }

  return {
    /** Seconds until `key` may use another one, or 0 when fewer than `max` uses are inside the window. */
    check(key, max) {
      const t = now();
      const list = recent(key, t);
      return list.length < max ? 0 : Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
    },
    record(key) {
      const t = now();
      const list = recent(key, t);
      hits.delete(key);
      hits.set(key, [...list, t]);
      if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value);
    },
    undo(key) {
      const list = hits.get(key);
      if (!list) return;
      list.pop();
      if (list.length === 0) hits.delete(key);
    },
  };
}

/**
 * Runs in flight per key. A key is busy once it holds `max` runs (1 unless `caps` says more). `take` is all or nothing
 * and returns a release function (safe to call twice), or null when any key is busy.
 * @param {Record<string, number>} [caps] runs allowed at once for a key; every other key allows one
 */
export function createRunGate(caps = {}) {
  const held = new Map();
  const max = (key) => caps[key] ?? 1;
  const busy = (key) => (held.get(key) ?? 0) >= max(key);
  return {
    busy,
    take(keys) {
      if (keys.some(busy)) return null;
      for (const k of keys) held.set(k, (held.get(k) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const k of keys) {
          const n = (held.get(k) ?? 1) - 1;
          if (n > 0) held.set(k, n);
          else held.delete(k);
        }
      };
    },
  };
}

export const SAVE_LIMIT_PER_HOUR = 10;

/**
 * Each key save or test makes an outbound verify call, so a person gets a few an hour and one at a time. `begin` returns a
 * `{ wait }` (seconds, when refused) or a `{ done }` to call when the check has finished.
 * @param {{ now?: () => number, perHour?: number }} [options]
 */
export function createSaveThrottle({ now = Date.now, perHour = SAVE_LIMIT_PER_HOUR } = {}) {
  const counter = createWindowCounter({ now });
  const gate = createRunGate();
  return {
    begin(userId) {
      const key = String(userId);
      if (gate.busy(key)) return { wait: 5 };
      const wait = counter.check(key, perHour);
      if (wait) return { wait };
      counter.record(key);
      const release = gate.take([key]);
      return { done: release ?? (() => {}) };
    },
  };
}
