import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: any) => void;
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

// Loads the real public/sw.js in a sandbox with a fake worker scope and drives its fetch handler.
function load(netResponse: () => unknown) {
  const listeners: Record<string, Listener> = {};
  const stores = new Map<string, Map<string, unknown>>();
  const puts: Array<{ cache: string; key: string }> = [];
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return Promise.resolve({
      put: (k: any, v: unknown) => { const key = typeof k === 'string' ? k : k.url; m.set(key, v); puts.push({ cache: name, key }); return Promise.resolve(); },
      match: (k: any) => Promise.resolve(m.get(typeof k === 'string' ? k : k.url)),
    });
  };
  const sandbox: any = {
    self: { addEventListener: (t: string, fn: Listener) => { listeners[t] = fn; }, location: { origin: 'https://tabula.test' }, skipWaiting() {}, clients: { claim() {} } },
    caches: { open, match: () => Promise.resolve(undefined), keys: () => Promise.resolve([...stores.keys()]), delete: () => Promise.resolve(true) },
    fetch: () => Promise.resolve(netResponse()),
    Response: { error: () => ({ type: 'error', ok: false }) },
    URL,
  };
  vm.runInNewContext(source, sandbox);
  const handle = async (url: string, init: { destination?: string; mode?: string } = {}) => {
    let responded: Promise<unknown> | undefined;
    listeners.fetch({
      request: { method: 'GET', url, destination: init.destination ?? '', mode: init.mode ?? 'no-cors' },
      respondWith: (p: Promise<unknown>) => { responded = p; },
    });
    await responded;
    await new Promise((r) => setTimeout(r, 5));
  };
  return { handle, puts, stores };
}

const res = (status: number, type: string, contentType: string | null, cloneOk = true) => ({
  status, type, ok: status >= 200 && status < 300,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
  clone() { return cloneOk ? this : null; },
});

describe('service worker cache rules', () => {
  it('does not store a 404 html page under a script URL', async () => {
    const sw = load(() => res(404, 'basic', 'text/html'));
    await sw.handle('https://tabula.test/assets/foo.abc123.js', { destination: 'script' });
    expect(sw.puts).toEqual([]);
  });

  it('does not store a 200 html page under a script URL either', async () => {
    const sw = load(() => res(200, 'basic', 'text/html; charset=utf-8'));
    await sw.handle('https://tabula.test/assets/foo.abc123.js', { destination: 'script' });
    expect(sw.puts).toEqual([]);
  });

  it('stores an ok script', async () => {
    const sw = load(() => res(200, 'basic', 'text/javascript; charset=utf-8'));
    await sw.handle('https://tabula.test/assets/foo.abc123.js', { destination: 'script' });
    expect(sw.puts.map((p) => p.key)).toEqual(['https://tabula.test/assets/foo.abc123.js']);
  });

  it('does not store an opaque third-party response', async () => {
    const sw = load(() => res(0, 'opaque', null));
    await sw.handle('https://api.fontshare.com/v2/css?f[]=x', { destination: 'style' });
    expect(sw.puts).toEqual([]);
  });

  it('stores an ok third-party stylesheet', async () => {
    const sw = load(() => res(200, 'cors', 'text/css'));
    await sw.handle('https://api.fontshare.com/v2/css?f[]=x', { destination: 'style' });
    expect(sw.puts.length).toBe(1);
  });

  it('does not let a navigation 500 replace the cached shell', async () => {
    const sw = load(() => res(500, 'basic', 'text/html'));
    await sw.handle('https://tabula.test/b/abc', { destination: 'document', mode: 'navigate' });
    expect(sw.puts).toEqual([]);
  });

  it('replaces the shell with an ok navigation', async () => {
    const sw = load(() => res(200, 'basic', 'text/html'));
    await sw.handle('https://tabula.test/b/abc', { destination: 'document', mode: 'navigate' });
    expect(sw.puts).toEqual([{ cache: expect.stringMatching(/-shell$/), key: '/' }]);
  });

  it('versions its caches per build and keeps a dev fallback', () => {
    expect(source).toContain("'__TABULA_BUILD__'");
    expect(source).toContain("'dev'");
    expect(source).toContain("k !== ICONS");
  });
});
