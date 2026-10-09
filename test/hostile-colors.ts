// Hostile colour values for the TAB-203 sink and write-path tests, and one check for markup that drew them.
import { isSafeColor } from '../shared/colors';

/** Strings a collaborator, template, import or tool could store where a colour belongs. Each one carries a marker. */
export const HOSTILE_STRINGS = [
  'red;filter:url(//evil.example/x)',
  '#fff;background:url(https://evil.example/a.png)',
  'url(https://evil.example/x)',
  'url(#evil)',
  'expression(alert(1))',
  '#FFF" onload="alert(1)',
  "#FFF' onmouseover='alert(1)",
  '#FFF"/><script>alert(1)</script>',
  '</style><script>alert(1)</script>',
  'var(--evil, url(//evil.example))',
  'var(--evil);background:url(//evil.example)',
  'var(--evil, #FFFFFF);filter:url(//evil.example)',
  '#FFF\n" onload="alert(1)',
];

/** Values that are not strings at all. */
export const HOSTILE_VALUES: unknown[] = [...HOSTILE_STRINGS, 42, true, { toString: () => 'url(//evil.example)' }, ['#FFF'], null];

/** What no markup may contain after a hostile colour went in. */
const MARKERS = /evil|alert|onload|onmouseover|<script|expression\(/i;

/** Colour-carrying attribute values the app writes itself (internal paint servers, the hidden-sticky ink, a preview rule). */
const OWN = new RegExp([
  'currentColor',
  'url\\(#sticky-(?:sheen|flap|shadow|curl-shadow)\\)',
  'rgba\\(\\d+,\\d+,\\d+,[\\d.]+\\)',
  // an AI preview's rule in someone else's colour (src/ai-live-logic.ts)
  'color-mix\\(in srgb, #[0-9A-F]{6} 80%, var\\(--canvas-ink, #18212B\\)\\)',
].map((s) => `^${s}$`).join('|'));

/**
 * What is wrong with markup drawn from a poisoned object; empty when it carries nothing of the poison: no marker, every
 * colour attribute is a colour of the grammar (or one of the app's own constants), every `style="color:…"` is a single
 * safe declaration, no inline style loads a url(), and no attribute was ended early by a quote.
 */
export function markupProblems(markup: string): string[] {
  const out: string[] = [];
  const marker = MARKERS.exec(markup);
  if (marker) out.push(`marker ${marker[0]}`);
  for (const m of markup.matchAll(/\s(fill|stroke|color|stop-color|flood-color)="([^"]*)"/g)) {
    if (!OWN.test(m[2]) && !isSafeColor(m[2])) out.push(`${m[1]}="${m[2]}"`);
  }
  for (const m of markup.matchAll(/\sstyle="([^"]*)"/g)) {
    const v = m[1];
    if (v.startsWith('color:') && (v.includes(';') || !isSafeColor(v.slice('color:'.length)))) out.push(`style="${v}"`);
    if (/url\((?!#)/.test(v)) out.push(`style with url(): ${v}`);
  }
  // every attribute is name="value": a quote that ended one early leaves a stray token
  for (const tag of markup.matchAll(/<([a-zA-Z]+)((?:\s[^<>]*)?)\/?>/g)) {
    const rest = tag[2].replace(/\s[a-zA-Z][\w:.-]*="[^"]*"/g, '').replace(/\/$/, '').trim();
    if (rest !== '') out.push(`stray text in <${tag[1]}>: ${rest}`);
  }
  return out;
}
