// Link cards (docs/link-cards.md, proto/designer-preview/link-cards/SPEC.md): the pure rules. What counts as a web address, what looks
// like a secret, which layout a size has, what the card says about itself. No DOM, no network.

export const LINK_URL_MAX = 2048;

export type LinkLayout = 'compact' | 'card' | 'large';

/** The default size of each layout: what the quick bar's Compact, Card and Large resize the card to. */
export const LINK_SIZES: Record<LinkLayout, { w: number; h: number }> = {
  compact: { w: 320, h: 48 },
  card: { w: 320, h: 128 },
  large: { w: 320, h: 280 },
};

/** Compact below this height (docs/link-cards.md). */
export const COMPACT_MAX_H = 72;
/** Large when the box is at least this tall for its width; the default Large (320 x 280) is 0.875, the default Card 0.4. */
export const LARGE_MIN_RATIO = 0.8;

export function layoutOf(w: number, h: number): LinkLayout {
  if (h < COMPACT_MAX_H) return 'compact';
  return w > 0 && h / w >= LARGE_MIN_RATIO ? 'large' : 'card';
}

// ---------------------------------------------------------------- addresses

export type UrlRefusal = 'empty' | 'too_long' | 'invalid' | 'scheme' | 'credentials';

/** Why an address is not accepted, in the words the product uses (CGO-approved). */
export const URL_REFUSAL_TEXT: Record<Exclude<UrlRefusal, 'empty'>, string> = {
  too_long: 'Enter a web address that is 2,048 characters or shorter.',
  invalid: 'Enter a web address that starts with http:// or https://.',
  scheme: 'Enter a web address that starts with http:// or https://.',
  credentials: 'Addresses that contain a user name or password cannot be added.',
};

/** The address as the card stores it: the URL parser's form, fragment kept, `http` or `https` only, no user name or password. */
export function normaliseUrl(input: string): { ok: true; url: string } | { ok: false; reason: UrlRefusal } {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > LINK_URL_MAX) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (!url.hostname) return { ok: false, reason: 'invalid' };
  if (url.href.length > LINK_URL_MAX) return { ok: false, reason: 'too_long' };
  return { ok: true, url: url.href };
}

/** A clipboard text that is one web address and nothing else: the paste that makes a card. Null for anything else. */
export function loneUrl(text: string): string | null {
  const t = String(text ?? '').trim();
  if (!t || /\s/.test(t) || !/^https?:\/\//i.test(t)) return null;
  const n = normaliseUrl(t);
  return n.ok ? n.url : null;
}

/** The addresses in a dropped `text/uri-list` (comments start with #), at most `max`. */
export function urlsFromList(list: string, max = 10): string[] {
  const out: string[] = [];
  for (const line of String(list ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const n = normaliseUrl(line);
    if (n.ok && !out.includes(n.url)) out.push(n.url);
    if (out.length >= max) break;
  }
  return out;
}

const SECRET_KEYS = /^(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|key|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|pass|sig|signature|session|sessionid|sid|jwt|bearer|code|otp|x-amz-signature|x-amz-credential)$/i;

/** An address whose query looks like it carries a secret: the dialog warns before it goes on a shared board. */
export function secretLooking(url: string): boolean {
  try {
    for (const key of new URL(url).searchParams.keys()) if (SECRET_KEYS.test(key)) return true;
  } catch { /* not an address */ }
  return false;
}

/** The address with the value after a secret-looking key cut to an ellipsis, for the warning dialog. */
export function maskSecrets(url: string): string {
  try {
    const u = new URL(url);
    for (const key of Array.from(u.searchParams.keys())) if (SECRET_KEYS.test(key)) u.searchParams.set(key, '…');
    return decodeURIComponent(u.href);
  } catch {
    return url;
  }
}

/** The site without `www.`: what the card shows as its domain. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- the letter icon

/** White letter on each at 4.5:1 or more (test/link-cards.test.ts); the same six as the presence squares. */
export const LETTER_COLOURS = ['#3A71DD', '#C0551E', '#1E845C', '#C93A7A', '#845FD2', '#966F08'] as const;

export function letterOf(domain: string): string {
  const first = Array.from(domain.replace(/^www\./i, ''))[0];
  return first ? first.toLocaleUpperCase() : '?';
}

/** One colour per domain, always the same. */
export function letterColour(domain: string): string {
  let hash = 0;
  for (const ch of domain.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return LETTER_COLOURS[hash % LETTER_COLOURS.length];
}

// ---------------------------------------------------------------- what the card says

export type UnfurlState = 'pending' | 'ok' | 'failed' | 'off';

/** The tooltip reason of a failed preview (the codes of `unfurlError`). */
export const UNFURL_ERROR_TEXT: Record<string, string> = {
  blocked: 'This address cannot be previewed.',
  timeout: 'The site did not answer in time.',
  too_large: 'The page is too large to preview.',
  not_html: 'This address is not a web page.',
  http_status: 'The site did not return a page.',
  unreachable: 'The site could not be reached.',
  rate_limited: 'Too many previews right now. Try Refresh later.',
};

export interface LinkFields {
  url?: unknown;
  title?: unknown;
  description?: unknown;
  siteName?: unknown;
  finalUrl?: unknown;
  unfurl?: unknown;
  unfurlError?: unknown;
}

const str = (x: unknown, max: number) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** What the card draws, from a stored object that may hold anything (an older or hostile client wrote it). */
export function linkView(o: LinkFields) {
  const norm = normaliseUrl(typeof o.url === 'string' ? o.url : '');
  const url = norm.ok ? norm.url : '';
  const domain = domainOf(url);
  const state: UnfurlState = o.unfurl === 'ok' || o.unfurl === 'failed' || o.unfurl === 'off' ? o.unfurl : 'pending';
  const title = str(o.title, 300);
  return {
    url,
    domain,
    state,
    title: state === 'ok' ? title : '',
    description: state === 'ok' ? str(o.description, 1000) : '',
    siteName: state === 'ok' ? str(o.siteName, 100) || domain : domain,
    finalUrl: typeof o.finalUrl === 'string' && normaliseUrl(o.finalUrl).ok ? o.finalUrl : '',
    error: typeof o.unfurlError === 'string' ? o.unfurlError : '',
    /** What heads the card: the title, else the address. */
    heading: (state === 'ok' && title) || url,
  };
}

/** `Link card: <title or address>, <domain>[, loading preview][, no preview]. Press Enter to open.` */
export function linkLabel(o: LinkFields): string {
  const v = linkView(o);
  const parts = [`Link card: ${v.heading}`, v.domain];
  if (v.state === 'pending') parts.push('loading preview');
  if (v.state === 'failed') parts.push('no preview');
  return `${parts.filter(Boolean).join(', ')}. Press Enter to open.`;
}

/** The tooltip: the full address, where it redirects to, and why there is no preview. */
export function linkTooltip(o: LinkFields): string {
  const v = linkView(o);
  const lines = [v.url];
  if (v.finalUrl && v.finalUrl !== v.url) lines.push(`Redirects to ${v.finalUrl}`);
  if (v.state === 'failed') lines.push(UNFURL_ERROR_TEXT[v.error] ?? 'No preview.');
  return lines.filter(Boolean).join('\n');
}

/** Opens only an address that is `http` or `https`: anything else a document might hold goes nowhere. Returns whether it opened. */
export function openLink(url: unknown, open: (url: string, target: string, features: string) => unknown = (u, t, f) => window.open(u, t, f)): boolean {
  const n = normaliseUrl(typeof url === 'string' ? url : '');
  if (!n.ok) return false;
  open(n.url, '_blank', 'noopener,noreferrer');
  return true;
}

// ---------------------------------------------------------------- what the relay answers

export interface Preview {
  title: string;
  description: string;
  siteName: string;
  image: string | null;
  imageW: number | null;
  imageH: number | null;
  icon: string | null;
  finalUrl: string;
  fetchedAt: number;
}

const HASH = /^[0-9a-f]{64}$/;
const size = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : null);

/** The answer of `POST /api/boards/:id/unfurl`, checked: only what the card may hold, in its limits. */
export function parsePreview(x: unknown, now = Date.now()): Preview {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const image = typeof o.image === 'string' && HASH.test(o.image) ? o.image : null;
  const final = typeof o.finalUrl === 'string' ? normaliseUrl(o.finalUrl) : null;
  return {
    title: str(o.title, 300),
    description: str(o.description, 1000),
    siteName: str(o.siteName, 100),
    image,
    imageW: image ? size(o.imageW) : null,
    imageH: image ? size(o.imageH) : null,
    icon: typeof o.icon === 'string' && HASH.test(o.icon) ? o.icon : null,
    finalUrl: final?.ok ? final.url : '',
    fetchedAt: typeof o.fetchedAt === 'number' && Number.isFinite(o.fetchedAt) ? o.fetchedAt : now,
  };
}

/** The unfurl error code a refused or failed request means for the card (`unfurlError`), or `off` when previews are off. */
export function failureOf(status: number, code: string): { unfurl: 'failed' | 'off'; unfurlError?: string } {
  if (code === 'previews_off') return { unfurl: 'off' };
  if (status === 429) return { unfurl: 'failed', unfurlError: 'rate_limited' };
  if (UNFURL_ERROR_TEXT[code]) return { unfurl: 'failed', unfurlError: code };
  return { unfurl: 'failed', unfurlError: 'unreachable' };
}
