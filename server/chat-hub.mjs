// Live chat delivery (docs/chat.md, "Live delivery"): the /chat WebSocket. JSON text frames from the server to the
// browser; the browser only subscribes, unsubscribes and pings. Writes never come over this socket, they are REST calls
// (chat-routes.mjs), which call publish() once the row is committed.
//
// A socket carries text only for the channels it subscribed to, each checked with the access function when it was made
// and again whenever access changes. Other channels the person can read get counts only.

import { CHAT_KINDS, channelKey } from './chat-access.mjs';

export const CHAT_CLOSE = Object.freeze({
  unauthenticated: 4401,
  tooManySockets: 4429,
  policy: 1008,
});
/** @type {Readonly<{ socketsPerUser: number, subscriptionsPerSocket: number, queueBytes: number, frames: number, framesWindowMs: number }>} */
export const HUB_LIMITS = Object.freeze({
  socketsPerUser: 10,
  subscriptionsPerSocket: 50,
  /** A socket whose unsent frames pass this is dropped rather than buffered without bound. */
  queueBytes: 1024 * 1024,
  /** Frames a client may send in framesWindowMs before the socket is closed. */
  frames: 60,
  framesWindowMs: 10_000,
});
/** The relay's WebSocketServer for /chat uses this as maxPayload: client frames are tiny. */
export const MAX_CLIENT_FRAME = 4096;
const TICK_MS = 1000;
// how often the tick asks the directory whether a socket's person still exists and is enabled (as /sync does)
const RECHECK_MS = 5000;
const PING_MS = 30_000;
const REF_MAX = 128;

/**
 * @param {object} deps
 * @param {{ authenticate(cookie: unknown): any }} deps.auth
 * @param {{ getUser(id: string): any }} deps.directory
 * @param {(user: any, kind: unknown, ref: unknown) => { read: boolean } | null} deps.access
 * @param {(user: any) => any[]} deps.summary the unread summary of a person (the hello frame)
 * @param {(userId: string, kind: string, ref: string) => { unread: number, mentions: number }} deps.channelUnread
 * @param {import('node:events').EventEmitter} [deps.events]
 * @param {boolean} [deps.readOnly] whether the hosted workspace is read-only when the hub starts
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {Partial<typeof HUB_LIMITS>} [deps.limits]
 * @param {boolean} [deps.timers] false in unit tests: no tick or ping intervals
 */
export function createChatHub({ auth, directory, access, summary, channelUnread, events = null, readOnly = false, log = () => {}, now = Date.now, limits = {}, timers = true }) {
  const LIMITS = { ...HUB_LIMITS, ...limits };
  /** @type {Map<string, Set<any>>} person to sockets */
  const byUser = new Map();
  /** @type {Map<string, Set<any>>} channel key to subscribed sockets */
  const byChannel = new Map();
  let knownReadOnly = readOnly === true;

  const allSockets = () => [...byUser.values()].flatMap((set) => [...set]);

  /** Sends one frame, or drops a socket that has fallen too far behind. */
  function send(ws, frame) {
    if (ws.readyState !== 1 || ws.chat?.gone) return;
    const data = JSON.stringify(frame);
    if (ws.bufferedAmount + Buffer.byteLength(data) > LIMITS.queueBytes) {
      log('chat: dropped a socket that was not keeping up');
      drop(ws);
      ws.terminate();
      return;
    }
    ws.send(data, (err) => {
      if (err) ws.terminate();
    });
  }

  /** Forgets a socket everywhere. Safe to call twice. */
  function drop(ws) {
    const state = ws.chat;
    if (!state || state.gone) return;
    state.gone = true;
    for (const key of state.subs.keys()) {
      const set = byChannel.get(key);
      set?.delete(ws);
      if (set?.size === 0) byChannel.delete(key);
    }
    state.subs.clear();
    const mine = byUser.get(state.userId);
    mine?.delete(ws);
    if (mine?.size === 0) byUser.delete(state.userId);
  }

  function close(ws, code, reason) {
    drop(ws);
    ws.close(code, reason);
  }

  /** The person behind a socket as the directory knows them now, or null once they are gone or disabled. */
  const personOf = (ws) => {
    const user = directory.getUser(ws.chat.userId);
    return user && !user.disabled ? user : null;
  };

  function unsubscribe(ws, key) {
    ws.chat.subs.delete(key);
    const set = byChannel.get(key);
    set?.delete(ws);
    if (set?.size === 0) byChannel.delete(key);
  }

  /** Re-checks one socket's subscriptions (all, or those of one channel); lost ones are dropped and told `closed`. */
  function recheck(ws, onlyKey = null) {
    if (ws.chat?.gone) return;
    if (onlyKey !== null && !ws.chat.subs.has(onlyKey)) return;
    const user = personOf(ws);
    if (!user) return close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
    for (const [key, { kind, ref }] of Array.from(ws.chat.subs)) {
      if (onlyKey !== null && key !== onlyKey) continue;
      let ok = false;
      try {
        ok = access(user, kind, ref)?.read === true;
      } catch (err) {
        log('chat: could not check access', err?.message);
      }
      if (ok) continue;
      unsubscribe(ws, key);
      send(ws, { t: 'closed', kind, ref });
    }
  }

  /** The session behind a socket is still valid; checked when it would have expired (it slides while in use). */
  function sessionOk(ws) {
    const state = ws.chat;
    if (now() < state.sessionExpiresAt) return true;
    const session = auth.authenticate(state.cookie);
    if (!session || session.sessionId !== state.sessionId) return false;
    state.sessionExpiresAt = session.expiresAt;
    return true;
  }

  function onSubscribe(ws, kind, ref) {
    const key = channelKey(kind, ref);
    if (ws.chat.subs.has(key)) return send(ws, { t: 'subscribed', kind, ref });
    const user = personOf(ws);
    if (!user) return close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
    // A channel that does not exist and one this person may not read get the same answer.
    if (access(user, kind, ref)?.read !== true) return send(ws, { t: 'denied', kind, ref });
    if (ws.chat.subs.size >= LIMITS.subscriptionsPerSocket) return send(ws, { t: 'denied', kind, ref, reason: 'too_many' });
    ws.chat.subs.set(key, { kind, ref });
    let set = byChannel.get(key);
    if (!set) byChannel.set(key, (set = new Set()));
    set.add(ws);
    send(ws, { t: 'subscribed', kind, ref });
  }

  function onFrame(ws, data, isBinary) {
    const state = ws.chat;
    if (state.gone) return;
    const t = now();
    state.frames = state.frames.filter((ts) => ts > t - LIMITS.framesWindowMs);
    state.frames.push(t);
    if (state.frames.length > LIMITS.frames) return close(ws, CHAT_CLOSE.policy, 'too_many_frames');
    if (isBinary) return;
    if (!sessionOk(ws)) return close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    if (frame.t === 'ping') return send(ws, { t: 'pong' });
    const { kind, ref } = frame;
    if (!CHAT_KINDS.includes(kind) || typeof ref !== 'string' || ref.length > REF_MAX) {
      if (frame.t === 'sub') send(ws, { t: 'denied', kind: typeof kind === 'string' ? kind.slice(0, 20) : null, ref: typeof ref === 'string' ? ref.slice(0, REF_MAX) : null });
      return;
    }
    if (frame.t === 'sub') onSubscribe(ws, kind, ref);
    else if (frame.t === 'unsub') unsubscribe(ws, channelKey(kind, ref));
  }

  /**
   * Takes over an upgraded socket: signs it in from the session cookie of the upgrade request, or closes it with 4401.
   * @param {any} ws
   * @param {import('node:http').IncomingMessage} req
   */
  function connect(ws, req) {
    let session = null;
    try {
      session = auth.authenticate(req.headers.cookie);
    } catch (err) {
      log('chat: could not authenticate a socket', err?.message);
    }
    if (!session) return ws.close(CHAT_CLOSE.unauthenticated, 'unauthenticated');
    const userId = session.user.id;
    const mine = byUser.get(userId);
    if (mine && mine.size >= LIMITS.socketsPerUser) return ws.close(CHAT_CLOSE.tooManySockets, 'too_many_sockets');

    ws.chat = {
      userId,
      sessionId: session.sessionId,
      sessionExpiresAt: session.expiresAt,
      cookie: req.headers.cookie,
      subs: new Map(),
      frames: [],
      gone: false,
      alive: true,
      checkedAt: now(),
    };
    if (mine) mine.add(ws);
    else byUser.set(userId, new Set([ws]));
    ws.on('message', (data, isBinary) => onFrame(ws, data, isBinary));
    ws.on('close', () => drop(ws));
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => {
      if (ws.chat) ws.chat.alive = true;
    });

    let channels = [];
    try {
      channels = summary(session.user);
    } catch (err) {
      log('chat: could not read the unread summary', err?.message);
    }
    send(ws, { t: 'hello', channels, readOnly: knownReadOnly });
  }

  /**
   * A committed change in a channel: the full frame to its subscribers; to everyone else who can read it, for a new
   * message or a delete, the new counts only. `authorId` is left out of the counts (their own message is not unread).
   */
  /**
   * @param {string} kind
   * @param {string} ref
   * @param {Record<string, unknown>} frame
   * @param {{ authorId?: string | null }} [options]
   */
  function publish(kind, ref, frame, { authorId = null } = {}) {
    const key = channelKey(kind, ref);
    const subscribed = byChannel.get(key) ?? new Set();
    for (const ws of Array.from(subscribed)) send(ws, frame);
    if (frame.t !== 'message' && frame.t !== 'delete') return;
    for (const [userId, sockets] of byUser) {
      if (userId === authorId) continue;
      const others = [...sockets].filter((ws) => !subscribed.has(ws));
      if (others.length === 0) continue;
      const user = directory.getUser(userId);
      if (!user || user.disabled || access(user, kind, ref)?.read !== true) continue;
      const counts = channelUnread(userId, kind, ref);
      for (const ws of others) send(ws, { t: 'unread', kind, ref, unread: counts.unread, mentions: counts.mentions });
    }
  }

  /** The person moved their read marker: every socket of theirs clears its badge. */
  function read(userId, kind, ref, lastId) {
    for (const ws of Array.from(byUser.get(userId) ?? [])) send(ws, { t: 'read', kind, ref, lastId });
  }

  /** Closes every socket (a restore takes the server over, or it stops). */
  function closeAll(code, reason) {
    for (const ws of allSockets()) close(ws, code, reason);
  }

  // ------------------------------------------------------------ events from the API

  const listeners = {
    'access-changed': ({ userId, boardId } = {}) => {
      const targets = userId ? Array.from(byUser.get(userId) ?? []) : allSockets();
      const onlyKey = typeof boardId === 'string' ? channelKey('board', boardId) : null;
      for (const ws of targets) recheck(ws, onlyKey);
    },
    'session-revoked': ({ userId, sessionId } = {}) => {
      for (const ws of Array.from(byUser.get(userId) ?? [])) {
        if (!sessionId || ws.chat.sessionId === sessionId) close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
      }
    },
    'user-removed': ({ userId } = {}) => {
      for (const ws of Array.from(byUser.get(userId) ?? [])) close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
    },
    'limits-changed': ({ readOnly: on } = {}) => {
      if ((on === true) === knownReadOnly) return;
      knownReadOnly = on === true;
      for (const ws of allSockets()) send(ws, { t: 'readonly', on: knownReadOnly });
    },
  };
  if (events) for (const [name, fn] of Object.entries(listeners)) events.on(name, fn);

  // A session that ends by expiring has no event: each socket is looked at once a second, the same as /sync, and its
  // person every five seconds (disabling and removing someone also arrive as events).
  function tick() {
    const t = now();
    for (const ws of allSockets()) {
      try {
        if (!sessionOk(ws)) {
          close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
          continue;
        }
        if (t - ws.chat.checkedAt < RECHECK_MS) continue;
        ws.chat.checkedAt = t;
        if (!personOf(ws)) close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
      } catch (err) {
        log('chat: could not check a session', err?.message);
      }
    }
  }
  function ping() {
    for (const ws of allSockets()) {
      if (!ws.chat.alive) {
        drop(ws);
        ws.terminate();
        continue;
      }
      ws.chat.alive = false;
      ws.ping();
    }
  }
  const intervals = timers ? [setInterval(tick, TICK_MS), setInterval(ping, PING_MS)] : [];
  for (const timer of intervals) timer.unref();

  function stop() {
    for (const timer of intervals) clearInterval(timer);
    if (events) for (const [name, fn] of Object.entries(listeners)) events.off(name, fn);
  }

  return { connect, publish, read, closeAll, stop, tick, stats: () => ({ users: byUser.size, sockets: allSockets().length, channels: byChannel.size }) };
}
