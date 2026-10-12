// Live chat delivery (docs/chat.md, "Live delivery"): the /chat WebSocket. JSON text frames from the server to the
// browser; the browser subscribes, unsubscribes, watches presence and pings. Writes never come over this socket, they are REST calls
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
const PRESENCE_REFRESH_MS = 60_000;
const PRESENCE_ROOM_LIMIT = 200;
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
 * @param {(user: any) => Iterable<string>} [deps.presenceBoardIds] board ids the person can currently open
 * @param {(user: any, boardIds: Set<string>) => any[]} [deps.presenceForUser] current, capped live-room summaries
 * @param {(user: any, boardId: string) => any | null} [deps.presenceForBoard] current summary for one live room
 * @param {(boardId: string) => number | null} [deps.presenceActivity] last identity-change time for one room
 * @param {(user: any, boardId: string) => boolean} [deps.presenceCanRead] re-checks board access before each send
 * @param {(userId: string, kind: string, ref: string) => { unread: number, mentions: number }} deps.channelUnread
 * @param {import('node:events').EventEmitter} [deps.events]
 * @param {boolean} [deps.readOnly] whether the hosted workspace is read-only when the hub starts
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {Partial<typeof HUB_LIMITS>} [deps.limits]
 * @param {boolean} [deps.timers] false in unit tests: no tick or ping intervals
 */
export function createChatHub({ auth, directory, access, summary, presenceBoardIds = () => [], presenceForUser = () => [], presenceForBoard = () => null, presenceActivity = () => null, presenceCanRead = () => false, channelUnread, events = null, readOnly = false, log = () => {}, now = Date.now, limits = {}, timers = true }) {
  const LIMITS = { ...HUB_LIMITS, ...limits };
  /** @type {Map<string, Set<any>>} person to sockets */
  const byUser = new Map();
  /** @type {Map<string, Set<any>>} channel key to subscribed sockets */
  const byChannel = new Map();
  /** @type {Map<string, Set<any>>} board id to sockets watching Boards-page presence */
  const byPresenceBoard = new Map();
  let knownReadOnly = readOnly === true;
  /** When a person's last socket went away (kept for an hour, for the mention email's "nobody has looked since" test). */
  const lastGone = new Map();

  const allSockets = () => [...byUser.values()].flatMap((set) => [...set]);

  function removePresenceSubscriptions(ws) {
    const state = ws.chat;
    if (!state) return;
    for (const boardId of state.presenceBoards) {
      const watchers = byPresenceBoard.get(boardId);
      watchers?.delete(ws);
      if (watchers?.size === 0) byPresenceBoard.delete(boardId);
    }
    state.presenceBoards.clear();
  }

  function canReadPresence(user, boardId) {
    try {
      return presenceCanRead(user, boardId) === true;
    } catch (err) {
      log('chat: could not check board presence access', err?.message);
      return false;
    }
  }

  function presenceRows(user, boardIds) {
    let rows = [];
    try {
      rows = presenceForUser(user, boardIds) ?? [];
    } catch (err) {
      log('chat: could not read board presence', err?.message);
    }
    return Array.from(rows).filter((board) => board && typeof board.boardId === 'string'
      && boardIds.has(board.boardId) && canReadPresence(user, board.boardId));
  }

  function currentPresence(ws, user) {
    const boardIds = new Set();
    try {
      for (const boardId of presenceBoardIds(user) ?? []) {
        if (typeof boardId === 'string' && canReadPresence(user, boardId)) boardIds.add(boardId);
      }
    } catch (err) {
      log('chat: could not list boards for presence', err?.message);
    }
    const state = ws.chat;
    removePresenceSubscriptions(ws);
    state.presenceBoards = boardIds;
    for (const boardId of boardIds) {
      let watchers = byPresenceBoard.get(boardId);
      if (!watchers) byPresenceBoard.set(boardId, (watchers = new Set()));
      watchers.add(ws);
    }
    const rows = new Map(presenceRows(user, boardIds).map((board) => [board.boardId, board]));
    state.presenceActivityAt = new Map([...rows.keys()].map((boardId) => [boardId, presenceActivity(boardId) ?? now()]));
    return rows;
  }

  function refreshPresence(ws, forceSnapshot = false) {
    const state = ws.chat;
    if (!state || state.gone || !state.presenceWatching) return;
    const user = personOf(ws);
    if (!user) return close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
    const next = currentPresence(ws, user);
    const changed = JSON.stringify([...state.presenceSent]) !== JSON.stringify([...next]);
    state.presenceSent = next;
    state.presenceRefreshedAt = now();
    if (forceSnapshot || changed) send(ws, { t: 'presence.snapshot', boards: [...next.values()] });
  }

  function watchPresence(ws, forceSnapshot = true) {
    const state = ws.chat;
    if (!state || state.gone) return;
    state.presenceWatching = true;
    refreshPresence(ws, forceSnapshot);
  }

  function unwatchPresence(ws) {
    const state = ws.chat;
    if (!state || state.gone) return;
    removePresenceSubscriptions(ws);
    state.presenceWatching = false;
    state.presenceSent.clear();
    state.presenceActivityAt.clear();
    state.presenceRefreshedAt = now();
  }

  /** A room changed; only its watchers are considered, and each receives a frame only when their view changed. */
  function publishPresence(boardId) {
    const watchers = Array.from(byPresenceBoard.get(boardId) ?? []);
    for (const ws of watchers) {
      const state = ws.chat;
      if (!state || state.gone || !state.presenceWatching) continue;
      const user = personOf(ws);
      if (!user) {
        close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
        continue;
      }
      if (!canReadPresence(user, boardId)) {
        refreshPresence(ws, true);
        continue;
      }
      let after = null;
      try {
        after = presenceForBoard(user, boardId) ?? null;
      } catch (err) {
        log('chat: could not read one board presence summary', err?.message);
      }
      if (after && after.boardId !== boardId) after = null;
      const before = state.presenceSent.get(boardId);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (!after) {
        if (!before) continue;
        state.presenceSent.delete(boardId);
        state.presenceActivityAt.delete(boardId);
        if (canReadPresence(user, boardId)) send(ws, { t: 'presence.clear', boardId });
        continue;
      }

      const activityAt = presenceActivity(boardId) ?? now();
      let evicted = null;
      if (!before && state.presenceSent.size >= PRESENCE_ROOM_LIMIT) {
        for (const [id, at] of state.presenceActivityAt) {
          if (evicted === null || at < state.presenceActivityAt.get(evicted)) evicted = id;
        }
        if (evicted !== null && activityAt < state.presenceActivityAt.get(evicted)) continue;
        if (evicted !== null && !canReadPresence(user, evicted)) {
          refreshPresence(ws, true);
          continue;
        }
      }
      if (evicted !== null) {
        state.presenceSent.delete(evicted);
        state.presenceActivityAt.delete(evicted);
        send(ws, { t: 'presence.clear', boardId: evicted });
      }
      state.presenceSent.set(boardId, after);
      state.presenceActivityAt.set(boardId, activityAt);
      if (canReadPresence(user, boardId)) send(ws, { t: 'presence.update', board: after });
      else refreshPresence(ws, true);
    }
  }

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
    removePresenceSubscriptions(ws);
    for (const key of state.subs.keys()) {
      const set = byChannel.get(key);
      set?.delete(ws);
      if (set?.size === 0) byChannel.delete(key);
    }
    state.subs.clear();
    const mine = byUser.get(state.userId);
    mine?.delete(ws);
    if (mine?.size === 0) {
      byUser.delete(state.userId);
      lastGone.set(state.userId, now());
    }
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
    if (frame.t === 'presence.watch') return watchPresence(ws);
    if (frame.t === 'presence.unwatch') return unwatchPresence(ws);
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
      presenceWatching: false,
      presenceBoards: new Set(),
      presenceSent: new Map(),
      presenceActivityAt: new Map(),
      presenceRefreshedAt: 0,
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

  /**
   * A notice for one person about a channel they are not looking at (a mention, docs/chat.md): sent to all their sockets when
   * none of them is subscribed to the channel. Answers 'sent', 'looking' (a tab shows that channel, so the message is
   * already in front of them) or 'offline' (no socket at all).
   * @param {string} userId
   * @param {string} kind
   * @param {string} ref
   * @param {Record<string, unknown>} frame
   * @returns {'sent' | 'looking' | 'offline'}
   */
  function notice(userId, kind, ref, frame) {
    const sockets = Array.from(byUser.get(userId) ?? []);
    if (sockets.length === 0) return 'offline';
    const key = channelKey(kind, ref);
    if (sockets.some((ws) => ws.chat.subs.has(key))) return 'looking';
    for (const ws of sockets) send(ws, frame);
    return 'sent';
  }

  /** Whether the person has a socket now, or had one that went away at `since` (ms) or later. */
  function activeSince(userId, since) {
    return byUser.has(userId) || (lastGone.get(userId) ?? 0) >= since;
  }

  /** The person moved their read marker: every socket of theirs clears its badge. */
  function read(userId, kind, ref, lastId) {
    for (const ws of Array.from(byUser.get(userId) ?? [])) send(ws, { t: 'read', kind, ref, lastId });
  }

  /** A row in the unified inbox changed: send the access-filtered badge counts to every socket of its recipient. */
  function notify(userId, counts = {}) {
    const unread = Number.isSafeInteger(counts.unread) && counts.unread >= 0 ? counts.unread : 0;
    const unreadMentions = Number.isSafeInteger(counts.unreadMentions) && counts.unreadMentions >= 0 ? counts.unreadMentions : 0;
    for (const ws of Array.from(byUser.get(userId) ?? [])) send(ws, { t: 'notify', unread, unreadMentions });
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
      // Presence follows the same access: a watcher whose view of the boards may have changed gets a fresh snapshot.
      const watchers = userId && boardId ? allSockets() : targets;
      for (const ws of watchers) if (ws.chat?.presenceWatching) refreshPresence(ws);
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
    for (const [userId, at] of lastGone) if (t - at > 60 * 60_000) lastGone.delete(userId);
    for (const ws of allSockets()) {
      try {
        if (!sessionOk(ws)) {
          close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
          continue;
        }
        if (t - ws.chat.checkedAt >= RECHECK_MS) {
          ws.chat.checkedAt = t;
          if (!personOf(ws)) {
            close(ws, CHAT_CLOSE.unauthenticated, 'unauthenticated');
            continue;
          }
        }
        if (ws.chat.presenceWatching && t - ws.chat.presenceRefreshedAt >= PRESENCE_REFRESH_MS) refreshPresence(ws);
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

  return { connect, publish, publishPresence, read, notify, notice, activeSince, closeAll, stop, tick, stats: () => ({ users: byUser.size, sockets: allSockets().length, channels: byChannel.size, presenceBoards: byPresenceBoard.size }) };
}
