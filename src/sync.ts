import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { Store } from './store';
import { Comments } from './comments';
import type { User } from './types';
import { USER_COLORS, personColor } from './palette';
import { isDesktop } from './desktop-env';

// ---------------------------------------------------------------- identity

const USER_KEY = 'driftboard:user';
const ADJ = ['Teal', 'Amber', 'Quiet', 'Swift', 'Bright', 'Calm', 'Bold', 'Lucky', 'Clever', 'Brave'];
const NOUN = ['Otter', 'Heron', 'Fox', 'Lynx', 'Wren', 'Moth', 'Badger', 'Finch', 'Hare', 'Owl'];

export function getUser(): User {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) {
      const u = JSON.parse(raw) as User;
      // a colour stored before TAB-197 maps to its replacement, once, here
      const color = personColor(u.color);
      if (color !== u.color) { u.color = color; saveUser(u); }
      return u;
    }
  } catch { /* ignore */ }
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const u: User = {
    id: crypto.randomUUID(),
    name: `${pick(ADJ)} ${pick(NOUN)}`,
    color: pick(USER_COLORS),
  };
  localStorage.setItem(USER_KEY, JSON.stringify(u));
  return u;
}

export function saveUser(u: User) {
  localStorage.setItem(USER_KEY, JSON.stringify(u));
}

// ---------------------------------------------------------------- relay setting

const RELAY_KEY = 'driftboard:relay';

/**
 * 'auto' = same origin as the app (the relay also serves the app), 'off' = local only. The desktop app has no relay
 * of its own origin (on Windows its page is http://tauri.localhost, which would be tried as ws://tauri.localhost/sync),
 * so there 'auto' means off and only an address typed in Board settings connects.
 */
export function getRelaySetting(): string {
  return localStorage.getItem(RELAY_KEY) || 'auto';
}
export function setRelaySetting(v: string) {
  localStorage.setItem(RELAY_KEY, v);
}

export function relayUrl(): string | null {
  const s = getRelaySetting();
  if (s === 'off') return null;
  if (s === 'auto') {
    if (isDesktop() || (location.protocol !== 'http:' && location.protocol !== 'https:')) return null;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sync`;
  }
  return s.replace(/\/+$/, '');
}

// ---------------------------------------------------------------- board index

export interface BoardEntry { id: string; name: string; updatedAt: number; createdAt: number }
const INDEX_KEY = 'driftboard:boards';

export function listBoards(): BoardEntry[] {
  try {
    return (JSON.parse(localStorage.getItem(INDEX_KEY) || '[]') as BoardEntry[]).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function touchBoard(id: string, patch: Partial<BoardEntry> = {}) {
  const all = listBoards();
  const i = all.findIndex((b) => b.id === id);
  const now = Date.now();
  if (i >= 0) all[i] = { ...all[i], ...patch, updatedAt: patch.updatedAt ?? now };
  else all.push({ id, name: 'Untitled board', createdAt: now, updatedAt: now, ...patch });
  localStorage.setItem(INDEX_KEY, JSON.stringify(all));
}

const deleteHooks = new Set<(id: string) => void | Promise<void>>();

/** Calls `fn` after a board was deleted from this device. The desktop app removes the board's backup copy with it. */
export function onBoardDeleted(fn: (id: string) => void | Promise<void>): () => void {
  deleteHooks.add(fn);
  return () => deleteHooks.delete(fn);
}

export async function deleteBoard(id: string) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(listBoards().filter((b) => b.id !== id)));
  await clearLocal(`driftboard:${id}`);
  await clearLocal(`driftboard:${commentsRoom(id)}`);
  for (const hook of deleteHooks) {
    try {
      await hook(id);
    } catch (e) {
      console.warn('after-delete hook failed', e);
    }
  }
}

/**
 * Writes a board into this device's storage under `id` without opening it: no relay connection, no board UI. `fill`
 * puts the content in (the import path); the databases are closed when it has been written.
 */
export async function writeLocalBoard(id: string, fill: (target: { doc: Y.Doc; store: Store; comments: Comments }) => void) {
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(`driftboard:${id}`, doc);
  const cdoc = new Y.Doc();
  const cidb = new IndexeddbPersistence(`driftboard:${commentsRoom(id)}`, cdoc);
  await Promise.all([idb.whenSynced, cidb.whenSynced]);
  fill({ doc, store: new Store(doc), comments: new Comments(cdoc) });
  // A closing database lets its pending write transactions finish, and a later open of it queues behind them.
  await Promise.all([idb.destroy(), cidb.destroy()]);
  doc.destroy();
  cdoc.destroy();
}

// ---------------------------------------------------------------- connection

export type SyncStatus = 'local' | 'connecting' | 'live' | 'denied';

/** Why the relay refused or dropped the connection (accounts mode close codes). */
export type DeniedReason = 'unauthenticated' | 'no_access' | 'not_found' | 'access_removed';

export function deniedReason(code: number): DeniedReason | null {
  switch (code) {
    case 4401: return 'unauthenticated';
    case 4403: return 'no_access';
    case 4404: return 'not_found';
    case 4410: return 'access_removed';
    default: return null;
  }
}

/** The part of a room provider that a denial stops. */
type Room = { disconnect: () => void; shouldConnect: boolean };

/**
 * The denial path shared by the board and comments rooms. The first refusal records the reason,
 * stops every room and calls `denied` once. Later refusals and close codes that are not denials do nothing.
 */
export function denyOnce(conn: { denied: DeniedReason | null }, rooms: Room[], code: number | undefined, denied: (reason: DeniedReason) => void): void {
  if (conn.denied || code === undefined) return;
  const reason = deniedReason(code);
  if (!reason) return;
  conn.denied = reason;
  for (const room of rooms) {
    room.disconnect();
    room.shouldConnect = false;
  }
  denied(reason);
}

/**
 * Hosted workspaces (docs/cloud.md): the relay sends one message of this type on every open socket when the workspace's
 * read-only switch flips. It is not a y-websocket type (those are 0 sync, 1 awareness, 2 auth, 3 query awareness).
 *
 * Checked against y-websocket 3.1.0: every provider copies the default table to its own `messageHandlers`, indexed by the
 * first varUint of a message, and calls `handler(encoder, decoder, provider, emitSynced, messageType)`. An index that is
 * not filled makes it log "Unable to compute message" and carry on, so an old client survives the new message. A handler
 * must leave the encoder empty, because anything written to it is sent back to the relay.
 */
export const MSG_WORKSPACE = 4;

/** The part of a room provider that carries the table of message handlers. */
type HintTarget = { messageHandlers: WebsocketProvider['messageHandlers'] };

/**
 * Calls `callback` whenever the relay says the workspace's read-only switch flipped. The hint carries no authority, so
 * the payload is not read: the callback asks the server what is true. It never throws into the socket.
 */
export function onWorkspaceHint(provider: HintTarget, callback: () => void): void {
  provider.messageHandlers[MSG_WORKSPACE] = () => {
    try {
      callback();
    } catch {
      /* a failing listener must not break the socket */
    }
  };
}

/**
 * Comments rooms (docs/comment-authz.md): the relay tells the socket whose change it undid, with JSON { undone: [...] }
 * (the kinds: edit, delete, resolve, author, other). Like the hint above, it is not a y-websocket type, the handler
 * writes nothing back, and a malformed notice is ignored.
 */
export const MSG_COMMENT_NOTICE = 5;

export function onCommentNotice(provider: HintTarget, callback: (undone: string[]) => void): void {
  provider.messageHandlers[MSG_COMMENT_NOTICE] = (_encoder, decoder) => {
    let undone: unknown;
    try {
      undone = (JSON.parse(decoding.readVarString(decoder)) as { undone?: unknown }).undone;
    } catch {
      return;
    }
    if (!Array.isArray(undone)) return;
    try {
      callback(undone.filter((k): k is string => typeof k === 'string'));
    } catch {
      /* a failing listener must not break the socket */
    }
  };
}

/**
 * Board rooms (docs/ai.md, "Live runs"): the relay tells every socket about the board's AI runs, as JSON
 * { kind: 'snapshot', runs } when it joins while runs are open, then { kind: 'patch', run } per change. Like the notices
 * above, the handler writes nothing back and a malformed message is ignored. The runs themselves are checked by their reader.
 */
export const MSG_AI_RUNS = 6;

export type AiRunsMessage = { kind: 'snapshot'; runs: unknown[] } | { kind: 'patch'; run: unknown };

export function onAiRuns(provider: HintTarget, callback: (message: AiRunsMessage) => void): void {
  provider.messageHandlers[MSG_AI_RUNS] = (_encoder, decoder) => {
    let message: AiRunsMessage;
    try {
      const data = JSON.parse(decoding.readVarString(decoder)) as { kind?: unknown; runs?: unknown; run?: unknown } | null;
      if (data?.kind === 'snapshot' && Array.isArray(data.runs)) message = { kind: 'snapshot', runs: data.runs };
      else if (data?.kind === 'patch' && typeof data.run === 'object' && data.run !== null) message = { kind: 'patch', run: data.run };
      else return;
    } catch {
      return;
    }
    try {
      callback(message);
    } catch {
      /* a failing listener must not break the socket */
    }
  };
}

/** The part of a room provider that a resync restarts. */
type Resyncable = { disconnect: () => void; connect: () => void };

/**
 * Starts the room connections again so the fresh state exchange (sync step 1 and 2) sends everything typed while the
 * relay was dropping updates. A refused connection stays stopped.
 */
export function resyncRooms(conn: { denied: DeniedReason | null }, rooms: Resyncable[]): void {
  if (conn.denied) return;
  for (const room of rooms) {
    room.disconnect();
    room.connect();
  }
}

const commentsRoom = (id: string) => `${id}~comments`;

async function clearLocal(name: string) {
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(name, doc);
  await idb.whenSynced;
  await idb.clearData();
  doc.destroy();
}

export interface BoardConn {
  id: string;
  doc: Y.Doc;
  store: Store;
  comments: Comments;
  awareness: Awareness;
  provider: WebsocketProvider | null;
  status: SyncStatus;
  denied: DeniedReason | null;
  onStatus: (fn: (s: SyncStatus) => void) => () => void;
  onDenied: (fn: (r: DeniedReason) => void) => () => void;
  /** The relay says a hosted workspace's read-only switch flipped (either room's socket; one flip arrives once per socket). */
  onWorkspaceHint: (fn: () => void) => () => void;
  /** The relay undid changes this person made in the comments (accounts mode); `undone` lists the kinds. */
  onCommentNotice: (fn: (undone: string[]) => void) => () => void;
  /** The relay sent the board's live AI runs (a snapshot on joining, then a patch per change). */
  onAiRuns: (fn: (message: AiRunsMessage) => void) => () => void;
  /** Reconnects both rooms for a fresh sync; does nothing once the relay has refused this board. */
  resync: () => void;
  destroy: () => void;
}

export async function openBoard(id: string, user: User): Promise<BoardConn> {
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(`driftboard:${id}`, doc);
  const cdoc = new Y.Doc();
  const cidb = new IndexeddbPersistence(`driftboard:${commentsRoom(id)}`, cdoc);
  await Promise.all([idb.whenSynced, cidb.whenSynced]);
  const store = new Store(doc);
  const comments = new Comments(cdoc);

  const url = relayUrl();
  let provider: WebsocketProvider | null = null;
  let commentsProvider: WebsocketProvider | null = null;
  let awareness: Awareness;
  const statusListeners = new Set<(s: SyncStatus) => void>();
  const deniedListeners = new Set<(r: DeniedReason) => void>();
  const hintListeners = new Set<() => void>();
  const noticeListeners = new Set<(undone: string[]) => void>();
  const aiRunListeners = new Set<(message: AiRunsMessage) => void>();
  const conn: BoardConn = {
    id, doc, store, comments, provider: null, awareness: null as unknown as Awareness, status: 'local', denied: null,
    onStatus: (fn) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    onDenied: (fn) => {
      deniedListeners.add(fn);
      if (conn.denied) fn(conn.denied);
      return () => deniedListeners.delete(fn);
    },
    onWorkspaceHint: (fn) => {
      hintListeners.add(fn);
      return () => hintListeners.delete(fn);
    },
    onCommentNotice: (fn) => {
      noticeListeners.add(fn);
      return () => noticeListeners.delete(fn);
    },
    onAiRuns: (fn) => {
      aiRunListeners.add(fn);
      return () => aiRunListeners.delete(fn);
    },
    resync: () => resyncRooms(conn, [provider, commentsProvider].filter((p): p is WebsocketProvider => p !== null)),
    destroy: () => {
      provider?.destroy();
      awareness.destroy();
      idb.destroy();
      doc.destroy();
      commentsProvider?.destroy();
      commentsProvider?.awareness.destroy();
      cidb.destroy();
      cdoc.destroy();
    },
  };
  const setStatus = (s: SyncStatus) => {
    conn.status = s;
    statusListeners.forEach((l) => l(s));
  };
  // Either room can be refused; the first refusal stops both.
  const onClose = (event: CloseEvent | null) => {
    const rooms = [provider, commentsProvider].filter((p): p is WebsocketProvider => p !== null);
    denyOnce(conn, rooms, event?.code, (reason) => {
      setStatus('denied');
      deniedListeners.forEach((l) => l(reason));
    });
  };

  const hinted = () => hintListeners.forEach((l) => l());

  if (url) {
    provider = new WebsocketProvider(url, id, doc, { maxBackoffTime: 8000 });
    awareness = provider.awareness;
    setStatus('connecting');
    provider.on('status', ({ status }: { status: string }) => {
      if (conn.denied) return;
      setStatus(status === 'connected' ? 'live' : 'connecting');
    });
    provider.on('connection-close', onClose);
    onWorkspaceHint(provider, hinted);
    // registered even with no listener yet, so an app that does not draw runs does not log every message as unknown
    onAiRuns(provider, (message) => aiRunListeners.forEach((l) => l(message)));
    commentsProvider = new WebsocketProvider(url, commentsRoom(id), cdoc, { maxBackoffTime: 8000 });
    commentsProvider.awareness.setLocalState(null);
    commentsProvider.on('connection-close', onClose);
    onWorkspaceHint(commentsProvider, hinted);
    onCommentNotice(commentsProvider, (undone) => noticeListeners.forEach((l) => l(undone)));
  } else {
    awareness = new Awareness(doc);
  }
  conn.provider = provider;
  conn.awareness = awareness;
  awareness.setLocalStateField('user', user);

  touchBoard(id, { name: store.getMeta().name });
  store.meta.observe(() => touchBoard(id, { name: store.getMeta().name }));
  let touchTimer = 0;
  doc.on('update', () => {
    clearTimeout(touchTimer);
    touchTimer = window.setTimeout(() => touchBoard(id), 1500);
  });
  return conn;
}

/**
 * A board that lives only in memory: a fresh document with no IndexedDB persistence, no relay rooms and no entry in
 * the board index, so it never syncs, never appears on the Boards page and is gone when it is destroyed. Comments are
 * read-only, since a scratch board has nowhere to keep them. Used to edit a saved template.
 */
export function scratchBoard(id: string, user: User): BoardConn {
  const doc = new Y.Doc();
  const cdoc = new Y.Doc();
  const store = new Store(doc);
  const comments = new Comments(cdoc);
  comments.setReadOnly(true);
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', user);
  return {
    id, doc, store, comments, awareness, provider: null, status: 'local', denied: null,
    onStatus: () => () => undefined,
    onDenied: () => () => undefined,
    onWorkspaceHint: () => () => undefined,
    onCommentNotice: () => () => undefined,
    onAiRuns: () => () => undefined,
    resync: () => undefined,
    destroy: () => {
      awareness.destroy();
      doc.destroy();
      cdoc.destroy();
    },
  };
}
