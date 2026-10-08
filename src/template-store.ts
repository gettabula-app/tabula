// My templates. One store interface, two places they live: this browser's IndexedDB (open mode) and the workspace
// server (accounts mode, see template-server.ts). The sign-in state picks the backend; everything above this file
// (the Templates page, the library drawer, the Save dialog, template editing) goes through the functions at the end.

import { validateContent, type CustomTemplate, type TemplateScope } from './custom-templates';
import { authState, onAuth, type AuthState } from './auth';
import { api } from './api';
import { TemplateError, serverBackend, indexedDbCache } from './template-server';

export { TemplateError };

const DB_NAME = 'driftboard:templates';
const STORE = 'templates';
const CHANNEL = 'driftboard:templates';
const UNAVAILABLE = 'Templates cannot be saved here: this browser has no IndexedDB, or it is turned off.';

/** Where the records live. Reads return raw records; the store checks every one. */
export interface TemplateBackend {
  /** True when the templates live on the server: they can be shared with others, and saving needs a connection. */
  readonly shared?: boolean;
  getAll(): Promise<unknown[]>;
  get(id: string): Promise<unknown>;
  /** Saves a new or a changed template. The record as kept can be returned (the server picks the id of a new one). */
  put(t: CustomTemplate): Promise<unknown>;
  delete(id: string): Promise<void>;
  /** A personal copy made where the template is kept; only the server has one. */
  duplicate?(id: string): Promise<unknown>;
  /** Tell other tabs that the templates changed. */
  notify?(): void;
  /** Called when another tab reports a change; returns the unsubscribe. */
  onNotify?(fn: () => void): () => void;
}

export interface TemplateStore {
  /** See TemplateBackend.shared. */
  readonly shared: boolean;
  /** Newest first. Invalid records are skipped. */
  list(): Promise<CustomTemplate[]>;
  get(id: string): Promise<CustomTemplate | undefined>;
  /** Saves a template and answers with it as kept: on the server a new template gets a new id. */
  put(t: CustomTemplate): Promise<CustomTemplate>;
  /** A personal copy made on the server. Throws where the backend cannot do that. */
  duplicate(id: string): Promise<CustomTemplate>;
  remove(id: string): Promise<void>;
  onChange(fn: () => void): () => void;
}

const SCOPES: readonly TemplateScope[] = ['personal', 'team', 'workspace'];

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
  const t: CustomTemplate = {
    id, version, name, category, description, createdBy, createdAt, updatedAt,
    content: validateContent(raw.content),
  };
  // Who a template is shared with only means something on the server; templates kept in the browser have none of it.
  if (typeof raw.scope === 'string' && (SCOPES as readonly string[]).includes(raw.scope)) {
    t.scope = raw.scope as TemplateScope;
    t.teamId = typeof raw.teamId === 'string' ? raw.teamId : null;
    if (typeof raw.teamName === 'string') t.teamName = raw.teamName;
    if (typeof raw.ownerName === 'string') t.ownerName = raw.ownerName;
    if (typeof raw.canChange === 'boolean') t.canChange = raw.canChange;
  }
  return t;
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
    shared: backend?.shared === true,
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
      let saved = safe;
      try {
        const kept = await backend.put(safe);
        if (kept !== undefined) saved = validateTemplate(kept);
      } catch (e) {
        throw e instanceof TemplateError ? e : new Error(`Could not save the template: ${errorText(e)}`);
      }
      backend.notify?.();
      fire();
      return saved;
    },
    async duplicate(id) {
      if (!backend?.duplicate) throw new Error(UNAVAILABLE);
      let copy: CustomTemplate;
      try {
        copy = validateTemplate(await backend.duplicate(id));
      } catch (e) {
        throw e instanceof TemplateError ? e : new Error(`Could not duplicate the template: ${errorText(e)}`);
      }
      backend.notify?.();
      fire();
      return copy;
    },
    async remove(id) {
      if (!backend) throw new Error(UNAVAILABLE);
      try {
        await backend.delete(id);
      } catch (e) {
        throw e instanceof TemplateError ? e : new Error(`Could not delete the template: ${errorText(e)}`);
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

/** Tells the other tabs of this browser that the templates changed, and hears them. */
export function channelBus(name = CHANNEL): Required<Pick<TemplateBackend, 'notify' | 'onNotify'>> {
  let channel: BroadcastChannel | undefined;
  const chan = () => {
    if (!channel && typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(name);
    return channel;
  };
  return {
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
  const bus = channelBus();

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
    notify: bus.notify,
    onNotify: bus.onNotify,
  };
}

export type TemplateHome = 'browser' | 'server';

/** Signed in (or signed in and offline, with the last answers cached): templates live on the server. Otherwise in the browser. */
export const templateHomeFor = (mode: AuthState['mode']): TemplateHome => (mode === 'signed-in' || mode === 'offline' ? 'server' : 'browser');

/** What the server's templates left in this browser for offline use. */
export const serverTemplateCache = indexedDbCache(typeof indexedDB === 'undefined' ? undefined : indexedDB);

let inBrowser: TemplateStore | undefined;
let onServer: TemplateStore | undefined;
const browserStore = () => (inBrowser ??= createTemplateStore(typeof indexedDB === 'undefined' ? null : indexedDbBackend(indexedDB)));
const serverStore = () => (onServer ??= createTemplateStore(serverBackend({
  api,
  cache: serverTemplateCache,
  origin: () => (typeof location === 'undefined' ? '' : location.origin),
  offline: () => authState().mode === 'offline',
  bus: channelBus('driftboard:templates:server'),
})));

// Other people's team templates must not stay behind on a shared computer: signing out (or a session that ended)
// forgets the cache and what the store knew, so the next person to sign in starts clean.
onAuth((state) => {
  if (state.mode !== 'signed-out') return;
  onServer = undefined;
  void serverTemplateCache.clear().catch(() => undefined);
});

/** The store for a sign-in state: the seam between the browser and the server. */
export const templateStoreFor = (mode: AuthState['mode']): TemplateStore => (templateHomeFor(mode) === 'server' ? serverStore() : browserStore());
/** The templates kept in this browser, whatever the sign-in state (the upload offer reads them). */
export const browserTemplates = (): TemplateStore => browserStore();

const defaultStore = () => templateStoreFor(authState().mode);

/** Whether templates are shared through the server right now. */
export const templatesShared = (): boolean => defaultStore().shared;

export const listTemplates = (): Promise<CustomTemplate[]> => defaultStore().list();
export const getTemplate = (id: string): Promise<CustomTemplate | undefined> => defaultStore().get(id);
export const putTemplate = (t: CustomTemplate): Promise<CustomTemplate> => defaultStore().put(t);
export const duplicateSavedTemplate = (id: string): Promise<CustomTemplate> => defaultStore().duplicate(id);
export const removeTemplate = (id: string): Promise<void> => defaultStore().remove(id);

/** Calls `fn` when the templates change, and when signing in or out moves them to the other place. */
export function onTemplatesChange(fn: () => void): () => void {
  let home = templateHomeFor(authState().mode);
  let release = defaultStore().onChange(fn);
  const offAuth = onAuth((state) => {
    const next = templateHomeFor(state.mode);
    if (next === home) return;
    home = next;
    release();
    release = defaultStore().onChange(fn);
    fn();
  });
  return () => {
    release();
    offAuth();
  };
}
