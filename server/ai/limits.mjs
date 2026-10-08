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
    if (list.length === 0) hits.delete(key);
    else hits.set(key, list);
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
      hits.set(key, [...recent(key, t), t]);
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

/** The set of keys that have a run in flight. `take` is all or nothing and returns a release function (safe to call twice). */
export function createRunGate() {
  const held = new Set();
  return {
    busy: (key) => held.has(key),
    take(keys) {
      if (keys.some((k) => held.has(k))) return null;
      for (const k of keys) held.add(k);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const k of keys) held.delete(k);
      };
    },
  };
}

export const SAVE_LIMIT_PER_HOUR = 10;

/**
 * Each key save makes an outbound verify call, so a person gets a few an hour and one at a time. `begin` returns a
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
