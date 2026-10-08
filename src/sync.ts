import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { Store } from './store';
import { Comments } from './comments';
import type { User } from './types';
import { USER_COLORS } from './palette';

// ---------------------------------------------------------------- identity

const USER_KEY = 'driftboard:user';
const ADJ = ['Teal', 'Amber', 'Quiet', 'Swift', 'Bright', 'Calm', 'Bold', 'Lucky', 'Clever', 'Brave'];
const NOUN = ['Otter', 'Heron', 'Fox', 'Lynx', 'Wren', 'Moth', 'Badger', 'Finch', 'Hare', 'Owl'];

export function getUser(): User {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) return JSON.parse(raw);
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

/** 'auto' = same origin as the app (the relay also serves the app), 'off' = local only. */
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
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
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

export async function deleteBoard(id: string) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(listBoards().filter((b) => b.id !== id)));
  await clearLocal(`driftboard:${id}`);
  await clearLocal(`driftboard:${commentsRoom(id)}`);
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

  if (url) {
    provider = new WebsocketProvider(url, id, doc, { maxBackoffTime: 8000 });
    awareness = provider.awareness;
    setStatus('connecting');
    provider.on('status', ({ status }: { status: string }) => {
      if (conn.denied) return;
      setStatus(status === 'connected' ? 'live' : 'connecting');
    });
    provider.on('connection-close', onClose);
    commentsProvider = new WebsocketProvider(url, commentsRoom(id), cdoc, { maxBackoffTime: 8000 });
    commentsProvider.awareness.setLocalState(null);
    commentsProvider.on('connection-close', onClose);
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
