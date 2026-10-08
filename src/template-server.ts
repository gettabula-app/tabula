// Templates on the workspace server (accounts mode) as a backend for the template store, plus the IndexedDB cache that
// lets the list and the templates used before open while the server cannot be reached. Everything the server sends is
// checked again by the store (validateTemplate) before the app uses it: a template is data other people wrote.

import { ApiError, type createApi, type ServerTemplate, type ServerTemplateInfo, type TemplateInput } from './api';
import type { CustomTemplate } from './custom-templates';
import type { TemplateBackend } from './template-store';

/** A failure whose message is ready to show as it is. Any other error a backend throws is wrapped in a sentence. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export const OFFLINE_MESSAGE = 'You are offline. Templates can be saved when the server can be reached.';
const GONE_MESSAGE = 'That template is no longer available.';
const FETCH_AT_ONCE = 4;
const CACHE_DB = 'driftboard:template-cache';
const CACHE_STORE = 'cache';

export type TemplateApi = Pick<
  ReturnType<typeof createApi>,
  'listTemplates' | 'getTemplate' | 'createTemplate' | 'updateTemplate' | 'duplicateTemplate' | 'deleteTemplate'
>;

/** A small key-value store. Every record the backend puts in it is tagged with the server origin it came from. */
export interface TemplateCache {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export function memoryCache(): TemplateCache {
  const rows = new Map<string, unknown>();
  return {
    get: async (key) => rows.get(key),
    put: async (key, value) => void rows.set(key, structuredClone(value)),
    delete: async (key) => void rows.delete(key),
    keys: async () => [...rows.keys()],
    clear: async () => rows.clear(),
  };
}

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed.'));
});

const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted.'));
});

/** The cache in the browser's IndexedDB; where there is none it only lasts as long as the page. */
export function indexedDbCache(factory: IDBFactory | undefined): TemplateCache {
  if (!factory) return memoryCache();
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(CACHE_DB, 1);
      req.onupgradeneeded = () => void req.result.createObjectStore(CACHE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened.'));
    }).catch((e) => {
      opened = undefined;
      throw e;
    });
    return opened;
  };
  const write = async (change: (store: IDBObjectStore) => void) => {
    const tx = (await open()).transaction(CACHE_STORE, 'readwrite');
    change(tx.objectStore(CACHE_STORE));
    await finished(tx);
  };
  return {
    async get(key) {
      return request((await open()).transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key));
    },
    put: (key, value) => write((store) => void store.put(value, key)),
    delete: (key) => write((store) => void store.delete(key)),
    async keys() {
      return (await request((await open()).transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).getAllKeys())).map(String);
    },
    clear: () => write((store) => void store.clear()),
  };
}

export interface ServerBackendDeps {
  api: TemplateApi;
  cache: TemplateCache;
  /** The server this page talks to; cached records of another origin are never used. */
  origin: () => string;
  /** True while the app knows the server cannot be reached: reads come from the cache, writes are refused. */
  offline: () => boolean;
  bus?: Pick<TemplateBackend, 'notify' | 'onNotify'>;
}

const isNetwork = (e: unknown) => e instanceof ApiError && e.status === 0;
const isMissing = (e: unknown) => e instanceof ApiError && e.status === 404;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Runs `job` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, job: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await job(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The error a person sees when the server refused or could not be asked. The server's own messages are readable. */
function failure(e: unknown): Error {
  if (e instanceof ApiError) {
    if (e.status === 0) return new TemplateError('Could not reach the server. Try again when you are back online.');
    if (e.status === 404) return new TemplateError(GONE_MESSAGE);
    if (e.code !== 'unknown' && e.message !== e.code) return new TemplateError(e.message);
    return new TemplateError('The server could not save that. Try again.');
  }
  return e instanceof Error ? e : new Error(String(e));
}

export function serverBackend(deps: ServerBackendDeps): TemplateBackend {
  const { api, cache, bus } = deps;
  /** What this page last saw of each template, to tell what a save changed. */
  const known = new Map<string, ServerTemplate>();
  const listKey = () => `${deps.origin()}|list`;
  const itemKey = (id: string) => `${deps.origin()}|t|${id}`;

  const readCached = async <T>(key: string): Promise<T | undefined> => {
    try {
      const record = (await cache.get(key)) as { origin?: string; value?: T } | undefined;
      return record && record.origin === deps.origin() ? record.value : undefined;
    } catch {
      return undefined;
    }
  };
  // The cache is a convenience: a full disk or a blocked database must not fail a save that reached the server.
  const writeCached = async (key: string, value: unknown) => {
    try {
      await cache.put(key, { origin: deps.origin(), value });
    } catch {
      /* the cache stays as it was */
    }
  };
  const dropCached = async (key: string) => {
    try {
      await cache.delete(key);
    } catch {
      /* the cache stays as it was */
    }
  };

  const infoOf = (t: ServerTemplate): ServerTemplateInfo => {
    const { content: _content, ...info } = t;
    return info;
  };
  const remember = async (t: ServerTemplate) => {
    known.set(t.id, t);
    await writeCached(itemKey(t.id), t);
    const list = ((await readCached<ServerTemplateInfo[]>(listKey())) ?? []).filter((i) => i.id !== t.id);
    await writeCached(listKey(), [infoOf(t), ...list]);
  };
  const forget = async (id: string) => {
    known.delete(id);
    await dropCached(itemKey(id));
    const list = await readCached<ServerTemplateInfo[]>(listKey());
    if (list) await writeCached(listKey(), list.filter((i) => i.id !== id));
  };

  const cachedAll = async (): Promise<ServerTemplate[]> => {
    const infos = (await readCached<ServerTemplateInfo[]>(listKey())) ?? [];
    const items = await Promise.all(infos.map((i) => readCached<ServerTemplate>(itemKey(i.id))));
    return items.flatMap((full, i) => (full ? [{ ...full, canChange: infos[i].canChange }] : []));
  };

  /** What a save changes, as the fields the server takes; null when it changes nothing. */
  const changes = (prior: ServerTemplate, t: CustomTemplate): Partial<TemplateInput> | null => {
    const patch: Partial<TemplateInput> & { teamId?: string | null } = {};
    if (t.name !== prior.name) patch.name = t.name;
    if (t.category !== prior.category) patch.category = t.category;
    if (t.description !== prior.description) patch.description = t.description;
    if (t.scope !== undefined && (t.scope !== prior.scope || (t.scope === 'team' && (t.teamId ?? null) !== prior.teamId))) {
      patch.scope = t.scope;
      if (t.scope === 'team' && t.teamId) patch.teamId = t.teamId;
    }
    if (!sameJson(t.content, prior.content)) patch.content = t.content;
    return Object.keys(patch).length ? patch : null;
  };

  return {
    shared: true,

    async getAll() {
      if (deps.offline()) return cachedAll();
      let infos: ServerTemplateInfo[];
      try {
        infos = await api.listTemplates();
      } catch (e) {
        if (isNetwork(e)) return cachedAll();
        throw e;
      }
      await writeCached(listKey(), infos);
      const out: (ServerTemplate | undefined)[] = [];
      // A template is fetched only when it is new here or has changed since it was cached.
      await eachLimited(infos, FETCH_AT_ONCE, async (info, i) => {
        const hit = await readCached<ServerTemplate>(itemKey(info.id));
        if (hit && hit.updatedAt === info.updatedAt) {
          out[i] = { ...hit, canChange: info.canChange, teamName: info.teamName, ownerName: info.ownerName };
          return;
        }
        try {
          out[i] = await api.getTemplate(info.id);
          await writeCached(itemKey(info.id), out[i]);
        } catch (e) {
          if (isNetwork(e)) out[i] = hit;
        }
      });
      const keep = new Set(infos.map((i) => itemKey(i.id)));
      try {
        for (const key of await cache.keys()) {
          if (key.startsWith(`${deps.origin()}|t|`) && !keep.has(key)) await cache.delete(key);
        }
      } catch {
        /* the cache stays as it was */
      }
      const all = out.filter((t): t is ServerTemplate => t !== undefined);
      known.clear();
      for (const t of all) known.set(t.id, t);
      return all;
    },

    async get(id) {
      if (deps.offline()) return readCached<ServerTemplate>(itemKey(id));
      try {
        const t = await api.getTemplate(id);
        known.set(id, t);
        await writeCached(itemKey(id), t);
        return t;
      } catch (e) {
        if (isNetwork(e)) return readCached<ServerTemplate>(itemKey(id));
        if (isMissing(e)) {
          await forget(id);
          return undefined;
        }
        throw e;
      }
    },

    async put(t) {
      if (deps.offline()) throw new TemplateError(OFFLINE_MESSAGE);
      try {
        const prior = known.get(t.id);
        let saved: ServerTemplate;
        if (prior) {
          const patch = changes(prior, t);
          if (!patch) return prior;
          saved = await api.updateTemplate(prior.id, patch);
        } else {
          saved = await api.createTemplate({
            name: t.name,
            category: t.category,
            description: t.description,
            scope: t.scope ?? 'personal',
            ...(t.scope === 'team' && t.teamId ? { teamId: t.teamId } : {}),
            content: t.content,
          });
        }
        await remember(saved);
        return saved;
      } catch (e) {
        throw failure(e);
      }
    },

    async delete(id) {
      if (deps.offline()) throw new TemplateError(OFFLINE_MESSAGE);
      try {
        await api.deleteTemplate(id);
      } catch (e) {
        // Already gone is what was asked for.
        if (!isMissing(e)) throw failure(e);
      }
      await forget(id);
    },

    async duplicate(id) {
      if (deps.offline()) throw new TemplateError(OFFLINE_MESSAGE);
      try {
        const copy = await api.duplicateTemplate(id);
        await remember(copy);
        return copy;
      } catch (e) {
        throw failure(e);
      }
    },

    notify: bus?.notify,
    onNotify: bus?.onNotify,
  };
}
