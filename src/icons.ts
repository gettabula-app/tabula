// Icon sets: search, browse and fetch icon data. The sets Tabula hosts come from its own server (/icons/, built by
// scripts/build-icons.mjs, docs/icons-selfhost.md); the Iconify API is only the online fallback for sets it does not
// host. Placed icons store their SVG body in the board, so they render offline forever after.
import { licenceTier, type LicenceTier } from './icon-licences';
import { searchSets, type SearchSet } from './icon-search';
import { sanitizeSvgBody } from './markup';
import { DEMO } from './demo';

const HOSTS = ['https://api.iconify.design', 'https://api.simplesvg.com', 'https://api.unisvg.com'];
let host = HOSTS[0];
export const iconAssetUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;

export interface IconSet {
  prefix: string; name: string; total: number; license: string; licenseUrl?: string; attribution: boolean; category?: string;
  hosted: boolean; tier: LicenceTier; author?: string; authorUrl?: string; gzBytes?: number; rawBytes?: number;
  /** A set of brand logos: the licence covers the artwork, not the marks. */
  logos?: boolean;
}
export interface IconData { body: string; width: number; height: number; left: number; top: number }

const HOST_KEY = 'driftboard:iconify-host';
export function setIconHost(url: string) {
  if (url) localStorage.setItem(HOST_KEY, url.replace(/\/+$/, ''));
  else localStorage.removeItem(HOST_KEY);
}
const custom = () => (typeof localStorage !== 'undefined' ? localStorage.getItem(HOST_KEY) : null);

export type IconFailure =
  | { kind: 'offline' }
  | { kind: 'rate-limited'; retryAfter?: number }
  | { kind: 'unreachable' }
  | { kind: 'server' }
  | { kind: 'other' };

/** A failed icon request, classified by the final host that was tried. `status` is the HTTP status when a response arrived. */
export class IconError extends Error {
  failure: IconFailure;
  status?: number;

  constructor(failure: IconFailure, status?: number) {
    super(`Icon request failed (${failure.kind})`);
    this.failure = failure;
    this.status = status;
  }
}

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Retry-After in seconds, from delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Why a request failed. `status` is set when a response arrived. Offline means the browser says so. A network error
 * while it reports online is 'unreachable': Iconify's 429s carry no CORS header, so browsers report them that way.
 */
export function classifyIconFailure(f: { status?: number; retryAfter?: string | null; error?: unknown; online: boolean }, now = Date.now()): IconFailure {
  if (!f.online) return { kind: 'offline' };
  if (f.status === 429) return { kind: 'rate-limited', retryAfter: parseRetryAfter(f.retryAfter, now) };
  if (f.status !== undefined && f.status >= 500 && f.status < 600) return { kind: 'server' };
  if (f.status === undefined && f.error instanceof TypeError) return { kind: 'unreachable' };
  return { kind: 'other' };
}

/** The failure behind a rejected drawer query. */
export function failureOf(e: unknown): IconFailure {
  return e instanceof IconError ? e.failure : classifyIconFailure({ error: e, online: isOnline() });
}

/** What the drawer says about a failed load. */
export function failureMessage(f: IconFailure): string {
  if (f.kind === 'offline') return "You're offline. Icons load again when you reconnect.";
  if (f.kind === 'unreachable') return 'The icon service is not responding right now. Trying again shortly.';
  if (f.kind === 'rate-limited') {
    const n = f.retryAfter;
    return n ? `The icon service is busy. Try again in ${n} second${n === 1 ? '' : 's'}.` : 'The icon service is busy. Try again in a moment.';
  }
  return 'Icons could not be loaded.';
}

const RATE_LIMIT_CAP_MS = 60_000;
const RATE_LIMIT_FALLBACK_MS = 10_000;

/** Wait before the one automatic retry of a failed load that may clear by itself: Retry-After capped at 60 s, or 10 s when unknown. */
export function autoRetryDelay(retryAfter?: number): number {
  return retryAfter === undefined ? RATE_LIMIT_FALLBACK_MS : Math.min(retryAfter * 1000, RATE_LIMIT_CAP_MS);
}

function autoRetryWait(f: IconFailure): number | null {
  if (f.kind === 'rate-limited') return autoRetryDelay(f.retryAfter);
  if (f.kind === 'unreachable') return autoRetryDelay();
  return null;
}

/** Fetch from the Iconify API, failing over to its backup hosts after 750 ms. A caller's abort ends the request without failover. */
async function api(path: string, signal?: AbortSignal): Promise<unknown> {
  if (DEMO) throw new Error('This icon set is not included in the demo.');
  const hosts = custom() ? [custom()!] : [host, ...HOSTS.filter((h) => h !== host)];
  let failure: IconFailure = { kind: 'other' };
  signal?.throwIfAborted();
  for (const h of hosts) {
    signal?.throwIfAborted();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), h === hosts[0] ? 2500 : 4000);
    const cancel = () => ctrl.abort();
    signal?.addEventListener('abort', cancel);
    try {
      const res = await fetch(h + path, { signal: ctrl.signal });
      if (res.ok) {
        host = h;
        return await res.json();
      }
      failure = classifyIconFailure({ status: res.status, retryAfter: res.headers.get('Retry-After'), online: isOnline() });
    } catch (e) {
      if (signal?.aborted) throw e;
      failure = classifyIconFailure({ error: e, online: isOnline() });
    } finally {
      clearTimeout(t);
      signal?.removeEventListener('abort', cancel);
    }
  }
  throw new IconError(failure);
}

export const POPULAR_SETS = ['lucide', 'tabler', 'ph', 'mdi', 'material-symbols', 'carbon', 'heroicons', 'logos', 'simple-icons', 'fluent-emoji-flat', 'twemoji', 'devicon'];

// ---------------------------------------------------------------- our own server

/** Fetch `/icons/<path>` and parse it. Anything but a 200 with JSON in it is an error, never an HTML page. */
export async function local(path: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  let res: Response;
  try {
    res = await fetch(iconAssetUrl(`icons/${path}`), { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new IconError(classifyIconFailure({ error: e, online: isOnline() }));
  }
  if (res.status !== 200) throw new IconError(classifyIconFailure({ status: res.status, retryAfter: res.headers.get('Retry-After'), online: isOnline() }), res.status);
  try {
    return await res.json();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new IconError({ kind: 'other' }, res.status);
  }
}

interface ManifestSet {
  p: string; name: string; n: number; cat?: string; tm?: boolean;
  lic: { id: string; title: string; url?: string; tier: LicenceTier };
  au?: { name: string; url?: string };
  idx: string; sh: number; gz: number; raw: number;
}
interface Manifest { v: number; sets: ManifestSet[]; pin?: { f: string; names: string[] } }
interface IconIndex { n: string[]; a: [string, number][]; c?: Record<string, number[]>; sh: [string, number][] }
type ShardEntry = string | { b: string; w?: number; h?: number; l?: number; t?: number };
interface Shard { w: number; h: number; l?: number; t?: number; i: Record<string, ShardEntry> }
interface LoadedIndex extends IconIndex {
  set: ManifestSet;
  starts: number[];
  search: SearchSet;
  pos?: Map<string, number>;
  alias?: Map<string, number>;
}

const SHARD_LIMIT = 64;
const PREVIEW_LIMIT = 1200;
const FETCH_SLOTS = 6;

let manifest: Manifest | null = null;
let hosted = new Map<string, ManifestSet>();
const indexes = new Map<string, LoadedIndex>();
const shards = new Map<string, Shard>();
const previews = new Map<string, string>();
const pins = new Map<string, IconData>();
const dataCache = new Map<string, IconData>();
let pinState: 'idle' | 'loaded' = 'idle';

/** Forgets everything loaded; for tests. */
export function resetIconCaches() {
  manifest = null;
  hosted = new Map();
  indexes.clear();
  shards.clear();
  previews.clear();
  pins.clear();
  dataCache.clear();
  flights.clear();
  pinState = 'idle';
  host = HOSTS[0];
}

interface Flight<T> { promise: Promise<T>; ctl: AbortController; waiters: number }
const flights = new Map<string, Flight<unknown>>();

/**
 * One request for everyone who asks for `key` at once. Each caller can abort on its own; the request itself
 * is aborted when the last caller has.
 */
function shared<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let flight = flights.get(key) as Flight<T> | undefined;
  if (!flight) {
    const ctl = new AbortController();
    const made: Flight<T> = { ctl, waiters: 0, promise: load(ctl.signal) };
    flight = made;
    flights.set(key, made);
    const clear = () => { if (flights.get(key) === made) flights.delete(key); };
    made.promise.then(clear, clear);
  }
  const f = flight;
  f.waiters++;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (--f.waiters === 0) {
        f.ctl.abort();
        if (flights.get(key) === f) flights.delete(key);
      }
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    f.promise.then(
      (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

let active = 0;
const waiting: (() => void)[] = [];

/** Runs `task` when one of six request slots is free, so a screen of previews does not open hundreds of connections. */
export async function slot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (active < FETCH_SLOTS) active++;
  else {
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => { waiting.splice(waiting.indexOf(go), 1); reject(signal!.reason); };
      waiting.push(go);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

function loadManifest(signal?: AbortSignal, fresh = false): Promise<Manifest> {
  if (manifest && !fresh) return Promise.resolve(manifest);
  return shared('manifest', async (s) => {
    const m = (await local('manifest.json', s)) as Manifest;
    if (!m || !Array.isArray(m.sets)) throw new IconError({ kind: 'other' });
    manifest = m;
    hosted = new Map(m.sets.map((x) => [x.p, x]));
    return m;
  }, signal);
}

async function isHosted(prefix: string, signal?: AbortSignal): Promise<boolean> {
  await loadManifest(signal);
  return hosted.has(prefix);
}

/**
 * Runs `work` for a hosted set. After a deploy the hashed files of an old manifest are gone and answer 404:
 * the manifest is fetched again and `work` runs once more against it.
 */
async function withRefresh<T>(prefix: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof IconError) || e.status !== 404) throw e;
    await loadManifest(signal, true);
    if (!hosted.has(prefix)) throw e;
    return work();
  }
}

function loadIndex(prefix: string, signal?: AbortSignal): Promise<LoadedIndex> {
  return withRefresh(prefix, signal, async () => {
    await loadManifest(signal);
    const set = hosted.get(prefix);
    if (!set) throw new Error(`Icon set ${prefix} is not hosted`);
    const key = `${prefix}.${set.idx}`;
    const hit = indexes.get(key);
    if (hit) return hit;
    return shared(`i/${key}`, async (s) => {
      const raw = (await slot(() => local(`i/${key}.json`, s), s)) as IconIndex;
      const starts: number[] = [];
      let at = 0;
      for (const [, count] of raw.sh) {
        starts.push(at);
        at += count;
      }
      const loaded: LoadedIndex = { ...raw, set, starts, search: { prefix, names: raw.n, aliases: raw.a, categories: raw.c } };
      indexes.set(key, loaded);
      return loaded;
    }, signal);
  });
}

const positionOf = (ix: LoadedIndex, name: string): number => {
  ix.pos ??= new Map(ix.n.map((n, i) => [n, i]));
  const at = ix.pos.get(name);
  if (at !== undefined) return at;
  ix.alias ??= new Map(ix.a);
  return ix.alias.get(name) ?? -1;
};

const shardOf = (ix: LoadedIndex, i: number): number => {
  let lo = 0, hi = ix.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ix.starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

function loadShard(prefix: string, ix: LoadedIndex, n: number, signal?: AbortSignal): Promise<Shard> {
  const key = `${prefix}.${n}.${ix.sh[n][0]}`;
  const hit = shards.get(key);
  if (hit) {
    shards.delete(key);
    shards.set(key, hit);
    return Promise.resolve(hit);
  }
  return shared(`s/${key}`, async (s) => {
    const shard = (await slot(() => local(`s/${key}.json`, s), s)) as Shard;
    shards.set(key, shard);
    while (shards.size > SHARD_LIMIT) shards.delete(shards.keys().next().value!);
    return shard;
  }, signal);
}

function shardIcon(shard: Shard, name: string): IconData {
  const e = shard.i[name];
  const body = typeof e === 'string' ? e : e.b;
  if (typeof e === 'string') return { body, width: shard.w, height: shard.h, left: shard.l ?? 0, top: shard.t ?? 0 };
  return { body, width: e.w ?? shard.w, height: e.h ?? shard.h, left: e.l ?? shard.l ?? 0, top: e.t ?? shard.t ?? 0 };
}

async function loadPins(signal?: AbortSignal): Promise<void> {
  const m = await loadManifest(signal);
  if (!m.pin || pinState === 'loaded') return;
  await shared('pin', async (s) => {
    const raw = (await slot(() => local(`pin.${m.pin!.f}.json`, s), s)) as Record<string, { b: string; w: number; h: number; l?: number; t?: number }>;
    for (const [full, e] of Object.entries(raw)) pins.set(full, { body: e.b, width: e.w, height: e.h, left: e.l ?? 0, top: e.t ?? 0 });
    pinState = 'loaded';
  }, signal);
}

const split = (full: string): [string, string] => {
  const at = full.indexOf(':');
  return [full.slice(0, at), full.slice(at + 1)];
};

const toSet = (s: ManifestSet): IconSet => ({
  prefix: s.p, name: s.name, total: s.n, license: s.lic.id, licenseUrl: s.lic.url, category: s.cat, attribution: s.lic.tier === 'attribution',
  hosted: true, tier: s.lic.tier, author: s.au?.name, authorUrl: s.au?.url, gzBytes: s.gz, rawBytes: s.raw, logos: s.tm,
});

/** The sets Tabula hosts, in the manifest's order (popular sets first). Makes no request to Iconify. */
export async function iconSets(signal?: AbortSignal): Promise<Record<string, IconSet>> {
  const m = await loadManifest(signal);
  return Object.fromEntries(m.sets.map((s) => [s.p, toSet(s)]));
}

/** The manifest's sets with their sizes, for the offline downloads. */
export async function hostedSets(signal?: AbortSignal): Promise<{ prefix: string; name: string; gz: number; raw: number; idx: string }[]> {
  const m = await loadManifest(signal);
  return m.sets.map((s) => ({ prefix: s.p, name: s.name, gz: s.gz, raw: s.raw, idx: s.idx }));
}

/** The URLs of a hosted set's index and of every shard in it. */
export async function setFiles(prefix: string, signal?: AbortSignal): Promise<string[]> {
  const ix = await loadIndex(prefix, signal);
  return [iconAssetUrl(`icons/i/${prefix}.${ix.set.idx}.json`), ...ix.sh.map(([hash], n) => iconAssetUrl(`icons/s/${prefix}.${n}.${hash}.json`))];
}

// ---------------------------------------------------------------- the Iconify API, for sets we do not host

type Collection = { name: string; total: number; hidden?: boolean; author?: { name: string; url?: string }; license?: { title: string; url?: string; spdx?: string }; category?: string };

/**
 * Sets Iconify lists that Tabula does not host and whose licence it allows. Only called when the person asks for
 * them, because opening the list is the first request to Iconify.
 */
export async function onlineIconSets(signal?: AbortSignal): Promise<Record<string, IconSet>> {
  if (DEMO) return {};
  await loadManifest(signal);
  const raw = (await api('/collections', signal)) as Record<string, Collection>;
  const out: Record<string, IconSet> = {};
  for (const [prefix, v] of Object.entries(raw)) {
    const tier = licenceTier(v.license?.spdx, v.license?.title);
    if (hosted.has(prefix) || v.hidden || !tier) continue;
    out[prefix] = {
      prefix, name: v.name, total: v.total, license: v.license?.spdx ?? '', licenseUrl: v.license?.url, category: v.category,
      attribution: tier === 'attribution', hosted: false, tier, author: v.author?.name, authorUrl: v.author?.url,
    };
  }
  return out;
}

async function apiSearch(query: string, prefix: string | undefined, limit: number, signal?: AbortSignal): Promise<string[]> {
  const q = encodeURIComponent(query.trim());
  const p = prefix ? `&prefix=${encodeURIComponent(prefix)}` : '';
  const res = (await api(`/search?query=${q}&limit=${limit}${p}`, signal)) as { icons: string[] };
  return res.icons || [];
}

async function apiCollection(prefix: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  const res = (await api(`/collection?prefix=${encodeURIComponent(prefix)}`, signal)) as {
    uncategorized?: string[]; categories?: Record<string, string[]>;
  };
  const names = [...(res.uncategorized || []), ...Object.values(res.categories || {}).flat()];
  return [...new Set(names)].slice(0, limit).map((n) => `${prefix}:${n}`);
}

async function apiIconData(full: string, signal?: AbortSignal): Promise<IconData> {
  const [prefix, name] = split(full);
  const res = (await api(`/${encodeURIComponent(prefix)}.json?icons=${encodeURIComponent(name)}`, signal)) as {
    icons: Record<string, Partial<IconData>>; aliases?: Record<string, { parent: string }>;
    width?: number; height?: number; left?: number; top?: number;
  };
  let icon = res.icons?.[name];
  if (!icon && res.aliases?.[name]) icon = res.icons?.[res.aliases[name].parent];
  if (!icon?.body) throw new Error(`Icon ${full} not found`);
  return {
    body: icon.body,
    width: icon.width ?? res.width ?? 16,
    height: icon.height ?? res.height ?? 16,
    left: icon.left ?? res.left ?? 0,
    top: icon.top ?? res.top ?? 0,
  };
}

// ---------------------------------------------------------------- search, browse, data

const FIRST_BATCH = POPULAR_SETS.length;
const BACKGROUND_BATCH = 24;

/**
 * Icons matching `query` as `prefix:name`. With a prefix, that set only (hosted sets locally, other sets through
 * Iconify). Without one, every hosted set: the best `limit` results, at most limit/6 from one set. The popular sets'
 * indexes come first; with `onUpdate` the result returns once they are in and the rest of the sets are searched
 * as their indexes arrive, calling `onUpdate` with each improved list. Without `onUpdate` every set is waited for.
 */
export async function searchIcons(query: string, prefix?: string, limit = 96, signal?: AbortSignal, onUpdate?: (names: string[]) => void): Promise<string[]> {
  const q = query.trim();
  if (prefix) {
    if (!(await isHosted(prefix, signal))) return DEMO ? [] : apiSearch(q, prefix, limit, signal);
    const ix = await loadIndex(prefix, signal);
    return searchSets([ix.search], q, { limit });
  }
  const m = await loadManifest(signal);
  const order = m.sets.map((s) => s.p);
  const perSet = Math.max(8, Math.ceil(limit / 6));
  const loaded = new Map<string, SearchSet>();
  const run = () => searchSets(order.flatMap((p) => loaded.get(p) ?? []), q, { limit, perSet });
  const load = async (prefixes: string[], strict: boolean) => {
    const done = await Promise.allSettled(prefixes.map((p) => loadIndex(p, signal)));
    signal?.throwIfAborted();
    for (const r of done) {
      if (r.status === 'fulfilled') loaded.set(r.value.set.p, r.value.search);
      else if (strict) throw r.reason;
    }
  };
  if (!q) return [];
  await load(order.slice(0, FIRST_BATCH), true);
  if (!onUpdate) {
    await load(order.slice(FIRST_BATCH), false);
    return run();
  }
  const first = run();
  void (async () => {
    let last = first.join();
    try {
      for (let i = FIRST_BATCH; i < order.length; i += BACKGROUND_BATCH) {
        await load(order.slice(i, i + BACKGROUND_BATCH), false);
        const next = run();
        if (next.join() !== last) {
          last = next.join();
          onUpdate(next);
        }
      }
    } catch {
      /* aborted: the drawer moved on */
    }
  })();
  return first;
}

/** The first `limit` icons of a set in its browse order, as `prefix:name`. */
export async function collectionIcons(prefix: string, limit = 160, signal?: AbortSignal): Promise<string[]> {
  if (!(await isHosted(prefix, signal))) return DEMO ? [] : apiCollection(prefix, limit, signal);
  const ix = await loadIndex(prefix, signal);
  return ix.n.slice(0, limit).map((n) => `${prefix}:${n}`);
}

/** Icon body and viewBox for `prefix:name`. */
export async function iconData(full: string, signal?: AbortSignal): Promise<IconData> {
  const hit = dataCache.get(full) ?? pins.get(full);
  if (hit) return hit;
  const [prefix, name] = split(full);
  if (DEMO && !(await isHosted(prefix, signal))) throw new Error('This icon set is not included in the demo.');
  const d = (await isHosted(prefix, signal))
    ? await withRefresh(prefix, signal, async () => {
      const ix = await loadIndex(prefix, signal);
      const i = positionOf(ix, name);
      if (i < 0) throw new Error(`Icon ${full} not found`);
      const shard = await loadShard(prefix, ix, shardOf(ix, i), signal);
      return shardIcon(shard, ix.n[i]);
    })
    : await apiIconData(full, signal);
  dataCache.set(full, d);
  return d;
}

const svgUrl = (d: IconData) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${d.left} ${d.top} ${d.width} ${d.height}" width="${d.width}" height="${d.height}">${sanitizeSvgBody(d.body)}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

function remember(full: string, d: IconData) {
  previews.delete(full);
  previews.set(full, svgUrl(d));
  while (previews.size > PREVIEW_LIMIT) previews.delete(previews.keys().next().value!);
}

/**
 * Fetches what the previews of `names` need: the shards they live in (or, for the reactions, the one pin file),
 * six requests at a time. `onIcon` runs for each name as its preview becomes ready; read it with `previewUrl`.
 * Names of sets Tabula does not host need nothing and are skipped.
 */
export async function loadPreviews(names: string[], signal?: AbortSignal, onIcon?: (full: string) => void): Promise<void> {
  const m = await loadManifest(signal);
  const ready = (full: string) => onIcon?.(full);
  let todo: string[] = [];
  for (const full of names) {
    if (!hosted.has(split(full)[0])) continue;
    if (previews.has(full)) ready(full);
    else todo.push(full);
  }
  if (m.pin && todo.some((n) => m.pin!.names.includes(n))) {
    try {
      await loadPins(signal);
      todo = todo.filter((n) => {
        const d = pins.get(n);
        if (!d) return true;
        remember(n, d);
        ready(n);
        return false;
      });
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  const byPrefix = new Map<string, string[]>();
  for (const full of todo) {
    const [prefix] = split(full);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), full]);
  }
  await Promise.all([...byPrefix].map(([prefix, list]) => withRefresh(prefix, signal, async () => {
    const ix = await loadIndex(prefix, signal);
    const byShard = new Map<number, string[]>();
    for (const full of list) {
      const i = positionOf(ix, split(full)[1]);
      if (i < 0) continue;
      const n = shardOf(ix, i);
      byShard.set(n, [...(byShard.get(n) ?? []), full]);
    }
    await Promise.all([...byShard].map(async ([n, group]) => {
      const shard = await loadShard(prefix, ix, n, signal);
      for (const full of group) {
        const name = ix.n[positionOf(ix, split(full)[1])];
        remember(full, shardIcon(shard, name));
        ready(full);
      }
    }));
  })));
}

/** Preview URL for the picker grid: a data URL once `loadPreviews` has run for a hosted icon, Iconify's image for any other. */
export const previewUrl = (full: string): string => {
  const hit = previews.get(full);
  if (hit) return hit;
  const [prefix, name] = split(full);
  return manifest && !hosted.has(prefix) ? `${custom() || host}/${prefix}/${name}.svg?height=28` : '';
};

export interface IconLoadView {
  loading(on: boolean): void;
  results(names: string[]): void;
  /** `busy` is true while a retry is in flight; `retry` runs the query again. */
  failed(failure: IconFailure, retry: () => void, busy: boolean): void;
}

/**
 * Runs a drawer's query and reports it to `view`. A new load aborts the one in flight, and closing the drawer
 * (`signal`) aborts it too; a load that ends after either is dropped without touching `view`. After a failure
 * the query runs again once when the browser comes back online, or once after a rate limit. `reload` is a user's
 * retry or a new search and starts afresh.
 */
export function iconLoader(query: (signal: AbortSignal) => Promise<string[]>, view: IconLoadView, signal: AbortSignal, target: EventTarget = window) {
  let current: AbortController | null = null;
  let failure: IconFailure | null = null;
  let autoRetried = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    clearTimeout(timer);
    target.removeEventListener('online', load);
  };

  const load = async (): Promise<void> => {
    disarm();
    current?.abort();
    if (signal.aborted) return;
    const ctl = new AbortController();
    current = ctl;
    view.loading(true);
    if (failure) view.failed(failure, reload, true);
    let outcome: string[] | IconFailure;
    try {
      outcome = await query(ctl.signal);
    } catch (e) {
      outcome = failureOf(e);
    }
    if (ctl.signal.aborted) return;
    current = null;
    view.loading(false);
    if (Array.isArray(outcome)) {
      failure = null;
      autoRetried = false;
      view.results(outcome);
      return;
    }
    failure = outcome;
    view.failed(outcome, reload, false);
    if (outcome.kind === 'offline') target.addEventListener('online', load, { once: true });
    const wait = autoRetryWait(outcome);
    if (wait !== null && !autoRetried) {
      timer = setTimeout(() => {
        autoRetried = true;
        void load();
      }, wait);
    }
  };

  const reload = () => {
    autoRetried = false;
    void load();
  };

  signal.addEventListener('abort', () => {
    disarm();
    current?.abort();
  }, { once: true });
  return { reload };
}
