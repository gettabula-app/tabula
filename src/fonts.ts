// Fontshare integration: catalogue, on-demand loading, and family-name lookup.
// Font files are always fetched from Fontshare's own servers; the service
// worker caches them on this device for offline use. They are never embedded
// in board files or served by the relay (ITF Free Font License).

import { DEMO } from './demo';
import { BUILTIN_FONTS, DEMO_FONT_ALLOWLIST, type FontEntry } from './font-policy';

export type { FontEntry } from './font-policy';

const API = 'https://api.fontshare.com/v2';
const CACHE_KEY = 'driftboard:fontshare-catalogue';
const DAY = 86_400_000;

export const SYSTEM = 'system';
export const SYSTEM_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const FONT_KEYWORD_ALIASES = [
  ['sans', 'sans serif', 'sans-serif', 'sansserif'],
  ['mono', 'monospace', 'monospaced', 'fixed width', 'fixed-width', 'typewriter', 'code', 'coding'],
  ['serif', 'serif typeface'],
  ['handwriting', 'handwritten', 'hand writing', 'script', 'cursive'],
  ['display', 'decorative', 'headline'],
  ['rounded', 'round'],
  ['geometric', 'geometric sans', 'geometric sans serif'],
] as const;

// "sans serif" is one word for matching, so "serif" never matches a sans-serif font
const normalizeFontSearch = (value: string): string => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\bsans serif\b/g, 'sansserif');

function fontKeywords(font: FontEntry): string[] {
  const keywords = [font.category, ...font.tags].map(normalizeFontSearch).filter(Boolean);
  const expanded = new Set(keywords);
  for (const keyword of keywords) {
    for (const aliases of FONT_KEYWORD_ALIASES) {
      if (aliases.some((alias) => { const a = normalizeFontSearch(alias); return keyword === a || keyword.startsWith(`${a} `); })) {
        aliases.forEach((alias) => expanded.add(normalizeFontSearch(alias)));
      }
    }
  }
  return [...expanded];
}

/** Search font names and style metadata, with exact family names ranked first. */
export function searchFonts(query: string, fonts: readonly FontEntry[] = catalogue): FontEntry[] {
  const normalizedQuery = normalizeFontSearch(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(' ');
  const ranked = fonts.flatMap((font, index) => {
    const name = normalizeFontSearch(font.name);
    const nameAndSlug = [name, normalizeFontSearch(font.slug)];
    const nameMatch = tokens.every((token) => nameAndSlug.some((value) => value.includes(token)));
    const metadata = fontKeywords(font);
    // metadata matches at word starts, so "serif" does not match "sans serif"
    const metadataMatch = tokens.every((token) => metadata.some((value) => value.split(' ').some((word) => word.startsWith(token))));
    if (name !== normalizedQuery && !nameMatch && !metadataMatch) return [];
    const rank = name === normalizedQuery ? 0 : nameMatch ? 1 : 2;
    return [{ font, index, rank }];
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ font }) => font);
}

// A small built-in list so the picker and defaults work before the catalogue
// has ever been fetched (first run offline).
let catalogue: FontEntry[] = DEMO ? BUILTIN_FONTS : readCached()?.fonts ?? BUILTIN_FONTS;
const bySlug = new Map<string, FontEntry>();
const indexCatalogue = () => {
  bySlug.clear();
  for (const f of catalogue) bySlug.set(f.slug, f);
};
indexCatalogue();

function readCached(): { at: number; fonts: FontEntry[] } | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

interface ApiStyle { weight: { weight: number }; is_italic: boolean; is_variable: boolean }
interface ApiFont { name: string; slug: string; category: string; styles: ApiStyle[]; font_tags?: { name: string }[] }

export function parseCatalogue(json: { fonts: ApiFont[] }): FontEntry[] {
  return json.fonts
    .map((f) => {
      const weights = [...new Set(f.styles.filter((s) => !s.is_variable && !s.is_italic).map((s) => s.weight.weight))]
        .filter((w) => w >= 100 && w <= 900)
        .sort((a, b) => a - b);
      return {
        name: f.name,
        slug: f.slug,
        category: (f.category || 'Other').split(',')[0].trim(),
        weights: weights.length ? weights : [400],
        italic: f.styles.some((s) => s.is_italic),
        variable: f.styles.some((s) => s.is_variable),
        tags: (f.font_tags || []).map((t) => t.name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetch the catalogue at most once a day; fall back to the cached copy offline. */
export async function loadCatalogue(force = false): Promise<FontEntry[]> {
  if (DEMO) {
    catalogue = BUILTIN_FONTS;
    indexCatalogue();
    return catalogue;
  }
  const cached = readCached();
  if (!force && cached && Date.now() - cached.at < DAY) {
    catalogue = cached.fonts;
    indexCatalogue();
    return catalogue;
  }
  try {
    const res = await fetch(`${API}/fonts?offset=0&limit=100`);
    if (!res.ok) throw new Error(String(res.status));
    const fonts = parseCatalogue(await res.json());
    catalogue = fonts;
    indexCatalogue();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), fonts }));
    } catch { /* storage full: keep in memory */ }
  } catch {
    if (cached) {
      catalogue = cached.fonts;
      indexCatalogue();
    }
  }
  return catalogue;
}

export const getCatalogue = () => catalogue;

export function fontName(slug: string | undefined): string {
  if (!slug || slug === SYSTEM) return 'System';
  const safeSlug = DEMO && !DEMO_FONT_ALLOWLIST.has(slug) ? 'satoshi' : slug;
  const f = bySlug.get(safeSlug);
  if (f) return f.name;
  return safeSlug.split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

export function fontFamily(slug: string | undefined): string {
  if (!slug || slug === SYSTEM) return SYSTEM_STACK;
  const safeSlug = DEMO && !DEMO_FONT_ALLOWLIST.has(slug) ? 'satoshi' : slug;
  return `"${fontName(safeSlug)}", ${SYSTEM_STACK}`;
}

const requested = new Set<string>();   // slug@weight
const listeners = new Set<() => void>();
export const onFontLoaded = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function fontIsAllowed(slug: string): boolean {
  return !DEMO || DEMO_FONT_ALLOWLIST.has(slug);
}

export function cssUrl(slug: string, weights: number[]): string | null {
  if (!fontIsAllowed(slug)) return null;
  return `${API}/css?f[]=${encodeURIComponent(slug)}@${weights.join(',')}&display=swap`;
}

/** Nearest weight the family actually has. */
export function nearestWeight(slug: string, w: number): number {
  const f = bySlug.get(slug);
  if (!f) return w;
  return f.weights.reduce((best, x) => (Math.abs(x - w) < Math.abs(best - w) ? x : best), f.weights[0]);
}

/**
 * Load the given weights of a Fontshare family via its CSS endpoint. Resolves
 * once the browser has the faces (or immediately if they were requested before).
 */
export function ensureFont(slug: string | undefined, weights: number[] = [400]): Promise<void> {
  if (!slug || slug === SYSTEM || !fontIsAllowed(slug) || typeof document === 'undefined') return Promise.resolve();
  const want = [...new Set(weights.map((w) => nearestWeight(slug, w)))].filter((w) => !requested.has(`${slug}@${w}`));
  if (!want.length) return Promise.resolve();
  const url = cssUrl(slug, want);
  if (!url) return Promise.resolve();
  want.forEach((w) => requested.add(`${slug}@${w}`));
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.fontshare = slug;
  document.head.appendChild(link);
  const name = fontName(slug);
  return new Promise<void>((resolve) => {
    link.onload = () => {
      Promise.all(want.map((w) => document.fonts.load(`${w} 16px "${name}"`)))
        .catch(() => undefined)
        .then(() => {
          listeners.forEach((l) => l());
          resolve();
        });
    };
    link.onerror = () => resolve();
  });
}

/** Load a single preview weight for the picker. */
export const previewFont = (slug: string) => ensureFont(slug, [nearestWeight(slug, 500)]);
