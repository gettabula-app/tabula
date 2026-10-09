// The browser's copy of board chat (docs/chat.md, Offline): IndexedDB `tabula-chat` with a `channels` store (the last 50
// messages of each channel this person opened, for reading offline) and an `outbox` store (messages not yet accepted by
// the server). Sign-out deletes the whole database. Without IndexedDB (a private window, blocked site data) every call
// resolves to nothing and chat works from memory only.

import type { ChatMessage } from './api';
import type { OutboxItem } from './ui/chat-logic';

const DB_NAME = 'tabula-chat';
const VERSION = 1;
const CHANNELS = 'channels';
const OUTBOX = 'outbox';

export interface CachedChannel { key: string; messages: ChatMessage[]; savedAt: number }

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHANNELS)) db.createObjectStore(CHANNELS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'clientId' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab deleting the database (sign-out) must not wait on this connection
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) return resolve(undefined);
    let req: IDBRequest<T> | void;
    try {
      const tx = db.transaction(store, mode);
      req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export const readChannel = (key: string): Promise<CachedChannel | undefined> =>
  run<CachedChannel>(CHANNELS, 'readonly', (s) => s.get(key) as IDBRequest<CachedChannel>);

export const writeChannel = (entry: CachedChannel): Promise<unknown> => run(CHANNELS, 'readwrite', (s) => s.put(entry));

export const readOutbox = (): Promise<OutboxItem[]> =>
  run<OutboxItem[]>(OUTBOX, 'readonly', (s) => s.getAll() as IDBRequest<OutboxItem[]>).then((items) => items ?? []);

export const putOutbox = (item: OutboxItem): Promise<unknown> => run(OUTBOX, 'readwrite', (s) => s.put(item));

export const deleteOutbox = (clientId: string): Promise<unknown> => run(OUTBOX, 'readwrite', (s) => s.delete(clientId));

/** Sign-out: the cached messages and the unsent ones are this person's and go with them. */
export function clearChatCache(): Promise<void> {
  return open().then((db) => {
    db?.close();
    opening = null;
    return new Promise<void>((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve();
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  });
}
