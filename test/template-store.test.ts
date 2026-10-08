import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseObj } from '../src/types';
import { MAX_TEMPLATE_OBJECTS, type CustomTemplate } from '../src/custom-templates';
import {
  createTemplateStore, getTemplate, indexedDbBackend, listTemplates, onTemplatesChange, putTemplate, removeTemplate,
  TemplateError, validateTemplate, type TemplateBackend,
} from '../src/template-store';

const sticky = (id: string): BaseObj => ({ id, type: 'sticky', x: 0, y: 0, w: 100, h: 80, rotation: 0, z: '1', text: id });

function template(id: string, updatedAt: number, extra: Partial<CustomTemplate> = {}): CustomTemplate {
  return {
    id, version: 1, name: `Template ${id}`, category: 'Custom', description: '', createdBy: 'u1', createdAt: updatedAt, updatedAt,
    content: { objects: [sticky('o1')], steps: [], bounds: { x: 0, y: 0, w: 100, h: 80 } },
    ...extra,
  };
}

/** Records in a Map, and a bus that tells every other backend on it about a change. */
function memory(bus: Set<() => void> = new Set(), rows = new Map<string, unknown>()) {
  let subscriber: (() => void) | undefined;
  const backend: TemplateBackend = {
    getAll: async () => [...rows.values()],
    get: async (id) => rows.get(id),
    put: async (t) => void rows.set(t.id, structuredClone(t)),
    delete: async (id) => void rows.delete(id),
    notify: () => bus.forEach((fn) => fn !== subscriber && fn()),
    onNotify: (fn) => {
      subscriber = fn;
      bus.add(fn);
      return () => {
        bus.delete(fn);
        subscriber = undefined;
      };
    },
  };
  return { backend, rows, bus };
}

afterEach(() => vi.restoreAllMocks());

describe('template store', () => {
  it('lists newest first, and gets one by id', async () => {
    const store = createTemplateStore(memory().backend);
    await store.put(template('old', 100));
    await store.put(template('new', 300));
    await store.put(template('mid', 200));
    expect((await store.list()).map((t) => t.id)).toEqual(['new', 'mid', 'old']);
    expect((await store.get('mid'))?.name).toBe('Template mid');
    expect(await store.get('missing')).toBeUndefined();
  });

  it('replaces a template saved again under the same id', async () => {
    const store = createTemplateStore(memory().backend);
    await store.put(template('a', 100));
    await store.put(template('a', 200, { name: 'Renamed' }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'Renamed', updatedAt: 200 });
  });

  it('removes a template', async () => {
    const store = createTemplateStore(memory().backend);
    await store.put(template('a', 100));
    await store.put(template('b', 200));
    await store.remove('a');
    expect((await store.list()).map((t) => t.id)).toEqual(['b']);
  });

  it('skips invalid records on every read, with a warning', async () => {
    const { backend, rows } = memory();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.set('good', template('good', 100));
    rows.set('v2', { ...template('v2', 200), version: 2 });
    rows.set('noname', { ...template('noname', 300), name: '' });
    rows.set('badcontent', { ...template('badcontent', 400), content: { objects: 'nope' } });
    rows.set('junk', 'not a template');
    const store = createTemplateStore(backend);
    expect((await store.list()).map((t) => t.id)).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(await store.get('v2')).toBeUndefined();
    expect(await store.get('good')).toBeDefined();
  });

  it('refuses to save an invalid template, and says why', async () => {
    const store = createTemplateStore(memory().backend);
    const bad = template('a', 100);
    bad.content.objects.push(sticky('o1'));
    await expect(store.put(bad)).rejects.toThrow('share the id');
    await expect(store.put(template('b', 1, { name: ' ' }))).rejects.toThrow('name');
    expect(await store.list()).toEqual([]);
  });

  it('refuses a template over the object limit', async () => {
    const store = createTemplateStore(memory().backend);
    const big = template('big', 100);
    big.content.objects = Array.from({ length: MAX_TEMPLATE_OBJECTS + 1 }, (_, i) => sticky(`o${i}`));
    await expect(store.put(big)).rejects.toThrow(String(MAX_TEMPLATE_OBJECTS));
  });

  it('answers a save with the template as kept, and uses the backend\'s own version when it gives one', async () => {
    const { backend } = memory();
    const store = createTemplateStore(backend);
    expect(await store.put(template('a', 100))).toEqual(template('a', 100));
    backend.put = async (t) => ({ ...t, id: 'server-id', scope: 'personal', teamId: null, canChange: true });
    expect(await store.put(template('b', 100))).toMatchObject({ id: 'server-id', scope: 'personal', canChange: true });
  });

  it('keeps the sharing of a template and nothing for one kept in the browser', () => {
    expect(createTemplateStore(null).shared).toBe(false);
    expect(createTemplateStore({ ...memory().backend, shared: true }).shared).toBe(true);
    expect(validateTemplate(template('a', 1, { scope: 'team', teamId: 't1', teamName: 'Design', canChange: false }))).toMatchObject({
      scope: 'team', teamId: 't1', teamName: 'Design', canChange: false,
    });
    expect(validateTemplate(template('a', 1))).not.toHaveProperty('scope');
  });

  it('cannot duplicate where the backend has no way to', async () => {
    const store = createTemplateStore(memory().backend);
    await expect(store.duplicate('a')).rejects.toThrow('Templates cannot be saved here');
  });

  it('shows the message of a TemplateError as it is, and wraps any other failure', async () => {
    const { backend } = memory();
    const store = createTemplateStore(backend);
    backend.put = () => Promise.reject(new TemplateError('You are offline.'));
    backend.delete = () => Promise.reject(new TemplateError('Only admins can delete that.'));
    await expect(store.put(template('a', 1))).rejects.toThrow(/^You are offline\.$/);
    await expect(store.remove('a')).rejects.toThrow(/^Only admins can delete that\.$/);
    backend.delete = () => Promise.reject(new Error('disk on fire'));
    await expect(store.remove('a')).rejects.toThrow('Could not delete the template: disk on fire');
  });

  it('returns nothing, with a warning, when the database cannot be read', async () => {
    const { backend } = memory();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.getAll = () => Promise.reject(new Error('disk on fire'));
    backend.get = () => Promise.reject(new Error('disk on fire'));
    const store = createTemplateStore(backend);
    expect(await store.list()).toEqual([]);
    expect(await store.get('a')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('rejects a write the database refuses, with a readable message and no change event', async () => {
    const { backend } = memory();
    backend.put = () => Promise.reject(new Error('quota exceeded'));
    const store = createTemplateStore(backend);
    const seen = vi.fn<() => void>();
    store.onChange(seen);
    await expect(store.put(template('a', 100))).rejects.toThrow('Could not save the template: quota exceeded');
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('change events', () => {
  it('fire on put and remove in this tab, until unsubscribed', async () => {
    const store = createTemplateStore(memory().backend);
    const seen = vi.fn<() => void>();
    const off = store.onChange(seen);
    await store.put(template('a', 100));
    expect(seen).toHaveBeenCalledTimes(1);
    await store.remove('a');
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    await store.put(template('b', 200));
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('reach other tabs sharing the storage, and not the tab that wrote', async () => {
    const bus = new Set<() => void>();
    const rows = new Map<string, unknown>();
    const a = createTemplateStore(memory(bus, rows).backend);
    const b = createTemplateStore(memory(bus, rows).backend);
    const seenA = vi.fn<() => void>();
    const seenB = vi.fn<() => void>();
    a.onChange(seenA);
    const offB = b.onChange(seenB);
    await a.put(template('x', 100));
    expect(seenA).toHaveBeenCalledTimes(1);
    expect(seenB).toHaveBeenCalledTimes(1);
    expect((await b.list()).map((t) => t.id)).toEqual(['x']);
    await b.remove('x');
    expect(seenA).toHaveBeenCalledTimes(2);
    offB();
    await a.put(template('y', 200));
    expect(seenB).toHaveBeenCalledTimes(2);
  });

  it('listen to other tabs only while somebody is subscribed', () => {
    const { backend, bus } = memory();
    const store = createTemplateStore(backend);
    expect(bus.size).toBe(0);
    const off1 = store.onChange(() => undefined);
    const off2 = store.onChange(() => undefined);
    expect(bus.size).toBe(1);
    off1();
    expect(bus.size).toBe(1);
    off2();
    expect(bus.size).toBe(0);
  });
});

describe('without IndexedDB', () => {
  it('lists nothing, finds nothing, and refuses to save with a readable error', async () => {
    const store = createTemplateStore(null);
    expect(await store.list()).toEqual([]);
    expect(await store.get('a')).toBeUndefined();
    await expect(store.put(template('a', 100))).rejects.toThrow('no IndexedDB');
    await expect(store.remove('a')).rejects.toThrow('no IndexedDB');
  });

  it('is what the default store does where the browser has none', async () => {
    expect(typeof indexedDB).toBe('undefined');
    expect(await listTemplates()).toEqual([]);
    expect(await getTemplate('a')).toBeUndefined();
    await expect(putTemplate(template('a', 100))).rejects.toThrow('no IndexedDB');
    await expect(removeTemplate('a')).rejects.toThrow('no IndexedDB');
    expect(typeof onTemplatesChange(() => undefined)).toBe('function');
  });
});

describe('validateTemplate', () => {
  it('returns a safe copy of a good template', () => {
    const t = template('a', 100, { description: 'Why', category: 'Retrospective' });
    expect(validateTemplate(t)).toEqual(t);
  });

  it('rejects the wrong shape, version, name, category, description and dates', () => {
    const bad = (extra: Record<string, unknown>) => () => validateTemplate({ ...template('a', 100), ...extra });
    expect(() => validateTemplate(null)).toThrow('object');
    expect(bad({ id: '' })).toThrow('id');
    expect(bad({ version: 2 })).toThrow('version');
    expect(bad({ name: 'x'.repeat(81) })).toThrow('name');
    expect(bad({ category: '' })).toThrow('category');
    expect(bad({ category: 'x'.repeat(41) })).toThrow('category');
    expect(bad({ description: 'x'.repeat(281) })).toThrow('description');
    expect(bad({ createdBy: 3 })).toThrow('author');
    expect(bad({ updatedAt: 'now' })).toThrow('dates');
    expect(bad({ content: undefined })).toThrow('content');
  });
});

/** Just enough of IndexedDB for the wrapper: one database, object stores of Maps, requests that answer on a microtask. */
function fakeIndexedDB() {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  const log: string[] = [];
  const request = <T>(run: () => T) => {
    const r: { result?: T; onsuccess?: () => void } = {};
    queueMicrotask(() => {
      r.result = run();
      r.onsuccess?.();
    });
    return r;
  };
  const factory = {
    open(name: string) {
      const req: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = {};
      setTimeout(() => {
        const existing = dbs.get(name);
        const stores = existing ?? new Map<string, Map<string, unknown>>();
        dbs.set(name, stores);
        req.result = {
          createObjectStore: (store: string, opts: { keyPath: string }) => {
            log.push(`store ${store} keyPath ${opts.keyPath}`);
            stores.set(store, new Map());
            return { createIndex: (index: string, path: string) => log.push(`index ${index} on ${path}`) };
          },
          transaction: (store: string, mode: string) => {
            log.push(`${mode} ${store}`);
            const rows = stores.get(store)!;
            const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
              objectStore: () => ({
                getAll: () => request(() => [...rows.values()]),
                get: (id: string) => request(() => rows.get(id)),
                put: (v: { id: string }) => request(() => void rows.set(v.id, structuredClone(v))),
                delete: (id: string) => request(() => void rows.delete(id)),
              }),
            };
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
          },
        };
        if (!existing) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, dbs, log };
}

describe('indexedDbBackend', () => {
  it('creates the templates store keyed by id with an updatedAt index, and stores records', async () => {
    const { factory, dbs, log } = fakeIndexedDB();
    const store = createTemplateStore(indexedDbBackend(factory));
    await store.put(template('a', 100));
    await store.put(template('b', 200));
    expect(log).toContain('store templates keyPath id');
    expect(log).toContain('index updatedAt on updatedAt');
    expect(dbs.has('driftboard:templates')).toBe(true);
    expect((await store.list()).map((t) => t.id)).toEqual(['b', 'a']);
    expect((await store.get('a'))?.name).toBe('Template a');
    await store.remove('a');
    expect((await store.list()).map((t) => t.id)).toEqual(['b']);
  });

  it('opens the database once', async () => {
    const { factory, log } = fakeIndexedDB();
    const store = createTemplateStore(indexedDbBackend(factory));
    await Promise.all([store.list(), store.list(), store.get('a')]);
    expect(log.filter((l) => l.startsWith('store '))).toHaveLength(1);
  });
});
