// Icon sets kept on this device for offline use. The files are the hashed ones the service worker already caches
// as they are fetched (public/sw.js, cache ICONS_CACHE); "download" fetches every file of a set so it is all there.
import { hostedSets, setFiles, slot } from './icons';

export const ICONS_CACHE = 'tabula-icons-v1';
export const OFFLINE_KEY = 'driftboard:icons-offline';

/** none: not all of the set is stored. ready: all of it. update: a newer version is on the server. */
export type OfflineState = 'none' | 'ready' | 'update';

export const offlineSupported = () => typeof caches !== 'undefined';

/** The sets this device downloaded on purpose (browsing alone does not add to it). */
export function downloadedSets(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(OFFLINE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function saveDownloaded(list: string[]) {
  try {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify([...new Set(list)].sort()));
  } catch {
    /* the list only decides which sets to offer an update for */
  }
}

const pathOf = (req: Request) => new URL(req.url, 'http://x').pathname;
const keysOf = async (cache: Cache) => (await cache.keys()).map((req) => ({ req, path: pathOf(req) }));
const ownFile = (prefix: string) => new RegExp(`^/icons/(?:i|s)/${prefix.replace(/[^a-z0-9-]/g, '')}\\.`);

/** Whether each set is stored in full. Reads the cache only, never the network. */
export async function offlineStates(sets: { prefix: string; idx: string }[], storage: CacheStorage = caches): Promise<Record<string, OfflineState>> {
  const cache = await storage.open(ICONS_CACHE);
  const paths = new Set((await keysOf(cache)).map((k) => k.path));
  const listed = new Set(downloadedSets());
  const out: Record<string, OfflineState> = {};
  for (const { prefix, idx } of sets) {
    const index = `/icons/i/${prefix}.${idx}.json`;
    out[prefix] = 'none';
    if (paths.has(index)) {
      const res = await cache.match(index, { ignoreVary: true });
      const ix = res ? ((await res.json()) as { sh: [string, number][] }) : null;
      if (ix?.sh.every(([hash], n) => paths.has(`/icons/s/${prefix}.${n}.${hash}.json`))) out[prefix] = 'ready';
    } else if (listed.has(prefix) && [...paths].some((p) => p.startsWith(`/icons/i/${prefix}.`))) {
      out[prefix] = 'update';
    }
  }
  return out;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  storage?: CacheStorage;
}

/** Stores every file of the sets, or brings a stored set up to date: only missing files are fetched, and files of an older version are dropped. */
export async function downloadSets(prefixes: string[], { signal, onProgress, storage = caches }: DownloadOptions = {}): Promise<void> {
  const cache = await storage.open(ICONS_CACHE);
  const sizes = new Map((await hostedSets(signal)).map((s) => [s.prefix, s]));
  const need = prefixes.reduce((n, p) => n + (sizes.get(p)?.raw ?? 0), 0);
  const space = typeof navigator === 'undefined' ? undefined : navigator.storage;
  const quota = await space?.estimate?.();
  if (quota?.quota !== undefined && quota.usage !== undefined && quota.quota - quota.usage < need * 1.1) {
    throw new Error('There is not enough free storage on this device for these icons.');
  }
  const lists = await Promise.all(prefixes.map((p) => setFiles(p, signal)));
  const wanted = new Set(lists.flat());
  const have = new Set((await keysOf(cache)).map((k) => k.path));
  const stop = new AbortController();
  signal?.addEventListener('abort', () => stop.abort(signal.reason), { once: true });
  let done = 0;
  onProgress?.(0, wanted.size);
  try {
    await Promise.all([...wanted].map(async (url) => {
      if (!have.has(url)) {
        const res = await slot(() => fetch(url, { signal: stop.signal }), stop.signal);
        if (res.status !== 200) throw new Error(`Could not download ${url} (${res.status})`);
        await cache.put(url, res);
      }
      onProgress?.(++done, wanted.size);
    }));
  } catch (e) {
    stop.abort();
    throw e;
  }
  for (const { req, path } of await keysOf(cache)) {
    if (!wanted.has(path) && prefixes.some((p) => ownFile(p).test(path))) await cache.delete(req);
  }
  saveDownloaded([...downloadedSets(), ...prefixes]);
  void space?.persist?.()?.catch(() => undefined);
}

/** Deletes the stored files of the sets. */
export async function removeSets(prefixes: string[], storage: CacheStorage = caches): Promise<void> {
  const cache = await storage.open(ICONS_CACHE);
  for (const { req, path } of await keysOf(cache)) if (prefixes.some((p) => ownFile(p).test(path))) await cache.delete(req);
  saveDownloaded(downloadedSets().filter((p) => !prefixes.includes(p)));
}
