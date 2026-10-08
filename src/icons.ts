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

/** Fetch from the Iconify API, failing over to its backup hosts after 750 ms. */
async function api(path: string): Promise<unknown> {
  const hosts = custom() ? [custom()!] : [host, ...HOSTS.filter((h) => h !== host)];
  let lastErr: unknown;
  for (const h of hosts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), h === hosts[0] ? 2500 : 4000);
    try {
      const res = await fetch(h + path, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`Iconify ${res.status}`);
      host = h;
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
    }
  }
  throw lastErr;
}

export const POPULAR_SETS = ['lucide', 'tabler', 'ph', 'mdi', 'material-symbols', 'carbon', 'heroicons', 'logos', 'simple-icons', 'fluent-emoji-flat', 'twemoji', 'devicon'];

let setsCache: Record<string, IconSet> | null = null;
export async function iconSets(): Promise<Record<string, IconSet>> {
  if (setsCache) return setsCache;
  const raw = (await api('/collections')) as Record<string, { name: string; total: number; license?: { title: string; url?: string; spdx?: string }; category?: string }>;
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

export async function searchIcons(query: string, prefix?: string, limit = 96): Promise<string[]> {
  const q = encodeURIComponent(query.trim());
  const p = prefix ? `&prefix=${encodeURIComponent(prefix)}` : '';
  const res = (await api(`/search?query=${q}&limit=${limit}${p}`)) as { icons: string[] };
  return res.icons || [];
}

export async function collectionIcons(prefix: string, limit = 160): Promise<string[]> {
  const res = (await api(`/collection?prefix=${encodeURIComponent(prefix)}`)) as {
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
