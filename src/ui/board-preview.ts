// TAB-375 slice 2: the schematic preview of a board on its card (spec 14, section 4). The model is numbers and palette keys, never
// markup: sanitizeShapes() keeps only valid shapes, and drawPreview() creates SVG elements with createElementNS. Names go in as text;
// colours are a sticky palette name or a plain #RRGGBB (resolveColour in src/palette.ts). The tint style draws from the same tint, bar and
// radius rules as the real picture (src/template-thumb.ts), so the two are one family.
import { BARS, BAR_INK, INK_VAR, OUTLINE_INK, PAPER_VAR, STICKY_GREY, barRects, frameColours, radiusOf, resolveColour, type BarSpec } from '../palette';

export type PreviewType = 'frame' | 'container' | 'lane' | 'card' | 'sticky' | 'shape' | 'text' | 'image' | 'other';
export interface PreviewShape { t: PreviewType; x: number; y: number; w: number; h: number; fill?: string; name?: string }
export interface PreviewModel { shapes: PreviewShape[] }
export type PreviewStyle = 'outline' | 'tint' | 'dots';

export const PREVIEW_MAX_SHAPES = 60;
export const PREVIEW_NAME_MAX = 40;
const COORD_LIMIT = 1e7;
const TYPES: readonly string[] = ['frame', 'container', 'lane', 'card', 'sticky', 'shape', 'text', 'image', 'other'];
const SVG_NS = 'http://www.w3.org/2000/svg';

const STROKE = `stroke:${OUTLINE_INK};vector-effect:non-scaling-stroke`;
const FAINT = `stroke:color-mix(in srgb, ${INK_VAR} 14%, transparent);vector-effect:non-scaling-stroke`;
const PAPER = `fill:${PAPER_VAR}`;
const NONE = 'fill:none';
const INK_DOT = `fill:color-mix(in srgb, ${INK_VAR} 40%, transparent)`;
const BAR = `fill:${BAR_INK}`;
const TEXT = 'fill:var(--graphite);font-family:var(--ui)';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v)) : null);

/** A name as plain text: control characters dropped, whitespace trimmed, at most 40 characters (code points). */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let plain = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) plain += ch;
  }
  const cut = Array.from(plain.trim()).slice(0, PREVIEW_NAME_MAX).join('');
  return cut === '' ? undefined : cut;
}

/** Keeps the valid shapes of a list, in order, at most PREVIEW_MAX_SHAPES: unknown types and non-finite numbers are dropped. */
export function cleanShapes(list: readonly unknown[]): PreviewShape[] {
  const out: PreviewShape[] = [];
  for (const raw of list) {
    if (out.length >= PREVIEW_MAX_SHAPES) break;
    if (raw === null || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.t !== 'string' || !TYPES.includes(s.t)) continue;
    const x = num(s.x);
    const y = num(s.y);
    const w = num(s.w);
    const h = num(s.h);
    if (x === null || y === null || w === null || h === null) continue;
    const shape: PreviewShape = { t: s.t as PreviewType, x, y, w: Math.max(0, w), h: Math.max(0, h) };
    const name = cleanName(s.name);
    if (name !== undefined) shape.name = name;
    if (typeof s.fill === 'string' && s.fill.length <= 32) shape.fill = s.fill;
    out.push(shape);
  }
  return out;
}

/** The shapes of a model that may be drawn. Anything that is not a model gives no shapes. */
export function sanitizeShapes(model: unknown): PreviewShape[] {
  const list: readonly unknown[] = model !== null && typeof model === 'object' && 'shapes' in model && Array.isArray(model.shapes) ? model.shapes : [];
  return cleanShapes(list);
}

/** The fill of a sticky or a shape: its palette colour (a name, in any case) or a plain #RRGGBB; anything else is grey. */
export function paletteFill(key: string | undefined): string {
  return resolveColour(key) ?? STICKY_GREY;
}

/** The viewBox [x, y, w, h] around the valid shapes, with 6% padding; an empty model gets a 16:10 box at the origin. */
export function previewViewBox(shapes: readonly PreviewShape[]): [number, number, number, number] {
  const list = cleanShapes(shapes);
  if (list.length === 0) return [0, 0, 160, 100];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of list) {
    x0 = Math.min(x0, s.x);
    y0 = Math.min(y0, s.y);
    x1 = Math.max(x1, s.x + s.w);
    y1 = Math.max(y1, s.y + s.h);
  }
  const bw = x1 - x0;
  const bh = y1 - y0;
  const pad = Math.max(bw, bh, 1) * 0.06;
  return [x0 - pad, y0 - pad, bw + 2 * pad, bh + 2 * pad];
}

type Attrs = Record<string, string | number>;

function node(tag: string, attrs: Attrs, css: string): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.setAttribute('style', css);
  return el;
}

function label(s: PreviewShape, unit: number): SVGElement {
  const size = unit * 0.05;
  const el = node('text', { x: s.x + unit * 0.02, y: s.y + size * 1.25, 'font-size': size }, TEXT);
  el.textContent = s.name ?? '';
  return el;
}

/** The grey bars of a box, in the rows and weight of the real picture (the same numbers, see src/palette.ts). */
function bars(s: PreviewShape, unit: number, spec: BarSpec): SVGElement[] {
  return barRects(s.x, s.y, s.w, s.h, unit, spec).map((b) => node('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: b.rx }, BAR));
}

function drawShape(s: PreviewShape, mode: PreviewStyle, unit: number): SVGElement[] {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const dot = unit * 0.018;
  const rx = radiusOf(unit);
  const rect = (css: string) => [node('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx }, css)];
  const dotAt = (css: string) => [node('circle', { cx, cy, r: dot }, css)];
  switch (s.t) {
    case 'frame':
    case 'container':
    case 'lane': {
      if (mode === 'dots') return rect(`${NONE};${FAINT}`);
      if (mode === 'tint') {
        const c = frameColours(s.fill);
        return rect(`fill:${c.fill};stroke:${c.edge};stroke-width:1;vector-effect:non-scaling-stroke`);
      }
      const out = rect(`${NONE};${STROKE}`);
      if (s.name) out.push(label(s, unit));
      return out;
    }
    case 'card':
      if (mode === 'dots') return dotAt(INK_DOT);
      return mode === 'tint' ? [...rect(`${PAPER};${STROKE}`), ...bars(s, unit, BARS.card)] : rect(`${PAPER};${STROKE}`);
    case 'sticky': {
      const colour = `fill:${paletteFill(s.fill)}`;
      if (mode === 'dots') return dotAt(colour);
      return mode === 'tint' ? [...rect(colour), ...bars(s, unit, BARS.sticky)] : rect(colour);
    }
    case 'shape': {
      const fill = s.fill === undefined ? undefined : `fill:${paletteFill(s.fill)}`;
      if (mode === 'dots') return dotAt(fill ?? INK_DOT);
      return [node('ellipse', { cx, cy, rx: s.w / 2, ry: s.h / 2 }, `${fill ?? PAPER};${STROKE}`)];
    }
    case 'text':
      return mode === 'dots' ? [] : bars(s, unit, BARS.text);
    case 'image':
      return mode === 'dots' ? [] : rect(`${PAPER};${STROKE}`);
    case 'other':
      return mode === 'dots' ? [] : rect(`${NONE};${FAINT}`);
  }
}

/**
 * The drawing of a board: an SVG of the shapes as boxes. 'tint' (the default) is the family of the real picture: frames, containers and
 * lanes in their own colour (neutral when they have none) with a darker edge, stickies as solid colour blocks, cards, text and stickies
 * with grey bars, and no names. 'outline' = frames and lanes as outlines with their names, stickies as colour chips. 'dots' = a dot at
 * each sticky, card and shape, frames as faint outlines, no names. Shapes without a valid type or with non-finite numbers are not drawn.
 */
export function drawPreview(model: PreviewModel | undefined, style: PreviewStyle): SVGSVGElement {
  const shapes = sanitizeShapes(model);
  const box = previewViewBox(shapes);
  const mode: PreviewStyle = style === 'outline' || style === 'dots' ? style : 'tint';
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', box.join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const unit = Math.max(box[2], box[3]);
  for (const s of shapes) for (const el of drawShape(s, mode, unit)) svg.appendChild(el);
  return svg;
}

/** The first letter of a title (by code point), upper case; a dot for an empty title. */
export function initialOf(title: string): string {
  const first = Array.from(title.trim())[0];
  return first ? first.toLocaleUpperCase() : '·';
}

/**
 * A real picture of a board or a template, shown on its card in place of the drawn shapes. The card's name is the label, so the
 * picture is decorative. Two kinds:
 * - 'url': an image a server or a file serves. An <img> cannot run script, so anything stored on the server must use this kind.
 * - 'svg': markup from our own code only (blockThumbnailSvg in src/template-thumb.ts, built on this device). Never stored or server
 *   markup: that must be 'url'. It is parsed with DOMParser and the root is moved into the tile, so no string goes through innerHTML.
 * `alt` is accepted but not drawn: the tile is decorative, so the image always has alt="".
 */
export type PreviewImage =
  | { kind: 'svg'; markup: string }
  /** A picture the server keeps. When it does not load (a 404: no picture yet) the caller's `missing` tile is drawn instead. */
  | { kind: 'url'; src: string; alt?: string };

/**
 * The tile of a real picture, or null when the svg markup is not an svg (the caller then draws the shapes instead). When a picture
 * from the server does not load, `missing` (the caller's own tile) takes its place.
 */
export function imageTile(image: PreviewImage, missing?: () => Node): HTMLElement | null {
  const wrap = document.createElement('div');
  wrap.className = 'bc-real';
  if (image.kind === 'url') {
    const img = document.createElement('img');
    img.setAttribute('src', image.src);
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('alt', '');
    img.addEventListener('error', () => {
      if (missing) wrap.replaceChildren(missing());
    }, { once: true });
    wrap.appendChild(img);
    return wrap;
  }
  const root = new DOMParser().parseFromString(image.markup, 'image/svg+xml').documentElement;
  // a parser error comes back as a parsererror root, so only an svg root is drawn (tagName is the name in both XML and HTML)
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;
  wrap.appendChild(root);
  return wrap;
}

/** The quiet tile: a dot grid with the title's first letter (or a plus for a blank board). Text is set with textContent only. */
export function quietPreview(title: string, opts: { plus?: boolean } = {}): HTMLElement {
  const tile = document.createElement('div');
  tile.className = 'bc-quiet';
  tile.setAttribute('aria-hidden', 'true');
  const mark = document.createElement('span');
  mark.className = 'bc-quiet-mark';
  mark.textContent = opts.plus ? '+' : initialOf(title);
  tile.appendChild(mark);
  return tile;
}
