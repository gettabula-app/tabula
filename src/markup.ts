// Pure SVG markup for board objects. Used by the live renderer and by SVG/PNG export.

import type { BaseObj, ConnectorObj, Obj, Point, VAlign } from './types';
import { isConnector } from './types';
import { connectorGeom, pathPoints } from './geometry';
import { headMarkup, shapeDecor, shapePath, textBox } from './shapes';
import { escapeXml, fitText, fontCss, measure, wrap } from './text';
import { fontFamily } from './fonts';
import { CLASS_HEADER, CLASS_LINE, RELATIONS, memberToString } from './uml';
import { CANVAS_INK, INK, PAPER, inkOn } from './palette';

export interface MarkupCtx {
  get: (id: string) => Obj | undefined;
  /** True when a sticky is hidden from this viewer (private writing, not yet revealed). */
  isHidden?: (o: BaseObj) => boolean;
  /** Object whose label is being edited (label is not drawn). */
  editingId?: string | null;
}

const n = (v: number) => Math.round(v * 100) / 100;

export const DEFAULTS = {
  shape: { fill: '#FFFFFF', stroke: INK, strokeWidth: 2, textColor: INK, fontSize: 16, fontWeight: 500, align: 'center' as const, valign: 'middle' as const },
  sticky: { fill: '#FFE16B', stroke: 'none', strokeWidth: 0, textColor: '#1D1A12', fontSize: 20, fontWeight: 500, align: 'center' as const, valign: 'middle' as const },
  text: { fill: 'none', stroke: 'none', strokeWidth: 0, textColor: CANVAS_INK, fontSize: 20, fontWeight: 400, align: 'left' as const, valign: 'top' as const },
  frame: { fill: '#FFFFFF', stroke: 'var(--canvas-rule, #C9D1DA)', strokeWidth: 1, textColor: 'var(--graphite, #5B6672)', fontSize: 14, fontWeight: 600, align: 'left' as const, valign: 'top' as const },
  uml: { fill: '#FFFFFF', stroke: INK, strokeWidth: 1.5, textColor: INK, fontSize: 14, fontWeight: 400, align: 'center' as const, valign: 'middle' as const },
  path: { fill: 'none', stroke: CANVAS_INK, strokeWidth: 3, textColor: CANVAS_INK, fontSize: 16, fontWeight: 400, align: 'center' as const, valign: 'middle' as const },
  icon: { fill: 'none', stroke: CANVAS_INK, strokeWidth: 0, textColor: CANVAS_INK, fontSize: 16, fontWeight: 400, align: 'center' as const, valign: 'middle' as const },
};

export function defaultsFor(o: Obj) {
  if (o.type === 'sticky') return DEFAULTS.sticky;
  if (o.type === 'text') return DEFAULTS.text;
  if (o.type === 'frame') return DEFAULTS.frame;
  if (o.type === 'path') return DEFAULTS.path;
  if (o.type === 'icon') return DEFAULTS.icon;
  if (o.type.startsWith('uml-')) return DEFAULTS.uml;
  return DEFAULTS.shape;
}

/** Fully resolved style for an object. */
export function styleOf(o: Obj) {
  const d = defaultsFor(o);
  const b = o as BaseObj;
  return {
    fill: b.fill ?? d.fill,
    stroke: o.stroke ?? d.stroke,
    strokeWidth: o.strokeWidth ?? d.strokeWidth,
    dash: o.dash ?? 'solid',
    opacity: o.opacity ?? 1,
    font: b.font ?? 'satoshi',
    fontWeight: b.fontWeight ?? d.fontWeight,
    fontSize: b.fontSize ?? d.fontSize,
    textColor: b.textColor ?? (o.type === 'sticky' ? inkOn(b.fill ?? d.fill) : d.textColor),
    align: b.align ?? d.align,
    valign: b.valign ?? d.valign,
  };
}

export const dashArray = (dash: string | undefined, sw: number) =>
  dash === 'dashed' ? `${sw * 4} ${sw * 3}` : dash === 'dotted' ? `0.1 ${sw * 2.5}` : '';

function strokeAttrs(stroke: string, sw: number, dash: string | undefined) {
  if (stroke === 'none' || sw <= 0) return 'stroke="none"';
  const da = dashArray(dash, sw);
  return `stroke="${escapeXml(stroke)}" stroke-width="${sw}"${da ? ` stroke-dasharray="${da}"` : ''}${dash === 'dotted' ? ' stroke-linecap="round"' : ''} stroke-linejoin="round"`;
}

/** Wrapped lines of a text in a box, and the y of the first line's top edge. Shared by the renderer and the editor. */
export function layoutText(
  text: string, box: { x: number; y: number; w: number; h: number },
  s: ReturnType<typeof styleOf>, opts: { valign?: VAlign; shrink?: boolean } = {},
): { lines: string[]; size: number; lineHeight: number; height: number; top: number } {
  const { lines, size, lineHeight, height } = opts.shrink
    ? fitText(text, s.font, s.fontWeight, s.fontSize, box.w, box.h)
    : (() => {
        const lh = n(s.fontSize * 1.3);
        const ls = wrap(text, fontCss(s.font, s.fontSize, s.fontWeight), box.w);
        return { lines: ls, size: s.fontSize, lineHeight: lh, height: ls.length * lh };
      })();
  const v = opts.valign ?? 'middle';
  const top = v === 'top' ? box.y : v === 'bottom' ? box.y + box.h - height : box.y + (box.h - height) / 2;
  return { lines, size, lineHeight, height, top };
}

export function textBlock(
  text: string, box: { x: number; y: number; w: number; h: number },
  s: ReturnType<typeof styleOf>, opts: { valign?: VAlign; shrink?: boolean; italic?: boolean } = {},
): string {
  if (!text) return '';
  const { lines, size, lineHeight, top } = layoutText(text, box, s, opts);
  const anchor = s.align === 'left' ? 'start' : s.align === 'right' ? 'end' : 'middle';
  const x = s.align === 'left' ? box.x : s.align === 'right' ? box.x + box.w : box.x + box.w / 2;
  const tspans = lines
    .map((l, i) => `<tspan x="${n(x)}" y="${n(top + i * lineHeight + lineHeight / 2 + size * 0.35)}">${escapeXml(l) || ' '}</tspan>`)
    .join('');
  return `<text font-family="${escapeXml(fontFamily(s.font))}" font-size="${size}" font-weight="${s.fontWeight}"${opts.italic ? ' font-style="italic"' : ''} fill="${escapeXml(s.textColor)}" text-anchor="${anchor}" xml:space="preserve">${tspans}</text>`;
}

/** Height a text object needs for its content at its current width. */
export function textHeight(o: BaseObj): number {
  const s = styleOf(o);
  const lines = wrap(o.text || ' ', fontCss(s.font, s.fontSize, s.fontWeight), o.w);
  return Math.max(s.fontSize * 1.3, lines.length * s.fontSize * 1.3);
}

function wrapG(o: BaseObj, inner: string, opacity: number) {
  const rot = o.rotation ? ` rotate(${n((o.rotation * 180) / Math.PI)} ${n(o.w / 2)} ${n(o.h / 2)})` : '';
  const op = opacity < 1 ? ` opacity="${opacity}"` : '';
  return `<g transform="translate(${n(o.x)} ${n(o.y)})${rot}"${op}>${inner}</g>`;
}

// Strip anything executable from third-party SVG (Iconify bodies arrive over
// the network and from collaborators' boards).
const iconBodyCache = new Map<string, string>();
export function sanitizeSvgBody(body: string): string {
  const hit = iconBodyCache.get(body);
  if (hit !== undefined) return hit;
  let out = body
    .replace(/<\s*(script|foreignObject|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed)[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
    .replace(/(href\s*=\s*["']?)\s*javascript:[^"'\s>]*/gi, '$1#');
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${out}</svg>`, 'image/svg+xml');
    if (doc.querySelector('parsererror')) out = '';
    else {
      doc.querySelectorAll('script,foreignObject,iframe,object,embed').forEach((el) => el.remove());
      doc.querySelectorAll('*').forEach((el) => {
        for (const a of Array.from(el.attributes)) {
          if (/^on/i.test(a.name) || (/href$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
        }
      });
      out = doc.documentElement.innerHTML;
    }
  }
  iconBodyCache.set(body, out);
  return out;
}

function shapeMarkup(o: BaseObj, ctx: MarkupCtx) {
  const s = styleOf(o);
  const kind = o.kind || 'rect';
  const fill = s.fill === 'none' ? 'none' : escapeXml(s.fill);
  let inner = `<path d="${shapePath(kind, o.w, o.h)}" fill="${fill}" ${strokeAttrs(s.stroke, s.strokeWidth, s.dash)}/>`;
  const decor = shapeDecor(kind, o.w, o.h);
  if (decor) inner += `<path d="${decor}" fill="none" ${strokeAttrs(s.stroke, s.strokeWidth, 'solid')}/>`;
  if (ctx.editingId !== o.id) inner += textBlock(o.text || '', labelBox(o), s, { shrink: true, valign: s.valign });
  return wrapG(o, inner, s.opacity);
}

/** Size of a sticky note's folded corner. */
export const curlSize = (w: number, h: number) => Math.max(10, Math.min(w, h) * 0.15);

/** The box a shape's or sticky's label is laid out in, in object-local coordinates. */
export function labelBox(o: BaseObj) {
  if (o.type === 'sticky') return { x: 14, y: 14, w: Math.max(1, o.w - 28), h: Math.max(1, o.h - 28 - curlSize(o.w, o.h) * 0.35) };
  return textBox(o.kind || 'rect', o.w, o.h);
}

/**
 * A sticky note with its bottom-right corner folded over: the note's edge
 * curves along the crease, the flap lies on the front (lit toward its tip,
 * shaded at the crease) and casts a soft shadow on the paper.
 */
function stickyMarkup(o: BaseObj, ctx: MarkupCtx) {
  const s = styleOf(o);
  const hidden = ctx.isHidden?.(o);
  const w = o.w, h = o.h, k = curlSize(w, h);
  const fill = escapeXml(s.fill);
  // crease from (w, h-k) to (w-k, h), bowed slightly toward the corner
  const crease = `C${n(w - k * 0.22)} ${n(h - k * 0.62)} ${n(w - k * 0.62)} ${n(h - k * 0.22)} ${n(w - k)} ${n(h)}`;
  const body = `M0 0H${n(w)}V${n(h - k)}${crease}H0Z`;
  // the folded flap: the corner reflected over the crease, its edges curling a little
  const tip = { x: w - k * 0.94, y: h - k * 0.94 };
  const flap = `M${n(w)} ${n(h - k)}${crease}Q${n(w - k * 1.04)} ${n(h - k * 0.5)} ${n(tip.x)} ${n(tip.y)}Q${n(w - k * 0.5)} ${n(h - k * 1.04)} ${n(w)} ${n(h - k)}Z`;
  let inner =
    `<path d="${body}" fill="${fill}" filter="url(#sticky-shadow)"/>` +
    `<path d="${body}" fill="url(#sticky-sheen)"/>` +
    // soft shadow the flap casts on the note
    `<path d="${flap}" transform="translate(${n(-k * 0.07)} ${n(-k * 0.07)})" fill="#000" fill-opacity="0.2" filter="url(#sticky-curl-shadow)"/>` +
    `<path d="${flap}" fill="${fill}"/>` +
    `<path d="${flap}" fill="url(#sticky-flap)"/>`;
  const ink = s.textColor;
  if (hidden) {
    const faint = ink === '#FFFFFF' ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.18)';
    inner += `<path d="M14 ${n(h / 2 - 8)}h${n(w - 28)}M14 ${n(h / 2 + 4)}h${n(w * 0.5)}" stroke="${faint}" stroke-width="6" stroke-linecap="round"/>`;
    inner += `<text x="${n((w - k) / 2)}" y="${n(h - 14)}" font-family="${escapeXml(fontFamily('satoshi'))}" font-size="11" fill="${ink === '#FFFFFF' ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.5)'}" text-anchor="middle">Hidden until reveal</text>`;
  } else if (ctx.editingId !== o.id) {
    inner += textBlock(o.text || '', labelBox(o), s, { shrink: true, valign: s.valign });
  }
  return wrapG(o, inner, s.opacity);
}

function textMarkup(o: BaseObj, ctx: MarkupCtx) {
  const s = styleOf(o);
  if (ctx.editingId === o.id) return wrapG(o, '', 1);
  return wrapG(o, textBlock(o.text || '', { x: 0, y: 0, w: o.w, h: o.h }, s, { valign: 'top' }), s.opacity);
}

function frameMarkup(o: BaseObj) {
  const s = styleOf(o);
  const fill = s.fill === 'none' ? 'none' : escapeXml(s.fill);
  const name = escapeXml(o.name || 'Frame');
  return wrapG(
    o,
    `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" rx="6" fill="${fill}" ${strokeAttrs(s.stroke, s.strokeWidth, s.dash)}/>` +
      `<text x="2" y="-10" font-family="${escapeXml(fontFamily(s.font))}" font-size="${s.fontSize}" font-weight="${s.fontWeight}" fill="${escapeXml(s.textColor)}">${name}</text>`,
    s.opacity,
  );
}

function iconMarkup(o: BaseObj) {
  const s = styleOf(o);
  const vb = o.viewBox || [0, 0, 24, 24];
  const color = (o as BaseObj).textColor ?? s.stroke;
  const body = sanitizeSvgBody(o.body || '');
  return wrapG(
    o,
    `<svg x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" viewBox="${vb.join(' ')}" color="${escapeXml(color)}" style="color:${escapeXml(color)}" overflow="visible">${body}</svg>`,
    s.opacity,
  );
}

export function smoothPath(pts: Point[]): string {
  if (!pts.length) return '';
  if (pts.length < 3) return 'M' + pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L');
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${n(pts[i].x)} ${n(pts[i].y)} ${n(mx)} ${n(my)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${n(last.x)} ${n(last.y)}`;
}

function pathMarkup(o: BaseObj) {
  const s = styleOf(o);
  const local = pathPoints(o).map((p) => ({ x: p.x - o.x, y: p.y - o.y }));
  return wrapG(
    o,
    `<path d="${smoothPath(local)}" fill="none" stroke="${escapeXml(s.stroke)}" stroke-width="${s.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    s.opacity,
  );
}

function connectorMarkup(c: ConnectorObj, ctx: MarkupCtx): string {
  const g = connectorGeom(ctx.get, c);
  if (!g) return '';
  const color = c.stroke ?? CANVAS_INK;
  const sw = c.strokeWidth ?? 2;
  const sh = headMarkup(c.startHead, g.start, g.startDir, color, sw);
  const eh = headMarkup(c.endHead, g.end, g.endDir, color, sw);
  // Pull the line back so it ends at each head's base.
  let d = g.d;
  if (sh.inset || eh.inset) {
    const s0 = { x: g.start.x - g.startDir.x * sh.inset, y: g.start.y - g.startDir.y * sh.inset };
    const e0 = { x: g.end.x - g.endDir.x * eh.inset, y: g.end.y - g.endDir.y * eh.inset };
    if (c.route === 'curved') {
      d = d.replace(/^M[^C]+/, `M${n(s0.x)} ${n(s0.y)}`).replace(/ [-\d.e]+ [-\d.e]+$/, ` ${n(e0.x)} ${n(e0.y)}`);
    } else {
      const pts = [...g.pts];
      pts[0] = s0;
      pts[pts.length - 1] = e0;
      d = 'M' + pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L');
    }
  }
  let out = `<path d="${d}" fill="none" ${strokeAttrs(color, sw, c.dash)} stroke-linecap="round"/>` + sh.svg + eh.svg;
  const label = c.label || (c.relation ? RELATIONS[c.relation].text : '') || '';
  if (label && ctx.editingId !== c.id) {
    const { lines, w, h } = labelPill(label);
    out += `<rect x="${n(g.mid.x - w / 2)}" y="${n(g.mid.y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="4" fill="${PAPER}"/>`;
    out += `<text font-family="${escapeXml(fontFamily('satoshi'))}" font-size="13" font-weight="500" fill="${escapeXml(color === 'none' || color === CANVAS_INK ? INK : color)}" text-anchor="middle">` +
      lines.map((l, i) => `<tspan x="${n(g.mid.x)}" y="${n(g.mid.y - h / 2 + 3 + 17 * i + 13)}">${escapeXml(l)}</tspan>`).join('') + '</text>';
  }
  const op = c.opacity !== undefined && c.opacity < 1 ? ` opacity="${c.opacity}"` : '';
  return `<g${op}>${out}</g>`;
}

/** Text metrics of a connector label: 13px, 17px lines, wrapped at 220. */
export const LABEL_FONT = { size: 13, weight: 500, line: 17, padX: 6, padY: 3, wrap: 220 } as const;

/**
 * The paper pill behind a connector label, sized to its text. The label editor uses the same size, so typing a
 * label looks like the label it becomes.
 */
export function labelPill(label: string): { lines: string[]; w: number; h: number } {
  const font = fontCss('satoshi', LABEL_FONT.size, LABEL_FONT.weight);
  const lines = wrap(label, font, LABEL_FONT.wrap);
  const w = Math.max(...lines.map((l) => measure(l, font))) + 2 * LABEL_FONT.padX;
  const h = lines.length * LABEL_FONT.line + 2 * LABEL_FONT.padY;
  return { lines, w, h };
}

// ---------------------------------------------------------------- UML

function umlMarkup(o: BaseObj, ctx: MarkupCtx): string {
  const s = styleOf(o);
  const fill = s.fill === 'none' ? 'none' : escapeXml(s.fill);
  const st = strokeAttrs(s.stroke, s.strokeWidth, s.dash);
  const fam = escapeXml(fontFamily(s.font));
  const ink = escapeXml(s.textColor);
  const editing = ctx.editingId === o.id;
  const label = (text: string, x: number, y: number, o: { size?: number; weight?: number; italic?: boolean; opacity?: number } = {}) =>
    `<text x="${n(x)}" y="${n(y)}" font-family="${fam}" font-size="${o.size ?? s.fontSize}" fill="${ink}" text-anchor="middle"` +
    `${o.weight ? ` font-weight="${o.weight}"` : ''}${o.italic ? ' font-style="italic"' : ''}${o.opacity !== undefined ? ` fill-opacity="${o.opacity}"` : ''}>${escapeXml(text)}</text>`;
  let inner = '';
  switch (o.type) {
    case 'uml-class': {
      const hh = CLASS_HEADER(o);
      inner += `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" fill="${fill}" ${st}/>`;
      inner += `<path d="M0 ${hh}H${n(o.w)}" ${st}/>`;
      const attrs = o.attributes || [];
      const ops = o.operations || [];
      const sepY = hh + 10 + Math.max(1, attrs.length) * CLASS_LINE;
      inner += `<path d="M0 ${n(sepY)}H${n(o.w)}" ${st}/>`;
      if (!editing) {
        const isAbstract = o.stereotype === 'abstract';
        if (o.stereotype && o.stereotype !== 'abstract') {
          inner += label(`«${o.stereotype}»`, o.w / 2, 18, { size: 12, opacity: 0.75 });
        }
        const nameY = o.stereotype && o.stereotype !== 'abstract' ? 36 : hh / 2 + 5;
        inner += label(o.text || 'Class', o.w / 2, isAbstract ? hh / 2 + 5 : nameY, { weight: 700, italic: isAbstract });
        const member = (m: (typeof attrs)[number], y: number) =>
          `<text x="10" y="${n(y)}" font-family="${fam}" font-size="${s.fontSize - 1}" fill="${ink}"${m.isStatic ? ' text-decoration="underline"' : ''}${m.isAbstract ? ' font-style="italic"' : ''}>${escapeXml(memberToString(m))}</text>`;
        attrs.forEach((m, i) => (inner += member(m, hh + 8 + CLASS_LINE * i + 12)));
        ops.forEach((m, i) => (inner += member(m, sepY + 8 + CLASS_LINE * i + 12)));
      }
      break;
    }
    case 'uml-actor': {
      const cx = o.w / 2, headR = Math.min(o.w * 0.2, o.h * 0.1);
      const bodyTop = headR * 2 + 4, bodyBottom = o.h * 0.58, legBottom = o.h * 0.78;
      inner += `<circle cx="${n(cx)}" cy="${n(headR + 2)}" r="${n(headR)}" fill="${fill}" ${st}/>`;
      inner += `<path d="M${n(cx)} ${n(bodyTop)}V${n(bodyBottom)}M${n(o.w * 0.12)} ${n(o.h * 0.36)}H${n(o.w * 0.88)}M${n(cx)} ${n(bodyBottom)}L${n(o.w * 0.15)} ${n(legBottom)}M${n(cx)} ${n(bodyBottom)}L${n(o.w * 0.85)} ${n(legBottom)}" fill="none" ${st}/>`;
      if (!editing) inner += label(o.text || 'Actor', cx, o.h - 4);
      break;
    }
    case 'uml-usecase':
      inner += `<ellipse cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" rx="${n(o.w / 2)}" ry="${n(o.h / 2)}" fill="${fill}" ${st}/>`;
      if (!editing) inner += textBlock(o.text || '', { x: o.w * 0.15, y: o.h * 0.15, w: o.w * 0.7, h: o.h * 0.7 }, s, { shrink: true });
      break;
    case 'uml-lifeline': {
      const hh = 44;
      inner += `<rect x="0" y="0" width="${n(o.w)}" height="${hh}" fill="${fill}" ${st}/>`;
      inner += `<path d="M${n(o.w / 2)} ${hh}V${n(o.h)}" ${strokeAttrs(s.stroke, s.strokeWidth, 'dashed')}/>`;
      if (!editing) inner += textBlock(o.text || '', { x: 6, y: 4, w: o.w - 12, h: hh - 8 }, { ...s, fontWeight: 600 }, { shrink: true });
      break;
    }
    case 'uml-note': {
      const k = 14;
      inner += `<path d="M0 0H${n(o.w - k)}L${n(o.w)} ${k}V${n(o.h)}H0Z" fill="${fill === '#FFFFFF' ? '#FFFBE6' : fill}" ${st}/>`;
      inner += `<path d="M${n(o.w - k)} 0V${k}H${n(o.w)}" fill="none" ${st}/>`;
      if (!editing) inner += textBlock(o.text || '', { x: 10, y: 10, w: o.w - 28, h: o.h - 20 }, { ...s, align: 'left' }, { valign: 'top' });
      break;
    }
    case 'uml-package': {
      const tabW = Math.min(o.w * 0.45, Math.max(80, measure(o.text || '', fontCss(s.font, s.fontSize, 600)) + 24));
      inner += `<path d="M0 0H${n(tabW)}V24H0Z" fill="${fill}" ${st}/>`;
      inner += `<rect x="0" y="24" width="${n(o.w)}" height="${n(Math.max(0, o.h - 24))}" fill="${fill === '#FFFFFF' ? 'none' : fill}" ${st}/>`;
      if (!editing) inner += `<text x="10" y="17" font-family="${fam}" font-size="${s.fontSize - 1}" font-weight="600" fill="${ink}">${escapeXml(o.text || 'package')}</text>`;
      break;
    }
    case 'uml-state':
      inner += `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" rx="${n(Math.min(18, o.h / 2))}" fill="${fill}" ${st}/>`;
      if (!editing) inner += textBlock(o.text || '', { x: 10, y: 6, w: o.w - 20, h: o.h - 12 }, s, { shrink: true });
      break;
    case 'uml-initial':
      inner += `<circle cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" r="${n(Math.min(o.w, o.h) / 2)}" fill="${escapeXml(s.stroke === 'none' ? INK : s.stroke)}"/>`;
      break;
    case 'uml-final': {
      const r0 = Math.min(o.w, o.h) / 2;
      inner += `<circle cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" r="${n(r0 - 1)}" fill="${fill}" ${st}/>`;
      inner += `<circle cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" r="${n(r0 * 0.6)}" fill="${escapeXml(s.stroke === 'none' ? INK : s.stroke)}"/>`;
      break;
    }
    case 'uml-component': {
      inner += `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" fill="${fill}" ${st}/>`;
      const ix = o.w - 30;
      inner += `<rect x="${n(ix)}" y="8" width="18" height="22" fill="${fill}" ${strokeAttrs(s.stroke, 1.25, 'solid')}/>`;
      inner += `<rect x="${n(ix - 5)}" y="12" width="10" height="5" fill="${fill}" ${strokeAttrs(s.stroke, 1.25, 'solid')}/><rect x="${n(ix - 5)}" y="21" width="10" height="5" fill="${fill}" ${strokeAttrs(s.stroke, 1.25, 'solid')}/>`;
      if (!editing) inner += textBlock(`«component»\n${o.text || ''}`, { x: 10, y: 8, w: o.w - 50, h: o.h - 16 }, s, { shrink: true });
      break;
    }
  }
  return wrapG(o, inner, s.opacity);
}

/** SVG markup for one object in world coordinates. */
export function objectMarkup(o: Obj, ctx: MarkupCtx): string {
  if (isConnector(o)) return connectorMarkup(o, ctx);
  switch (o.type) {
    case 'shape': return shapeMarkup(o, ctx);
    case 'sticky': return stickyMarkup(o, ctx);
    case 'text': return textMarkup(o, ctx);
    case 'frame': return frameMarkup(o);
    case 'icon': return iconMarkup(o);
    case 'path': return pathMarkup(o);
    default:
      if (o.type.startsWith('uml-')) return umlMarkup(o, ctx);
      return '';
  }
}

export const SVG_DEFS =
  `<filter id="sticky-shadow" x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#18212B" flood-opacity="0.16"/></filter>` +
  // adhesive strip slightly darker at the top, paper catching light lower down
  `<linearGradient id="sticky-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.05"/><stop offset="0.2" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#FFF" stop-opacity="0.06"/></linearGradient>` +
  `<filter id="sticky-curl-shadow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.8"/></filter>` +
  // folded flap: shaded at the crease (bottom right), lit toward its tip
  `<linearGradient id="sticky-flap" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.14"/><stop offset="0.4" stop-color="#FFF" stop-opacity="0.18"/><stop offset="1" stop-color="#FFF" stop-opacity="0.55"/></linearGradient>`;
