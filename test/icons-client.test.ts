import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildIcons } from '../scripts/build-icons.mjs';
import { licenceTier as buildTier } from '../scripts/lib/icons-build.mjs';
import { licenceTier } from '../src/icon-licences';
import { OFFLINE_KEY, downloadSets, offlineStates, removeSets } from '../src/icon-offline';
import { collectionIcons, iconData, iconSets, loadPreviews, local, onlineIconSets, previewUrl, resetIconCaches, searchIcons } from '../src/icons';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-icons-client-'));
const dist = path.join(root, 'icons');

const info = (name: string, spdx = 'MIT') => ({ name, license: { title: spdx, spdx }, author: { name: 'Ada', url: 'https://example.com' } });
const path24 = (n: string) => `<path d="${n}"/>`;

beforeAll(async () => {
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'json'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const sets = {
    alpha: {
      prefix: 'alpha', info: info('Alpha'), width: 24, height: 24,
      icons: {
        'arrow-left': { body: path24('al') }, 'arrow-up': { body: path24('au') }, home: { body: path24('h') }, wide: { body: path24('w'), width: 32, left: -2 },
        extra: { body: '<path d="x"/>' },
      },
      aliases: { back: { parent: 'arrow-left' }, 'arrow-right': { parent: 'arrow-left', hFlip: true } },
      categories: { Navigation: ['home', 'arrow-up'] },
    },
    beta: { prefix: 'beta', info: info('Beta', 'CC-BY-4.0'), width: 16, height: 16, icons: { 'arrow-down': { body: path24('ad') }, star: { body: path24('s') } } },
  };
  for (const [p, v] of Object.entries(sets)) fs.writeFileSync(path.join(source, 'json', `${p}.json`), JSON.stringify(v));
  await buildIcons({ source, out: dist, shardIcons: 2, pinned: ['alpha:home', 'alpha:back'], priority: ['alpha', 'beta'] });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const gz = (file: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString());
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let calls: string[];
let override: ((url: string) => Response | Promise<Response> | undefined) | null;

/** Serves dist/icons the way the relay does (without the .gz) and counts what is asked. */
const serve = (url: string): Response => {
  const file = path.join(dist, url.slice('/icons/'.length));
  if (!fs.existsSync(`${file}.gz`)) return new Response('missing', { status: 404 });
  return jsonResponse(gz(file));
};

const iconify = (url: string) => (/^\/collections$/.test(new URL(url).pathname) ? jsonResponse({}) : jsonResponse({ icons: [] }));

beforeEach(() => {
  resetIconCaches();
  calls = [];
  override = null;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    calls.push(input);
    const forced = override?.(input);
    if (forced) return forced;
    return input.startsWith('/icons/') ? serve(input) : iconify(input);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const iconifyCalls = () => calls.filter((u) => !u.startsWith('/icons/'));

describe('hosted sets', () => {
  it('lists the manifest sets with licence class and sizes, without asking Iconify', async () => {
    const sets = await iconSets();
    expect(Object.keys(sets)).toEqual(['alpha', 'beta']);
    expect(sets.alpha).toMatchObject({ name: 'Alpha', total: 6, license: 'MIT', tier: 'notice', hosted: true, attribution: false, author: 'Ada' });
    expect(sets.beta).toMatchObject({ attribution: true, tier: 'attribution' });
    expect(sets.alpha.gzBytes).toBeGreaterThan(0);
    expect(iconifyCalls()).toEqual([]);
  });

  it('returns a body with the set defaults, an own box, and resolves aliases', async () => {
    expect(await iconData('alpha:home')).toEqual({ body: path24('h'), width: 24, height: 24, left: 0, top: 0 });
    expect(await iconData('alpha:wide')).toEqual({ body: path24('w'), width: 32, height: 24, left: -2, top: 0 });
    expect(await iconData('alpha:back')).toEqual({ body: path24('al'), width: 24, height: 24, left: 0, top: 0 });
    expect((await iconData('alpha:arrow-right')).body).toContain('scale(-1 1)');
    expect(iconifyCalls()).toEqual([]);
  });

  it('throws for an icon the set does not have', async () => {
    await expect(iconData('alpha:nope')).rejects.toThrow('Icon alpha:nope not found');
  });

  it('makes no request to an Iconify host for a hosted prefix, and does for an online one', async () => {
    await searchIcons('arrow', 'alpha');
    await collectionIcons('beta');
    await iconData('beta:star');
    await searchIcons('arrow');
    expect(iconifyCalls()).toEqual([]);
    await searchIcons('star', 'fa', 20);
    await collectionIcons('fa', 20);
    expect(iconifyCalls().map((u) => new URL(u).pathname)).toEqual(['/search', '/collection']);
  });

  it('browses a set in its own order and searches names, aliases and categories', async () => {
    expect(await collectionIcons('alpha')).toEqual(['alpha:home', 'alpha:arrow-up', 'alpha:arrow-left', 'alpha:arrow-right', 'alpha:extra', 'alpha:wide']);
    expect(await searchIcons('back', 'alpha')).toEqual(['alpha:arrow-left']);
    expect(await searchIcons('navigation', 'alpha')).toEqual(['alpha:home', 'alpha:arrow-up']);
    expect(await searchIcons('arrow')).toEqual(['alpha:arrow-up', 'alpha:arrow-left', 'beta:arrow-down', 'alpha:arrow-right']);
  });

  it('fetches a shard once however many icons ask for it', async () => {
    await Promise.all([iconData('alpha:home'), iconData('alpha:arrow-up'), iconData('alpha:arrow-left')]);
    const shards = calls.filter((u) => u.startsWith('/icons/s/'));
    expect(new Set(shards).size).toBe(shards.length);
  });

  it('fetches the manifest again and retries once when a hashed file is gone after a deploy', async () => {
    await iconData('alpha:home');
    const stale = calls.find((u) => u.startsWith('/icons/s/alpha.'))!;
    resetIconCaches();
    calls = [];
    let first = true;
    override = (url) => {
      if (url === '/icons/manifest.json' && first) {
        first = false;
        const m = gz(path.join(dist, 'manifest.json'));
        m.sets[0].idx = 'deadbeef';
        return jsonResponse(m);
      }
      return undefined;
    };
    expect(await iconData('alpha:home')).toMatchObject({ body: path24('h') });
    expect(calls.filter((u) => u === '/icons/manifest.json')).toHaveLength(2);
    expect(calls).toContain('/icons/i/alpha.deadbeef.json');
    expect(stale).toMatch(/^\/icons\/s\/alpha\./);
  });
});

describe('failures of our own server', () => {
  it('rejects an HTML body served with status 200', async () => {
    override = () => new Response('<!doctype html><title>app</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(local('manifest.json')).rejects.toMatchObject({ failure: { kind: 'other' } });
    await expect(iconSets()).rejects.toMatchObject({ failure: { kind: 'other' } });
  });

  it('rejects a 404, a 500 and a network error with a kind the drawer can show', async () => {
    override = () => new Response('', { status: 404 });
    await expect(local('s/x.json')).rejects.toMatchObject({ failure: { kind: 'other' }, status: 404 });
    override = () => new Response('', { status: 503 });
    await expect(local('s/x.json')).rejects.toMatchObject({ failure: { kind: 'server' } });
    override = () => { throw new TypeError('Failed to fetch'); };
    await expect(local('s/x.json')).rejects.toMatchObject({ failure: { kind: 'unreachable' } });
  });

  it('never falls back to Iconify for a hosted set when our server fails', async () => {
    override = (url) => (url.startsWith('/icons/s/') ? new Response('', { status: 500 }) : undefined);
    await expect(iconData('alpha:home')).rejects.toMatchObject({ failure: { kind: 'server' } });
    expect(iconifyCalls()).toEqual([]);
  });
});

describe('aborting', () => {
  it('makes no request when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(iconData('alpha:home', ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(local('manifest.json', ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('cancels the request in flight when its only caller aborts', async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      seen.push(init.signal!);
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const ctl = new AbortController();
    const pending = iconData('alpha:home', ctl.signal);
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen[0].aborted).toBe(true);
  });

  it('keeps a shared request alive for the caller that stays', async () => {
    const stay = new AbortController();
    const leave = new AbortController();
    const a = iconSets(stay.signal);
    const b = iconSets(leave.signal);
    leave.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(Object.keys(await a)).toEqual(['alpha', 'beta']);
    expect(calls.filter((u) => u === '/icons/manifest.json')).toHaveLength(1);
  });

  it('starts no shard request for loads aborted before the manifest arrived', async () => {
    const ctl = new AbortController();
    const names = ['alpha:home', 'alpha:wide', 'alpha:arrow-up', 'beta:star', 'beta:arrow-down', 'alpha:extra', 'alpha:back'];
    const loads = names.map((n) => loadPreviews([n], ctl.signal).catch((e) => e));
    ctl.abort();
    const results = await Promise.all(loads);
    expect(results.every((r) => r instanceof DOMException)).toBe(true);
    expect(calls.filter((u) => u.startsWith('/icons/s/'))).toEqual([]);
  });
});

describe('previews', () => {
  it('builds a data URL with the view box from the shard and strips scripts', async () => {
    await loadPreviews(['alpha:wide', 'alpha:home']);
    const url = previewUrl('alpha:wide');
    expect(url.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(url.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('viewBox="-2 0 32 24"');
    expect(svg).toContain(path24('w'));
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('removes executable markup from a hosted body', async () => {
    override = (url) => {
      if (!url.startsWith('/icons/s/alpha.')) return undefined;
      return jsonResponse({ h: 24, w: 24, i: { 'arrow-up': '<script>alert(1)</script><path d="ok"/>' } });
    };
    await loadPreviews(['alpha:arrow-up']);
    const svg = decodeURIComponent(previewUrl('alpha:arrow-up').slice('data:image/svg+xml,'.length));
    expect(svg).not.toContain('<script');
    expect(svg).toContain('<path d="ok"/>');
  });

  it('calls back for each icon as its shard arrives, six requests at a time at most', async () => {
    const got: string[] = [];
    let open = 0, most = 0;
    const real = (globalThis.fetch as unknown as (u: string) => Promise<Response>);
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 2));
      open--;
      return real(u);
    }));
    await loadPreviews(['alpha:home', 'alpha:wide', 'alpha:arrow-up', 'alpha:extra', 'beta:star', 'beta:arrow-down'], undefined, (n) => got.push(n));
    expect(got.sort()).toEqual(['alpha:arrow-up', 'alpha:extra', 'alpha:home', 'alpha:wide', 'beta:arrow-down', 'beta:star']);
    expect(most).toBeLessThanOrEqual(6);
  });

  it('returns Iconify image URLs for sets we do not host, with no request', async () => {
    await iconSets();
    calls = [];
    await loadPreviews(['fa:star']);
    expect(previewUrl('fa:star')).toMatch(/^https:\/\/api\..*\/fa\/star\.svg\?height=28$/);
    expect(calls).toEqual([]);
  });

  it('loads the pinned bodies with one request', async () => {
    await loadPreviews(['alpha:home', 'alpha:back']);
    expect(calls.filter((u) => u.startsWith('/icons/pin.'))).toHaveLength(1);
    expect(calls.filter((u) => u.startsWith('/icons/s/'))).toHaveLength(0);
    expect(previewUrl('alpha:back')).toContain('data:image/svg+xml');
    expect(await iconData('alpha:back')).toMatchObject({ body: path24('al') });
  });
});

describe('online sets', () => {
  it('lists only sets we do not host whose licence is allowed', async () => {
    override = (url) => (url.endsWith('/collections') ? jsonResponse({
      alpha: { name: 'Alpha', total: 6, license: { title: 'MIT', spdx: 'MIT' } },
      fa: { name: 'Font Awesome', total: 10, license: { title: 'CC BY 4.0', spdx: 'CC-BY-4.0', url: 'https://example.com/by' }, author: { name: 'Dave' } },
      nc: { name: 'Non commercial', total: 3, license: { title: 'CC BY-NC 4.0', spdx: 'CC-BY-NC-4.0' } },
      sa: { name: 'Share alike', total: 3, license: { title: 'CC BY-SA 4.0', spdx: 'CC-BY-SA-4.0' } },
      gpl: { name: 'GPL', total: 3, license: { title: 'GPL', spdx: 'GPL-3.0-only' } },
      none: { name: 'No licence', total: 3 },
      secret: { name: 'Hidden', total: 3, hidden: true, license: { title: 'MIT', spdx: 'MIT' } },
      ok: { name: 'OK', total: 1, license: { title: 'MIT', spdx: 'MIT' } },
    }) : undefined);
    const online = await onlineIconSets();
    expect(Object.keys(online).sort()).toEqual(['fa', 'ok']);
    expect(online.fa).toMatchObject({ hosted: false, attribution: true, tier: 'attribution', licenseUrl: 'https://example.com/by', author: 'Dave' });
  });

  it('makes no request to Iconify until the list is asked for', async () => {
    await iconSets();
    expect(iconifyCalls()).toEqual([]);
  });
});

describe('licence rule shared with the build', () => {
  const table = [
    'CC0-1.0', 'Unlicense', '0BSD', 'MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'OFL-1.1', 'CC-BY-3.0', 'CC-BY-4.0',
    'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-SA-4.0', 'CC-BY-SA-3.0', 'GPL-2.0-only', 'GPL-3.0-or-later', 'LGPL-2.1', 'AGPL-3.0', 'MPL-2.0', 'EPL-2.0',
    'MIT OR Apache-2.0', 'mit', 'Custom', '', undefined,
  ];

  it('gives the same answer for every id', () => {
    expect(table.map((id) => licenceTier(id))).toEqual(table.map((id) => buildTier(id)));
  });

  it('gives the same answer for a title that says NonCommercial', () => {
    const titles = ['CC BY-NC 4.0', 'Creative Commons Attribution NonCommercial', 'Attribution Non-Commercial', 'MIT', undefined];
    expect(titles.map((t) => licenceTier('CC-BY-4.0', t))).toEqual(titles.map((t) => buildTier('CC-BY-4.0', t)));
    expect(titles.map((t) => licenceTier('CC-BY-4.0', t))).toEqual([null, null, null, 'attribution', 'attribution']);
  });
});

describe('offline sets', () => {
  const store = new Map<string, Response>();
  const fakeCaches = {
    open: async () => ({
      keys: async () => [...store.keys()].map((url) => ({ url: `http://localhost${url}` }) as Request),
      match: async (url: string) => store.get(url)?.clone(),
      put: async (url: string, res: Response) => { store.set(url, res); },
      delete: async (req: Request) => store.delete(new URL(req.url).pathname),
    }),
  } as unknown as CacheStorage;
  const list = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    list.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => list.get(k) ?? null, setItem: (k: string, v: string) => list.set(k, v) });
    vi.stubGlobal('caches', fakeCaches);
  });

  const states = async () => {
    const manifest = gz(path.join(dist, 'manifest.json')).sets;
    return offlineStates(manifest.map((s: { p: string; idx: string }) => ({ prefix: s.p, idx: s.idx })), fakeCaches);
  };

  it('starts with nothing stored, downloads a whole set, and removes it', async () => {
    expect(await states()).toEqual({ alpha: 'none', beta: 'none' });
    const progress: number[] = [];
    await downloadSets(['alpha'], { storage: fakeCaches, onProgress: (done) => progress.push(done) });
    expect(await states()).toEqual({ alpha: 'ready', beta: 'none' });
    expect(progress.at(0)).toBe(0);
    expect(progress.at(-1)).toBe([...store.keys()].filter((k) => k.includes('/alpha.')).length);
    expect(JSON.parse(list.get(OFFLINE_KEY)!)).toEqual(['alpha']);
    const before = calls.length;
    await downloadSets(['alpha'], { storage: fakeCaches });
    expect(calls.length - before).toBeLessThanOrEqual(1);
    await removeSets(['alpha'], fakeCaches);
    expect(await states()).toEqual({ alpha: 'none', beta: 'none' });
    expect(store.size).toBe(0);
    expect(JSON.parse(list.get(OFFLINE_KEY)!)).toEqual([]);
  });

  it('is not ready while one shard is missing', async () => {
    await downloadSets(['alpha'], { storage: fakeCaches });
    store.delete([...store.keys()].find((k) => k.startsWith('/icons/s/alpha.'))!);
    expect((await states()).alpha).toBe('none');
  });

  it('reports an update for a downloaded set whose index changed, and an update drops the old files', async () => {
    await downloadSets(['beta'], { storage: fakeCaches });
    const oldIndex = [...store.keys()].find((k) => k.startsWith('/icons/i/beta.'))!;
    const manifest = gz(path.join(dist, 'manifest.json')).sets;
    const stale = manifest.map((s: { p: string; idx: string }) => ({ prefix: s.p, idx: s.p === 'beta' ? 'feedface' : s.idx }));
    expect((await offlineStates(stale, fakeCaches)).beta).toBe('update');
    store.set('/icons/s/beta.9.oldoldol.json', jsonResponse({}));
    await downloadSets(['beta'], { storage: fakeCaches });
    expect(store.has('/icons/s/beta.9.oldoldol.json')).toBe(false);
    expect(store.has(oldIndex)).toBe(true);
  });

  it('does not touch the files of a set whose prefix starts the same', async () => {
    store.set('/icons/s/alpha-two.0.abcdef01.json', jsonResponse({}));
    await downloadSets(['alpha'], { storage: fakeCaches });
    await removeSets(['alpha'], fakeCaches);
    expect(store.has('/icons/s/alpha-two.0.abcdef01.json')).toBe(true);
  });

  it('stops with a message when the device has too little free storage', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 1000, usage: 900 }) } });
    await expect(downloadSets(['alpha'], { storage: fakeCaches })).rejects.toThrow('not enough free storage');
    expect(store.size).toBe(0);
  });

  it('keeps going from where it stopped after a cancel', async () => {
    const real = globalThis.fetch as unknown as (u: string) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 3));
      init?.signal?.throwIfAborted();
      return real(u);
    }));
    const ctl = new AbortController();
    await expect(downloadSets(['alpha'], {
      storage: fakeCaches, signal: ctl.signal,
      onProgress: (done) => { if (done >= 2) ctl.abort(); },
    })).rejects.toBeDefined();
    expect((await states()).alpha).toBe('none');
    vi.stubGlobal('fetch', real);
    await downloadSets(['alpha'], { storage: fakeCaches });
    expect((await states()).alpha).toBe('ready');
  });
});
