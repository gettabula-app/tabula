import { fontFamily } from './fonts';

let ctx: CanvasRenderingContext2D | null = null;
const getCtx = () => {
  if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  return ctx;
};

const cache = new Map<string, number>();

export function fontCss(slug: string | undefined, size: number, weight = 400, italic = false) {
  return `${italic ? 'italic ' : ''}${weight} ${size}px ${fontFamily(slug)}`;
}

export function measure(text: string, font: string): number {
  const key = font + '\u0000' + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const c = getCtx();
  let w: number;
  if (c) {
    c.font = font;
    w = c.measureText(text).width;
  } else {
    const size = parseFloat(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? '16');
    w = text.length * size * 0.55;
  }
  if (cache.size > 20000) cache.clear();
  cache.set(key, w);
  return w;
}

/** Fonts finished loading: measurements taken with fallback faces are stale. */
export const clearMeasureCache = () => cache.clear();

/** Greedy word wrap. Newlines are hard breaks; long words break by character. */
export function wrap(text: string, font: string, maxWidth: number): string[] {
  const out: string[] = [];
  const max = Math.max(4, maxWidth);
  for (const para of text.split('\n')) {
    if (!para) {
      out.push('');
      continue;
    }
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (measure(candidate.trimEnd(), font) <= max || !line.trim()) {
        if (measure(word, font) > max && !line.trim()) {
          // break an overlong word
          let chunk = '';
          for (const ch of word) {
            if (measure(chunk + ch, font) > max && chunk) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        out.push(line.trimEnd());
        line = /^\s+$/.test(word) ? '' : word;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface TextLayout {
  lines: string[];
  size: number;
  lineHeight: number;
  height: number;
}

/** Wrap text, shrinking the font (down to `minSize`) until it fits the height. */
export function fitText(text: string, slug: string | undefined, weight: number, size: number, w: number, h: number, minSize = 9): TextLayout {
  let s = size;
  for (;;) {
    const lh = Math.round(s * 1.3 * 100) / 100;
    const lines = wrap(text, fontCss(slug, s, weight), w);
    const height = lines.length * lh;
    if (height <= h || s <= minSize) return { lines, size: s, lineHeight: lh, height };
    s = Math.max(minSize, Math.floor(s * 0.88));
  }
}
