// Iconify integration: search, browse and fetch icon data. Placed icons store
// their SVG body in the board, so they render offline forever after.

const HOSTS = ['https://api.iconify.design', 'https://api.simplesvg.com', 'https://api.unisvg.com'];
let host = HOSTS[0];

export interface IconSet { prefix: string; name: string; total: number; license: string; licenseUrl?: string; attribution: boolean; category?: string }
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

/** A failed Iconify request, classified by the final host that was tried. */
export class IconError extends Error {
  failure: IconFailure;

  constructor(failure: IconFailure) {
    super(`Iconify request failed (${failure.kind})`);
    this.failure = failure;
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

let setsCache: Record<string, IconSet> | null = null;
export async function iconSets(signal?: AbortSignal): Promise<Record<string, IconSet>> {
  if (setsCache) return setsCache;
  const raw = (await api('/collections', signal)) as Record<string, { name: string; total: number; license?: { title: string; url?: string; spdx?: string }; category?: string }>;
  const out: Record<string, IconSet> = {};
  for (const [prefix, v] of Object.entries(raw)) {
    const lic = v.license?.spdx || v.license?.title || 'Unknown';
    out[prefix] = {
      prefix, name: v.name, total: v.total, license: lic, licenseUrl: v.license?.url, category: v.category,
      attribution: /^CC-BY|^CC BY|Attribution/i.test(lic) || /CC-BY/i.test(v.license?.title || ''),
    };
  }
  setsCache = out;
  return out;
}

export async function searchIcons(query: string, prefix?: string, limit = 96, signal?: AbortSignal): Promise<string[]> {
  const q = encodeURIComponent(query.trim());
  const p = prefix ? `&prefix=${encodeURIComponent(prefix)}` : '';
  const res = (await api(`/search?query=${q}&limit=${limit}${p}`, signal)) as { icons: string[] };
  return res.icons || [];
}

export async function collectionIcons(prefix: string, limit = 160, signal?: AbortSignal): Promise<string[]> {
  const res = (await api(`/collection?prefix=${encodeURIComponent(prefix)}`, signal)) as {
    uncategorized?: string[]; categories?: Record<string, string[]>;
  };
  const names = [...(res.uncategorized || []), ...Object.values(res.categories || {}).flat()];
  return [...new Set(names)].slice(0, limit).map((n) => `${prefix}:${n}`);
}

const dataCache = new Map<string, IconData>();

/** Icon body and viewBox for `prefix:name`. */
export async function iconData(full: string): Promise<IconData> {
  const hit = dataCache.get(full);
  if (hit) return hit;
  const [prefix, name] = full.split(':');
  const res = (await api(`/${encodeURIComponent(prefix)}.json?icons=${encodeURIComponent(name)}`)) as {
    icons: Record<string, Partial<IconData>>; aliases?: Record<string, { parent: string }>;
    width?: number; height?: number; left?: number; top?: number;
  };
  let icon = res.icons?.[name];
  if (!icon && res.aliases?.[name]) icon = res.icons?.[res.aliases[name].parent];
  if (!icon?.body) throw new Error(`Icon ${full} not found`);
  const d: IconData = {
    body: icon.body,
    width: icon.width ?? res.width ?? 16,
    height: icon.height ?? res.height ?? 16,
    left: icon.left ?? res.left ?? 0,
    top: icon.top ?? res.top ?? 0,
  };
  dataCache.set(full, d);
  return d;
}

/** Preview URL for the picker grid (cached by the service worker). */
export const previewUrl = (full: string) => {
  const [prefix, name] = full.split(':');
  return `${custom() || host}/${prefix}/${name}.svg?height=28`;
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
