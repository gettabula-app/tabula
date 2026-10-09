// Rate limits of chat (docs/chat.md, "Limits"): the writes, and the reads that are not a page of messages. Sliding windows in memory, modelled on the MCP limiter in
// mcp.mjs: a request over any of its limits is refused and counts against none of them.

const MINUTE_MS = 60_000;
const MAX_KEYS = 50_000;
const SWEEP_MS = 60_000;

export const CHAT_LIMITS = Object.freeze({
  postPerChannel: { max: 20, windowMs: MINUTE_MS },
  postOverall: { max: 60, windowMs: MINUTE_MS },
  // "burst of 5": at most five sends in any two seconds, across channels (the minute windows set the steady rate)
  postBurst: { max: 5, windowMs: 2_000 },
  change: { max: 20, windowMs: MINUTE_MS },
  // the reads around a conversation: a channel's metadata is asked for once per opening of the tab, the unread summary
  // once per opening and page, a read marker at most every two seconds per tab (src/chat.ts); 60 a minute leaves room for
  // the headless visual check, which opens chat that often as one person
  channelInfo: { max: 60, windowMs: MINUTE_MS },
  unread: { max: 60, windowMs: MINUTE_MS },
  read: { max: 60, windowMs: MINUTE_MS },
});

/** One sliding window per key. `wait(key)` is 0 when a hit fits, else the seconds until it would. */
export function createWindow({ max, windowMs }, now = Date.now) {
  const hits = new Map();
  let lastSweep = 0;
  const recent = (key, t) => (hits.get(key) ?? []).filter((ts) => ts > t - windowMs);

  function sweep(t) {
    if (t - lastSweep < SWEEP_MS) return;
    lastSweep = t;
    for (const [key, list] of hits) if (!list.some((ts) => ts > t - windowMs)) hits.delete(key);
  }

  return {
    wait(key) {
      const t = now();
      const list = recent(key, t);
      return list.length >= max ? Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) : 0;
    },
    record(key) {
      const t = now();
      sweep(t);
      hits.set(key, [...recent(key, t), t]);
      if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value);
    },
  };
}

/** Checks every [window, key] pair first and records them all only when each one fits. Returns the seconds to wait, or 0. */
function hitAll(pairs) {
  const wait = Math.max(0, ...pairs.map(([w, key]) => w.wait(key)));
  if (wait === 0) for (const [w, key] of pairs) w.record(key);
  return wait;
}

/**
 * The limiters the chat routes use. Each method counts one request and answers 0, or the seconds the caller must wait
 * (then nothing was counted).
 * @param {{ now?: () => number, limits?: typeof CHAT_LIMITS }} [options]
 */
export function createChatLimits({ now = Date.now, limits = CHAT_LIMITS } = {}) {
  const perChannel = createWindow(limits.postPerChannel, now);
  const overall = createWindow(limits.postOverall, now);
  const burst = createWindow(limits.postBurst, now);
  const change = createWindow(limits.change, now);
  const channelInfo = createWindow(limits.channelInfo, now);
  const unread = createWindow(limits.unread, now);
  const read = createWindow(limits.read, now);
  return {
    /** A new message from `userId` in the channel `channel` ("kind/ref"). */
    post: (userId, channel) => hitAll([[perChannel, `${userId} ${channel}`], [overall, userId], [burst, userId]]),
    /** An edit or a delete by `userId`. */
    change: (userId) => hitAll([[change, userId]]),
    /** GET of a channel's metadata (access and people) by `userId`. */
    channelInfo: (userId) => hitAll([[channelInfo, userId]]),
    /** GET of the unread summary by `userId`. */
    unread: (userId) => hitAll([[unread, userId]]),
    /** PUT of a read marker by `userId`, in any channel. */
    read: (userId) => hitAll([[read, userId]]),
  };
}
