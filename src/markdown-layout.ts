// The Markdown block's layout (TAB-140): blocks from src/markdown.ts become positioned drawing items (text runs, rules, tinted boxes, check boxes, hit
// areas), in the block's own coordinates, top left at 0,0. Nothing here touches the DOM except the text measurer, so the same layout gives the canvas, the
// SVG and PNG exports, and the height the editor and the app fit the object to.

import { fontCss, measure } from './text';
import { type Align, type Block, type Inline, type ListItem, parseInlineText, parseMarkdown } from './markdown';

export interface MdStyle {
  /** Fontshare slug, or 'system' (src/fonts.ts). */
  font: string;
  size: number;
  weight: number;
  /** Line-height ratio for the whole block; older style callers keep the original 1.45 default. */
  lineHeight?: number;
}

export type MdTone = 'code' | 'quote' | 'rule' | 'table' | 'link' | 'strike' | 'box';

export type MdItem =
  | { k: 'text'; x: number; y: number; s: string; size: number; weight: number; italic: boolean; mono: boolean; dim: boolean }
  | { k: 'rect'; x: number; y: number; w: number; h: number; tone: MdTone }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; tone: MdTone }
  | { k: 'check'; x: number; y: number; size: number; done: boolean }
  | { k: 'picture'; x: number; y: number; w: number; h: number; alt: string }
  /** A transparent area that does something when it is clicked on the canvas: follow a link, or flip the task box on a source line. */
  | { k: 'hit'; x: number; y: number; w: number; h: number; link?: { href: string; kind: 'web' | 'mail' | 'obj' }; task?: number };

export interface MdLayout {
  items: MdItem[];
  /** The height of the content including the padding below it. */
  height: number;
}

export const MD_PAD = 10;
const LINE = 1.45;
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const monoFont = (size: number) => `400 ${size}px ${MONO}`;

interface Piece {
  s: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  strike: boolean;
  link?: { href: string; kind: 'web' | 'mail' | 'obj' };
  image?: { alt: string };
}

/** Flattens inline content into styled pieces, splitting text at spaces so the line breaker can work word by word. */
function pieces(c: Inline[], base: { bold: boolean; italic: boolean; strike: boolean; link?: Piece['link'] }, out: Piece[] = []): Piece[] {
  for (const n of c) {
    if (n.t === 'text') {
      for (const word of n.s.split(/(\s+)/)) if (word) out.push({ s: clipToken(word), bold: base.bold, italic: base.italic, mono: false, strike: base.strike, link: base.link });
    } else if (n.t === 'code') out.push({ s: clipToken(n.s), bold: base.bold, italic: base.italic, mono: true, strike: base.strike, link: base.link });
    else if (n.t === 'br') out.push({ s: '\n', bold: false, italic: false, mono: false, strike: false });
    else if (n.t === 'strong') pieces(n.c, { ...base, bold: true }, out);
    else if (n.t === 'em') pieces(n.c, { ...base, italic: true }, out);
    else if (n.t === 'del') pieces(n.c, { ...base, strike: true }, out);
    else if (n.t === 'link') pieces(n.c, { ...base, link: { href: n.href, kind: n.kind } }, out);
    else if (n.t === 'image') out.push({ s: '', bold: false, italic: false, mono: false, strike: false, image: { alt: n.alt } });
  }
  return out;
}

interface Run {
  p: Piece;
  s: string;
  w: number;
}

/** The longest unbroken word or code line the layout measures; the rest of a longer one is cut off and ends in an ellipsis. */
export const MAX_TOKEN_CHARS = 2000;
/** How many text measurements one layout may make; past it widths are estimated (0.6 em a character), so a hostile text cannot stall the page. */
export const MEASURE_BUDGET = 20000;

const clipToken = (s: string) => (s.length > MAX_TOKEN_CHARS ? `${s.slice(0, MAX_TOKEN_CHARS - 1)}…` : s);

/** The largest n in [1, s.length] whose prefix of n characters is at most `w` wide (1 if none is), by binary search: about log2(n) measurements. */
function fitPrefix(s: string, w: number, widthOfPrefix: (n: number) => number): number {
  let lo = 1;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (widthOfPrefix(mid) > w) hi = mid - 1;
    else lo = mid;
  }
  return lo;
}

/** A shared count of the measurements still allowed to one layout. */
interface Meter {
  left: number;
}

function measured(m: Meter, text: string, font: string, size: number): number {
  if (m.left <= 0) return text.length * size * 0.6;
  m.left--;
  return measure(text, font);
}

function widthOf(m: Meter, p: Piece, s: string, size: number, style: MdStyle, weight: number): number {
  return p.mono
    ? measured(m, s, monoFont(size * 0.92), size * 0.92)
    : measured(m, s, fontCss(style.font, size, p.bold ? Math.max(weight, 700) : weight, p.italic), size);
}

class Builder {
  items: MdItem[] = [];
  constructor(
    readonly style: MdStyle,
    readonly meter: Meter = { left: MEASURE_BUDGET },
  ) {}

  /**
   * Lays inline content out in a column starting at `x`, `w` wide, from `y` down; returns the y below the last line. `weight` and `size` are the block's
   * (a heading is bold and large). `dim` draws the text quieter (a quote).
   */
  inline(c: Inline[], x: number, y: number, w: number, size: number, weight: number, dim = false, align: Align = null): number {
    const lh = size * (this.style.lineHeight ?? LINE);
    const lines: Run[][] = [[]];
    let used = 0;
    const newLine = () => {
      lines.push([]);
      used = 0;
    };
    for (const p of pieces(c, { bold: false, italic: false, strike: false })) {
      if (p.image) {
        const run: Run = { p, s: `[image: ${p.image.alt}]`, w: 0 };
        run.w = widthOf(this.meter, { ...p, image: undefined }, run.s, size, this.style, weight);
        if (used > 0) newLine();
        lines[lines.length - 1].push(run);
        newLine();
        continue;
      }
      if (p.s === '\n') {
        newLine();
        continue;
      }
      const isSpace = /^\s+$/.test(p.s);
      let s = isSpace ? ' ' : p.s;
      let width = widthOf(this.meter, p, s, size, this.style, weight);
      if (isSpace) {
        if (used === 0) continue; // no space at the start of a line
        lines[lines.length - 1].push({ p, s, w: width });
        used += width;
        continue;
      }
      if (used + width > w && used > 0) {
        const line = lines[lines.length - 1];
        while (line.length && /^\s+$/.test(line[line.length - 1].s)) used -= line.pop()!.w; // trailing spaces do not count
        newLine();
      }
      // a word wider than the column breaks by character
      while (width > w && s.length > 1) {
        const cut = fitPrefix(s, w, (n) => widthOf(this.meter, p, s.slice(0, n), size, this.style, weight));
        lines[lines.length - 1].push({ p, s: s.slice(0, cut), w: widthOf(this.meter, p, s.slice(0, cut), size, this.style, weight) });
        newLine();
        s = s.slice(cut);
        width = widthOf(this.meter, p, s, size, this.style, weight);
      }
      lines[lines.length - 1].push({ p, s, w: width });
      used += width;
    }
    let top = y;
    for (const line of lines) {
      while (line.length && /^\s+$/.test(line[line.length - 1].s)) line.pop();
      if (line.length === 0 && lines.length > 1 && line === lines[lines.length - 1]) break;
      const total = line.reduce((a, r) => a + r.w, 0);
      let cx = align === 'center' ? x + (w - total) / 2 : align === 'right' ? x + w - total : x;
      const base = top + lh * 0.5 + size * 0.34;
      for (const r of line) {
        if (r.p.image) {
          this.items.push({ k: 'picture', x: cx, y: top, w: Math.max(r.w, size * 4), h: lh, alt: r.p.image.alt });
          cx += r.w;
          continue;
        }
        if (r.p.mono && !/^\s+$/.test(r.s)) this.items.push({ k: 'rect', x: cx - 2, y: top + lh * 0.12, w: r.w + 4, h: lh * 0.76, tone: 'code' });
        if (!/^\s+$/.test(r.s) || r.p.link || r.p.strike) {
          const text = !/^\s+$/.test(r.s) ? r.s : null;
          if (text) this.items.push({ k: 'text', x: cx, y: base, s: text, size: r.p.mono ? size * 0.92 : size, weight: r.p.bold ? Math.max(weight, 700) : weight, italic: r.p.italic, mono: r.p.mono, dim });
        }
        if (r.p.link) {
          this.items.push({ k: 'line', x1: cx, y1: base + size * 0.14, x2: cx + r.w, y2: base + size * 0.14, tone: 'link' }); // also under the spaces inside the link, so it reads as one
          this.items.push({ k: 'hit', x: cx, y: top, w: r.w, h: lh, link: r.p.link });
        }
        if (r.p.strike && !/^\s+$/.test(r.s)) this.items.push({ k: 'line', x1: cx, y1: base - size * 0.3, x2: cx + r.w, y2: base - size * 0.3, tone: 'strike' });
        cx += r.w;
      }
      top += lh;
    }
    return top;
  }

  blocks(blocks: Block[], x: number, y: number, w: number, size: number, weight: number, depth = 0, dim = false): number {
    let cursor = y;
    let first = true;
    for (const b of blocks) {
      const gap = first ? 0 : size * 0.65;
      first = false;
      switch (b.t) {
        case 'heading': {
          const scale = [1.9, 1.55, 1.3, 1.15, 1.05, 1][b.level - 1];
          cursor += cursor > y ? size * 0.35 : 0;
          cursor = this.inline(b.c, x, cursor + gap * 0.4, w, size * scale, 700, dim);
          break;
        }
        case 'para':
          cursor = this.inline(b.c, x, cursor + gap, w, size, weight, dim);
          break;
        case 'hr': {
          const at = cursor + gap + size * 0.4;
          this.items.push({ k: 'line', x1: x, y1: at, x2: x + w, y2: at, tone: 'rule' });
          cursor = at + size * 0.4;
          break;
        }
        case 'quote': {
          const start = cursor + gap;
          const end = this.blocks(b.blocks, x + size * 0.95, start, w - size * 0.95, size, weight, depth + 1, true);
          this.items.push({ k: 'rect', x, y: start, w: Math.max(2, size * 0.2), h: Math.max(end - start, size), tone: 'quote' });
          cursor = end;
          break;
        }
        case 'code': {
          const fs = size * 0.9;
          const inner = Math.max(20, w - size);
          const lines: string[] = [];
          for (const raw of b.s.split('\n')) {
            let rest = clipToken(raw);
            if (!rest) lines.push('');
            while (rest) {
              const cut = fitPrefix(rest, inner, (n) => measured(this.meter, rest.slice(0, n), monoFont(fs), fs));
              lines.push(rest.slice(0, cut));
              rest = rest.slice(cut);
            }
          }
          const lh = fs * 1.4;
          const top = cursor + gap;
          const height = lines.length * lh + size * 0.9;
          this.items.push({ k: 'rect', x, y: top, w, h: height, tone: 'code' });
          lines.forEach((l, i) => l && this.items.push({ k: 'text', x: x + size * 0.5, y: top + size * 0.45 + i * lh + lh * 0.5 + fs * 0.34, s: l, size: fs, weight: 400, italic: false, mono: true, dim: false }));
          cursor = top + height;
          break;
        }
        case 'list':
          cursor = this.list(b.items, b.ordered, b.start, x, cursor + gap, w, size, weight, depth, dim);
          break;
        case 'table':
          cursor = this.table(b, x, cursor + gap, w, size, weight, dim);
          break;
      }
    }
    return cursor;
  }

  list(items: ListItem[], ordered: boolean, start: number, x: number, y: number, w: number, size: number, weight: number, depth: number, dim: boolean): number {
    let cursor = y;
    const indent = size * (ordered ? 1.9 : 1.5);
    items.forEach((item, i) => {
      const top = cursor + (i === 0 ? 0 : size * 0.25);
      const before = this.items.length;
      const end = this.blocks(item.blocks, x + indent, top, w - indent, size, weight, depth + 1, dim);
      const lh = size * LINE;
      if (item.task) {
        const box = size * 0.95;
        this.items.push({ k: 'check', x: x + indent - box - size * 0.3, y: top + (lh - box) / 2, size: box, done: item.task === 'done' });
        this.items.push({ k: 'hit', x: x + indent - box - size * 0.5, y: top, w: box + size * 0.6, h: lh, task: item.line });
      } else {
        const mark = ordered ? `${start + i}.` : ['•', '◦', '▪'][depth % 3];
        this.items.push({ k: 'text', x: x + (ordered ? indent - size * 0.35 - measure(mark, fontCss(this.style.font, size, weight)) : size * 0.35), y: top + lh * 0.5 + size * 0.34, s: mark, size, weight, italic: false, mono: false, dim });
      }
      if (item.task === 'done') {
        // a done task is quieter and struck through, like the tick says
        for (let j = before; j < this.items.length; j++) {
          const it = this.items[j];
          if (it.k === 'text') it.dim = true;
        }
      }
      cursor = Math.max(end, top + lh);
    });
    return cursor;
  }

  table(b: Extract<Block, { t: 'table' }>, x: number, y: number, w: number, size: number, weight: number, dim: boolean): number {
    const cols = b.head.length;
    const pad = size * 0.45;
    const colW = w / cols;
    const rows = [b.head, ...b.rows];
    const heights: number[] = [];
    // measure each row first (by laying its cells into a scratch builder), then draw
    for (const r of rows) {
      let h = 0;
      for (let c = 0; c < cols; c++) {
        const scratch = new Builder(this.style, this.meter);
        h = Math.max(h, scratch.inline(r[c] ?? [], 0, 0, colW - pad * 2, size, r === b.head ? 700 : weight, dim));
      }
      heights.push(Math.max(h, size * LINE) + pad);
    }
    let cursor = y;
    rows.forEach((r, ri) => {
      for (let c = 0; c < cols; c++) this.inline(r[c] ?? [], x + c * colW + pad, cursor + pad / 2, colW - pad * 2, size, ri === 0 ? 700 : weight, dim, b.align[c]);
      cursor += heights[ri];
      this.items.push({ k: 'line', x1: x, y1: cursor, x2: x + w, y2: cursor, tone: ri === 0 ? 'rule' : 'table' });
    });
    this.items.push({ k: 'line', x1: x, y1: y, x2: x + w, y2: y, tone: 'table' });
    for (let c = 0; c <= cols; c++) this.items.push({ k: 'line', x1: x + c * colW, y1: y, x2: x + c * colW, y2: cursor, tone: 'table' });
    return cursor;
  }
}

/** The drawing items of a Markdown source laid out in a box `width` wide, and the height the content needs. */
export function layoutMarkdown(src: string, width: number, style: MdStyle): MdLayout {
  const builder = new Builder(style);
  const blocks = parseMarkdown(src);
  const w = Math.max(40, width - MD_PAD * 2);
  const end = builder.blocks(blocks, MD_PAD, MD_PAD, w, style.size, style.weight);
  const items = builder.items;
  return { items, height: Math.max(style.size * LINE + MD_PAD * 2, Math.ceil(end + MD_PAD)) };
}

/** The height a Markdown block needs at a width (the editor and the app fit the object to it). */
export function markdownHeight(src: string, width: number, style: MdStyle): number {
  return layoutMarkdown(src, width, style).height;
}

/**
 * Inline Markdown only (bold, italic, code, strike, links; no headings, lists or tables), laid out in a column `width` wide from the top left at 0,0:
 * what a table cell shows (docs/tables.md). A line break in the text is a line break on the page. `height` is the space the lines take.
 */
export function layoutInlineText(src: string, width: number, style: MdStyle, opts: { size?: number; weight?: number; align?: Align } = {}): MdLayout {
  const builder = new Builder(style);
  const size = opts.size ?? style.size;
  const inline: Inline[] = [];
  src.split('\n').forEach((line, i) => {
    if (i > 0) inline.push({ t: 'br' });
    inline.push(...parseInlineText(line));
  });
  const end = builder.inline(inline, 0, 0, Math.max(20, width), size, opts.weight ?? style.weight, false, opts.align ?? null);
  return { items: builder.items, height: Math.max(size * LINE, end) };
}

export const INLINE_LINE_HEIGHT = LINE;
