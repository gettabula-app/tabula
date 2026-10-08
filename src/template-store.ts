// My templates in open mode: custom templates kept in this browser's IndexedDB.

import { validateContent, type CustomTemplate } from './custom-templates';

const DB_NAME = 'driftboard:templates';
const STORE = 'templates';
const CHANNEL = 'driftboard:templates';
const UNAVAILABLE = 'Templates cannot be saved here: this browser has no IndexedDB, or it is turned off.';

/** Where the records live. Reads return raw records; the store checks every one. */
export interface TemplateBackend {
  getAll(): Promise<unknown[]>;
  get(id: string): Promise<unknown>;
  put(t: CustomTemplate): Promise<void>;
  delete(id: string): Promise<void>;
  /** Tell other tabs that the templates changed. */
  notify?(): void;
  /** Called when another tab reports a change; returns the unsubscribe. */
  onNotify?(fn: () => void): () => void;
}

export interface TemplateStore {
  /** Newest first. Invalid records are skipped. */
  list(): Promise<CustomTemplate[]>;
  get(id: string): Promise<CustomTemplate | undefined>;
  put(t: CustomTemplate): Promise<void>;
  remove(id: string): Promise<void>;
  onChange(fn: () => void): () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Check a stored or imported template and return a safe copy. Throws a readable Error. */
export function validateTemplate(raw: unknown): CustomTemplate {
  if (!isRecord(raw)) throw new Error('A template must be an object.');
  const { id, version, name, category, description, createdBy, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || !id) throw new Error('A template needs an id.');
  if (version !== 1) throw new Error(`Template "${id}" has an unknown format version.`);
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error(`Template "${id}" needs a name of 1 to 80 characters.`);
  if (typeof category !== 'string' || !category.trim() || category.length > 40) throw new Error(`Template "${id}" needs a category of 1 to 40 characters.`);
  if (typeof description !== 'string' || description.length > 280) throw new Error(`Template "${id}" has a description over 280 characters.`);
  if (typeof createdBy !== 'string') throw new Error(`Template "${id}" has no author.`);
  if (!isNum(createdAt) || !isNum(updatedAt)) throw new Error(`Template "${id}" has no dates.`);
  return {
    id, version, name, category, description, createdBy, createdAt, updatedAt,
    content: validateContent(raw.content),
  };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createTemplateStore(backend: TemplateBackend | null): TemplateStore {
  const listeners = new Set<() => void>();
  const fire = () => listeners.forEach((fn) => fn());
  let release: (() => void) | undefined;

  const parse = (raw: unknown): CustomTemplate | undefined => {
    try {
      return validateTemplate(raw);
    } catch (e) {
      console.warn(`Skipped a saved template: ${errorText(e)}`);
      return undefined;
    }
  };

  return {
    async list() {
      if (!backend) return [];
      let raws: unknown[];
      try {
        raws = await backend.getAll();
      } catch (e) {
        console.warn(`Could not read saved templates: ${errorText(e)}`);
        return [];
      }
      return raws.flatMap((r) => parse(r) ?? []).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    },
    async get(id) {
      if (!backend) return undefined;
      try {
        const raw = await backend.get(id);
        return raw === undefined ? undefined : parse(raw);
      } catch (e) {
        console.warn(`Could not read a saved template: ${errorText(e)}`);
        return undefined;
      }
    },
    async put(t) {
      if (!backend) throw new Error(UNAVAILABLE);
      const safe = validateTemplate(t);
      try {
        await backend.put(safe);
      } catch (e) {
        throw new Error(`Could not save the template: ${errorText(e)}`);
      }
      backend.notify?.();
      fire();
    },
    async remove(id) {
      if (!backend) throw new Error(UNAVAILABLE);
      try {
        await backend.delete(id);
      } catch (e) {
        throw new Error(`Could not delete the template: ${errorText(e)}`);
      }
      backend.notify?.();
      fire();
    },
    onChange(fn) {
      listeners.add(fn);
      // Other tabs are only listened to while somebody is subscribed.
      if (listeners.size === 1) release = backend?.onNotify?.(fire);
      return () => {
        listeners.delete(fn);
        if (!listeners.size) {
          release?.();
          release = undefined;
        }
      };
    },
  };
}

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed.'));
});

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted.'));
});

/** The browser's IndexedDB as a backend, with a BroadcastChannel to keep tabs in sync. */
export function indexedDbBackend(factory: IDBFactory): TemplateBackend {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened.'));
    }).catch((e) => {
      opened = undefined;
      throw e;
    });
    return opened;
  };
  let channel: BroadcastChannel | undefined;
  const chan = () => {
    if (!channel && typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(CHANNEL);
    return channel;
  };

  // Everything after the single await runs in the same turn, so the transaction is still active.
  return {
    async getAll() {
      const db = await open();
      return request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    },
    async get(id) {
      const db = await open();
      return request(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
    },
    async put(t) {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(t);
      await done(tx);
    },
    async delete(id) {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      await done(tx);
    },
    notify() {
      chan()?.postMessage('changed');
    },
    onNotify(fn) {
      const c = chan();
      if (!c) return () => undefined;
      const handler = () => fn();
      c.addEventListener('message', handler);
      return () => c.removeEventListener('message', handler);
    },
  };
}

let shared: TemplateStore | undefined;
const defaultStore = () => {
  shared ??= createTemplateStore(typeof indexedDB === 'undefined' ? null : indexedDbBackend(indexedDB));
  return shared;
};

export const listTemplates = (): Promise<CustomTemplate[]> => defaultStore().list();
export const getTemplate = (id: string): Promise<CustomTemplate | undefined> => defaultStore().get(id);
export const putTemplate = (t: CustomTemplate): Promise<void> => defaultStore().put(t);
export const removeTemplate = (id: string): Promise<void> => defaultStore().remove(id);
export const onTemplatesChange = (fn: () => void): (() => void) => defaultStore().onChange(fn);
