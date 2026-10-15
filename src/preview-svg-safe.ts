// The whitelist for the SVG of a board picture (TAB-375 slice 3 demo, client render). Everything a picture is drawn from passes through
// sanitizePictureSvg before it is rasterised, so the only elements, attributes and values that can reach the canvas are the ones below.
// Nothing here is ever inserted into the page: the SVG is loaded only as an <img> (a blob: URL), and it is never stored or served.
//
// The reader is a small XML-subset parser that refuses what it cannot read as plain markup: comments, processing instructions, DOCTYPE,
// unknown entities, and raw `<` inside an attribute. A refused input is an error, not a picture.

/** Elements a picture may use. Anything else (script, style, foreignObject, use, a, filter, animate, marker, pattern, ...) is dropped with its children. */
export const PICTURE_ELEMENTS = [
  'svg', 'g', 'defs', 'clipPath', 'linearGradient', 'radialGradient', 'stop',
  'rect', 'circle', 'ellipse', 'path', 'line', 'polyline', 'polygon', 'text', 'tspan', 'image',
] as const;

/** The font every text in a picture is drawn in: a fixed system stack, no external font (no @font-face, no board font file). */
export const PICTURE_FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Longest picture source accepted (characters); a picture is at most a few hundred objects. */
export const MAX_PICTURE_SOURCE = 4_000_000;
/** Longest text node kept (characters). */
export const MAX_TEXT_NODE = 1_000;
/** The data: image types an <image> may carry (our own embedded pictures of the board's images). */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const DATA_IMAGE_MAX = 3_000_000;

export interface SvgElement { name: string; attrs: [string, string][]; children: SvgNode[] }
export interface SvgText { text: string }
export type SvgNode = SvgElement | SvgText;

export class SvgSyntaxError extends Error {}

const NAME = /[A-Za-z_][-A-Za-z0-9_:.]*/y;
const ENTITY = /&(?!(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);)/;

function decode(raw: string): string {
  if (ENTITY.test(raw)) throw new SvgSyntaxError('an entity other than the five named ones and numeric references');
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) throw new SvgSyntaxError('a numeric reference out of range');
      return String.fromCodePoint(code);
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });
}

/**
 * Reads an SVG document of the subset above into a tree. Throws SvgSyntaxError for anything outside the subset (an error, so the
 * caller falls back to the blocks picture rather than drawing a half-read file).
 */
export function parseSvgSubset(input: string): SvgElement {
  if (typeof input !== 'string' || input.length > MAX_PICTURE_SOURCE) throw new SvgSyntaxError('the source is not text or is too long');
  const root: SvgElement = { name: '#document', attrs: [], children: [] };
  const stack: SvgElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  while (i < input.length) {
    if (input[i] !== '<') {
      const end = input.indexOf('<', i);
      const stop = end < 0 ? input.length : end;
      top().children.push({ text: decode(input.slice(i, stop)) });
      i = stop;
      continue;
    }
    if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i + 9);
      if (end < 0) throw new SvgSyntaxError('an unclosed CDATA section');
      top().children.push({ text: input.slice(i + 9, end) });
      i = end + 3;
      continue;
    }
    if (input.startsWith('<!', i) || input.startsWith('<?', i)) throw new SvgSyntaxError('a comment, DOCTYPE or processing instruction');
    if (input.startsWith('</', i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(input);
      if (!m) throw new SvgSyntaxError('a closing tag without a name');
      i = NAME.lastIndex;
      while (/\s/.test(input[i] ?? '')) i++;
      if (input[i] !== '>') throw new SvgSyntaxError('a closing tag not ended');
      i++;
      if (stack.length === 1 || top().name !== m[0]) throw new SvgSyntaxError('mismatched closing tag');
      stack.pop();
      continue;
    }
    i++;
    NAME.lastIndex = i;
    const m = NAME.exec(input);
    if (!m) throw new SvgSyntaxError('a tag without a name');
    i = NAME.lastIndex;
    const el: SvgElement = { name: m[0], attrs: [], children: [] };
    let selfClosing = false;
    for (;;) {
      while (/\s/.test(input[i] ?? '')) i++;
      if (input[i] === '/' && input[i + 1] === '>') {
        selfClosing = true;
        i += 2;
        break;
      }
      if (input[i] === '>') {
        i++;
        break;
      }
      NAME.lastIndex = i;
      const a = NAME.exec(input);
      if (!a) throw new SvgSyntaxError('an attribute without a name');
      i = NAME.lastIndex;
      while (/\s/.test(input[i] ?? '')) i++;
      if (input[i] !== '=') throw new SvgSyntaxError('an attribute without a value');
      i++;
      while (/\s/.test(input[i] ?? '')) i++;
      const quote = input[i];
      if (quote !== '"' && quote !== "'") throw new SvgSyntaxError('an attribute value not quoted');
      const end = input.indexOf(quote, i + 1);
      if (end < 0) throw new SvgSyntaxError('an unclosed attribute value');
      const raw = input.slice(i + 1, end);
      if (raw.includes('<')) throw new SvgSyntaxError('a < inside an attribute value');
      if (el.attrs.some(([k]) => k === a[0])) throw new SvgSyntaxError('a repeated attribute');
      el.attrs.push([a[0], decode(raw)]);
      i = end + 1;
    }
    top().children.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (stack.length !== 1) throw new SvgSyntaxError('an element that is not closed');
  const elements = root.children.filter((c): c is SvgElement => 'name' in c);
  const loose = root.children.some((c) => 'text' in c && c.text.trim() !== '');
  if (elements.length !== 1 || loose || elements[0]!.name !== 'svg') throw new SvgSyntaxError('the document is not one svg element');
  return elements[0]!;
}

// ---------------------------------------------------------------- attribute values

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const LOCAL_URL = /^url\(#([A-Za-z][\w-]{0,63})\)$/;
const ID = /^[A-Za-z][\w-]{0,63}$/;
const TRANSFORM = /^(?:\s*(?:translate|scale|rotate|matrix)\(\s*[-+\d.eE,\s]*\))*\s*$/;
const PATH_DATA = /^[MLHVCSQTAZmlhvcsqtaz0-9eE .,+-]*$/;
const POINTS = /^[-+\d.eE,\s]*$/;
const VIEWBOX = /^\s*[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+[-+\d.eE]+\s*$/;
const ASPECT = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/;
const DASH = /^[\d.,\s-]*$/;
const OFFSET = /^(?:[-+]?(?:\d+\.?\d*|\.\d+)%?)$/;

const num = (v: string) => (NUMBER.test(v.trim()) && Math.abs(Number(v)) <= 1e9 ? v.trim() : null);
const unit = (v: string) => (num(v) !== null && Number(v) >= 0 && Number(v) <= 1 ? v.trim() : null);
const oneOf = (...allowed: string[]) => (v: string) => (allowed.includes(v.trim()) ? v.trim() : null);

/** A paint: none, transparent, a plain hex colour, or a reference to a gradient or clip path of this picture (checked later). */
function paint(v: string): string | null {
  const s = v.trim();
  if (s === 'none' || s === 'transparent') return s;
  if (HEX.test(s)) return s;
  if (LOCAL_URL.test(s)) return s;
  return null;
}

const localUrl = (v: string) => (LOCAL_URL.test(v.trim()) ? v.trim() : null);
const transform = (v: string) => (TRANSFORM.test(v) && v.length <= 300 ? v : null);
const idValue = (v: string) => (ID.test(v) ? v : null);
const pathData = (v: string) => (v.length <= 200_000 && PATH_DATA.test(v) ? v : null);
const pointList = (v: string) => (v.length <= 200_000 && POINTS.test(v) ? v : null);
const viewBox = (v: string) => (VIEWBOX.test(v) ? v.trim().replace(/\s*,\s*|\s+/g, ' ') : null);
const aspect = (v: string) => (ASPECT.test(v.trim()) ? v.trim() : null);
const dash = (v: string) => (DASH.test(v) && v.length <= 200 ? v : null);
const offset = (v: string) => (OFFSET.test(v.trim()) ? v.trim() : null);
const dataImage = (v: string) => (v.length <= DATA_IMAGE_MAX && DATA_IMAGE.test(v) ? v : null);
const fontWeight = (v: string) => (oneOf('normal', 'bold', 'bolder', 'lighter')(v) ?? num(v));
const ariaHidden = oneOf('true', 'false');
const focusable = oneOf('false');
const clipUnits = oneOf('userSpaceOnUse', 'objectBoundingBox');

type Check = (value: string) => string | null;

const COMMON: Record<string, Check> = {
  id: idValue,
  fill: paint, 'fill-opacity': unit, 'fill-rule': oneOf('nonzero', 'evenodd'),
  stroke: paint, 'stroke-opacity': unit, 'stroke-width': num, 'stroke-dasharray': dash, 'stroke-dashoffset': num,
  'stroke-linecap': oneOf('butt', 'round', 'square'), 'stroke-linejoin': oneOf('miter', 'round', 'bevel'),
  opacity: unit, transform, 'clip-path': localUrl, 'vector-effect': oneOf('non-scaling-stroke'),
};
const TEXT_ATTRS: Record<string, Check> = {
  x: num, y: num, dx: num, dy: num, 'font-size': num, 'font-weight': fontWeight, 'font-style': oneOf('normal', 'italic'),
  'font-family': (v) => v, // replaced by PICTURE_FONT_STACK below, whatever the source said
  'text-anchor': oneOf('start', 'middle', 'end'),
  'dominant-baseline': oneOf('auto', 'middle', 'central', 'hanging', 'alphabetic', 'ideographic', 'text-before-edge', 'text-after-edge'),
  'letter-spacing': num,
};

/** The attributes each allowed element may carry, with the check of each value. */
export const PICTURE_ATTRIBUTES: Record<string, Record<string, Check>> = {
  svg: { viewBox, width: num, height: num, preserveAspectRatio: aspect, xmlns: (v) => (v === 'http://www.w3.org/2000/svg' ? v : null), 'font-family': (v) => (v === PICTURE_FONT_STACK ? v : null), 'aria-hidden': ariaHidden, focusable },
  g: { ...COMMON },
  defs: { id: idValue },
  clipPath: { id: idValue, clipPathUnits: clipUnits, transform },
  linearGradient: { id: idValue, x1: num, y1: num, x2: num, y2: num, gradientUnits: clipUnits, gradientTransform: transform, spreadMethod: oneOf('pad', 'reflect', 'repeat') },
  radialGradient: { id: idValue, cx: num, cy: num, r: num, fx: num, fy: num, gradientUnits: clipUnits, gradientTransform: transform },
  stop: { offset, 'stop-color': paint, 'stop-opacity': unit },
  rect: { ...COMMON, x: num, y: num, width: num, height: num, rx: num, ry: num },
  circle: { ...COMMON, cx: num, cy: num, r: num },
  ellipse: { ...COMMON, cx: num, cy: num, rx: num, ry: num },
  path: { ...COMMON, d: pathData },
  line: { ...COMMON, x1: num, y1: num, x2: num, y2: num },
  polyline: { ...COMMON, points: pointList },
  polygon: { ...COMMON, points: pointList },
  text: { ...COMMON, ...TEXT_ATTRS },
  tspan: { ...COMMON, ...TEXT_ATTRS },
  image: { ...COMMON, x: num, y: num, width: num, height: num, href: dataImage, preserveAspectRatio: aspect },
};

/** Elements whose text is drawn. Text anywhere else is dropped. */
const TEXT_ELEMENTS = new Set(['text', 'tspan']);
const GRADIENTS = new Set(['linearGradient', 'radialGradient']);

// ---------------------------------------------------------------- the filter

interface Filtered { name: string; attrs: [string, string][]; children: (Filtered | string)[] }

function cleanText(text: string): string {
  // control characters out (a tab and a line break stay); a text node is cut at MAX_TEXT_NODE characters
  // oxlint-disable-next-line no-control-regex -- control characters are removed on purpose
  const plain = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  return Array.from(plain).slice(0, MAX_TEXT_NODE).join('');
}

/** The declarations of a style attribute as [property, value] pairs. Nothing else is read from it: no selectors, no url(), no @-rules. */
function declarations(style: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of style.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const prop = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (/^[a-z-]+$/.test(prop) && value !== '') out.push([prop, value]);
  }
  return out;
}

function filterElement(el: SvgElement, parent: string | null): Filtered | null {
  if (!(PICTURE_ELEMENTS as readonly string[]).includes(el.name)) return null;
  if (el.name === 'svg' && parent !== null) return null;
  if (el.name === 'stop' && (parent === null || !GRADIENTS.has(parent))) return null;
  const checks = PICTURE_ATTRIBUTES[el.name]!;
  const attrs: [string, string][] = [];
  const set = (key: string, raw: string) => {
    const check = checks[key];
    if (!check || attrs.some(([k]) => k === key)) return;
    if (key === 'font-family') {
      attrs.push([key, PICTURE_FONT_STACK]);
      return;
    }
    const value = check(raw);
    if (value !== null) attrs.push([key, value]);
  };
  for (const [key, raw] of el.attrs) if (key !== 'style') set(key, raw);
  // the presentation declarations of a style attribute, read as the attributes they stand for (only properties the element may take)
  for (const [key, raw] of el.attrs) if (key === 'style') for (const [prop, value] of declarations(raw)) set(prop, value);
  const children: (Filtered | string)[] = [];
  for (const child of el.children) {
    if ('text' in child) {
      if (TEXT_ELEMENTS.has(el.name)) children.push(cleanText(child.text));
      continue;
    }
    const kept = filterElement(child, el.name);
    if (kept) children.push(kept);
  }
  return { name: el.name, attrs, children };
}

/** The ids a picture defines, and the local references it makes (fill, stroke, clip-path). A reference to an id that is not defined is dropped. */
function collectIds(node: Filtered, ids: Set<string>): void {
  const id = node.attrs.find(([k]) => k === 'id');
  if (id) ids.add(id[1]);
  for (const c of node.children) if (typeof c !== 'string') collectIds(c, ids);
}

function prune(node: Filtered, ids: Set<string>): Filtered {
  const attrs = node.attrs.filter(([k, v]) => {
    const local = LOCAL_URL.exec(v);
    if (!local) return true;
    return (k === 'fill' || k === 'stroke' || k === 'clip-path') && ids.has(local[1]!);
  });
  return {
    name: node.name,
    attrs,
    children: node.children.map((c) => (typeof c === 'string' ? c : prune(c, ids))),
  };
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function write(node: Filtered): string {
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const body = node.children.map((c) => (typeof c === 'string' ? esc(c) : write(c))).join('');
  return body === '' && node.name !== 'text' && node.name !== 'tspan' ? `<${node.name}${attrs}/>` : `<${node.name}${attrs}>${body}</${node.name}>`;
}

export interface PictureFrame {
  /** The view of the picture on the board, [x, y, width, height]. */
  viewBox: [number, number, number, number];
  /** Pixels of the picture. */
  width: number;
  height: number;
  /** The paper the picture is drawn on, behind everything. */
  background: string;
}

/**
 * The picture's SVG as the whitelist allows it, on the given frame: the drawing of `source` (an exporter's or the blocks' SVG) with
 * only whitelisted elements, attributes and values, every text in PICTURE_FONT_STACK, and a background rectangle. Throws
 * SvgSyntaxError when the source is not in the subset (the caller then draws the blocks picture instead).
 */
export function sanitizePictureSvg(source: string, frame: PictureFrame): string {
  const root = parseSvgSubset(source);
  const body = filterElement(root, null);
  if (!body) throw new SvgSyntaxError('the root svg is not allowed');
  const ids = new Set<string>();
  for (const c of body.children) if (typeof c !== 'string') collectIds(c, ids);
  const pruned = body.children.map((c) => (typeof c === 'string' ? c : prune(c, ids)));
  const [x, y, w, h] = frame.viewBox.map((v) => (Number.isFinite(v) ? v : 0));
  const bg = paint(frame.background) ?? '#FFFFFF';
  const picture = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(frame.width)}" height="${Math.round(frame.height)}"`
    + ` viewBox="${x} ${y} ${w} ${h}" preserveAspectRatio="xMidYMid meet" font-family="${esc(PICTURE_FONT_STACK)}" aria-hidden="true" focusable="false">`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${esc(bg)}"/>`
    + pruned.map((c) => (typeof c === 'string' ? '' : write(c))).join('')
    + '</svg>';
  return picture;
}

/**
 * What the whitelist would still drop from an SVG string: an empty list means the string is already a picture the whitelist allows
 * (the test of the emitted picture uses this on the output of sanitizePictureSvg).
 */
export function whitelistProblems(svg: string): string[] {
  const problems: string[] = [];
  let root: SvgElement;
  try {
    root = parseSvgSubset(svg);
  } catch (err) {
    return [`not read: ${(err as Error).message}`];
  }
  const walk = (el: SvgElement, parent: string | null) => {
    if (!(PICTURE_ELEMENTS as readonly string[]).includes(el.name)) problems.push(`element ${el.name}`);
    else if (el.name === 'svg' && parent !== null) problems.push('nested svg');
    else if (el.name === 'stop' && (parent === null || !GRADIENTS.has(parent))) problems.push('stop outside a gradient');
    const checks = PICTURE_ATTRIBUTES[el.name] ?? {};
    for (const [key, value] of el.attrs) {
      const check = checks[key];
      if (!check) problems.push(`attribute ${el.name}/${key}`);
      else if (key !== 'font-family' && check(value) === null) problems.push(`value ${el.name}/${key}`);
      if (key === 'font-family' && value !== PICTURE_FONT_STACK) problems.push(`font ${value}`);
    }
    for (const child of el.children) {
      if ('text' in child) {
        if (child.text.trim() !== '' && !TEXT_ELEMENTS.has(el.name)) problems.push(`text in ${el.name}`);
        if (child.text.length > MAX_TEXT_NODE) problems.push('text too long');
      } else walk(child, el.name);
    }
  };
  walk(root, null);
  return problems;
}
