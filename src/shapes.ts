import type { Head, Point, Rect, ShapeKind, Side } from './types';

export type ShapeGroup = 'basic' | 'arrows' | 'callouts' | 'flow';

export const SHAPE_KINDS: { kind: ShapeKind; label: string; group: ShapeGroup }[] = [
  { kind: 'rect', label: 'Rectangle', group: 'basic' },
  { kind: 'rounded', label: 'Rounded rectangle', group: 'basic' },
  { kind: 'ellipse', label: 'Ellipse', group: 'basic' },
  { kind: 'triangle', label: 'Triangle', group: 'basic' },
  { kind: 'diamond', label: 'Diamond', group: 'basic' },
  { kind: 'hexagon', label: 'Hexagon', group: 'basic' },
  { kind: 'octagon', label: 'Octagon', group: 'basic' },
  { kind: 'parallelogram', label: 'Parallelogram', group: 'basic' },
  { kind: 'trapezoid', label: 'Trapezoid', group: 'basic' },
  { kind: 'star', label: 'Star', group: 'basic' },
  { kind: 'pentagon', label: 'Pentagon', group: 'basic' },
  { kind: 'cross', label: 'Cross', group: 'basic' },
  { kind: 'heart', label: 'Heart', group: 'basic' },
  { kind: 'cloud', label: 'Cloud', group: 'basic' },
  { kind: 'arrow-right', label: 'Arrow right', group: 'arrows' },
  { kind: 'arrow-left', label: 'Arrow left', group: 'arrows' },
  { kind: 'arrow-both', label: 'Double arrow', group: 'arrows' },
  { kind: 'chevron', label: 'Chevron', group: 'arrows' },
  { kind: 'arrow-pentagon', label: 'Pentagon arrow', group: 'arrows' },
  { kind: 'callout-rect', label: 'Speech box', group: 'callouts' },
  { kind: 'callout-round', label: 'Speech bubble', group: 'callouts' },
  { kind: 'terminator', label: 'Terminator', group: 'flow' },
  { kind: 'document', label: 'Document', group: 'flow' },
  { kind: 'cylinder', label: 'Database', group: 'flow' },
  { kind: 'manual-input', label: 'Manual input', group: 'flow' },
  { kind: 'predefined', label: 'Predefined process', group: 'flow' },
  { kind: 'delay', label: 'Delay', group: 'flow' },
  { kind: 'merge', label: 'Merge', group: 'flow' },
  { kind: 'off-page', label: 'Off-page connector', group: 'flow' },
  { kind: 'manual-operation', label: 'Manual operation', group: 'flow' },
  { kind: 'display', label: 'Display', group: 'flow' },
];

export const SHAPE_GROUPS: [ShapeGroup, string][] = [['basic', 'Basic'], ['arrows', 'Arrows'], ['callouts', 'Callouts'], ['flow', 'Flowchart']];

export function defaultSize(kind: ShapeKind): { w: number; h: number } {
  switch (kind) {
    case 'ellipse':
    case 'diamond':
    case 'star':
    case 'octagon':
    case 'pentagon':
    case 'cross':
    case 'heart':
    case 'triangle':
    case 'merge':
      return { w: 144, h: 144 };
    case 'cloud':
    case 'callout-rect':
    case 'callout-round':
      return { w: 192, h: 128 };
    default:
      return { w: 192, h: 96 };
  }
}

const poly = (pts: [number, number][]) => 'M' + pts.map(([x, y]) => `${r(x)} ${r(y)}`).join('L') + 'Z';
const r = (n: number) => Math.round(n * 100) / 100;

/** Vertex list of a polygon-outlined kind in a w×h box anchored at (0,0); null for other kinds. */
export function shapePolygon(kind: ShapeKind, w: number, h: number): [number, number][] | null {
  switch (kind) {
    case 'triangle':
      return [[w / 2, 0], [w, h], [0, h]];
    case 'diamond':
      return [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
    case 'hexagon': {
      const k = Math.min(w / 4, h / 2);
      return [[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]];
    }
    case 'octagon': {
      const k = Math.min(w, h) * 0.29;
      return [[k, 0], [w - k, 0], [w, k], [w, h - k], [w - k, h], [k, h], [0, h - k], [0, k]];
    }
    case 'parallelogram': {
      const k = Math.min(w / 4, h);
      return [[k, 0], [w, 0], [w - k, h], [0, h]];
    }
    case 'trapezoid': {
      const k = Math.min(w / 4, h);
      return [[k, 0], [w - k, 0], [w, h], [0, h]];
    }
    case 'manual-input':
      return [[0, h * 0.25], [w, 0], [w, h], [0, h]];
    case 'star': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? 0.5 : 0.21;
        pts.push([w / 2 + Math.cos(a) * w * rr, h * 0.53 + Math.sin(a) * h * rr * 1.05]);
      }
      return pts;
    }
    case 'pentagon':
      return [[w * 0.5, 0], [w, h * 0.38], [w * 0.81, h], [w * 0.19, h], [0, h * 0.38]];
    case 'cross': {
      const a = w / 3, b = h / 3;
      return [[a, 0], [w - a, 0], [w - a, b], [w, b], [w, h - b], [w - a, h - b], [w - a, h], [a, h], [a, h - b], [0, h - b], [0, b], [a, b]];
    }
    case 'arrow-right': {
      const hd = Math.min(w * 0.3, h * 0.6);
      return [[0, h * 0.25], [w - hd, h * 0.25], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h * 0.75], [0, h * 0.75]];
    }
    case 'arrow-left': {
      const hd = Math.min(w * 0.3, h * 0.6);
      return [[w, h * 0.25], [hd, h * 0.25], [hd, 0], [0, h / 2], [hd, h], [hd, h * 0.75], [w, h * 0.75]];
    }
    case 'arrow-both': {
      const hd = Math.min(w * 0.3, h * 0.6);
      return [[0, h / 2], [hd, 0], [hd, h * 0.25], [w - hd, h * 0.25], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h * 0.75], [hd, h * 0.75], [hd, h]];
    }
    case 'chevron': {
      const k = Math.min(w * 0.3, h * 0.5);
      return [[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h], [k, h / 2]];
    }
    case 'arrow-pentagon': {
      const k = Math.min(w * 0.3, h * 0.5);
      return [[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h]];
    }
    case 'callout-rect': {
      const bh = h * 0.78;
      return [[0, 0], [w, 0], [w, bh], [w * 0.4, bh], [w * 0.15, h], [w * 0.2, bh], [0, bh]];
    }
    case 'merge':
      return [[0, 0], [w, 0], [w / 2, h]];
    case 'off-page':
      return [[0, 0], [w, 0], [w, h * 0.7], [w / 2, h], [0, h * 0.7]];
    case 'manual-operation': {
      const k = Math.min(w * 0.2, h);
      return [[0, 0], [w, 0], [w - k, h], [k, h]];
    }
    default:
      return null;
  }
}

/** Outline of a shape kind in a w×h box anchored at (0,0). */
export function shapePath(kind: ShapeKind, w: number, h: number): string {
  switch (kind) {
    case 'rect':
    case 'predefined':
      return `M0 0H${w}V${h}H0Z`;
    case 'rounded': {
      const k = Math.min(16, w / 4, h / 4);
      return `M${k} 0H${w - k}Q${w} 0 ${w} ${k}V${h - k}Q${w} ${h} ${w - k} ${h}H${k}Q0 ${h} 0 ${h - k}V${k}Q0 0 ${k} 0Z`;
    }
    case 'ellipse':
      return `M0 ${h / 2}A${w / 2} ${h / 2} 0 1 0 ${w} ${h / 2}A${w / 2} ${h / 2} 0 1 0 0 ${h / 2}Z`;
    case 'triangle':
    case 'diamond':
    case 'hexagon':
    case 'octagon':
    case 'parallelogram':
    case 'trapezoid':
    case 'manual-input':
    case 'star':
    case 'pentagon':
    case 'cross':
    case 'arrow-right':
    case 'arrow-left':
    case 'arrow-both':
    case 'chevron':
    case 'arrow-pentagon':
    case 'callout-rect':
    case 'merge':
    case 'off-page':
    case 'manual-operation':
      return poly(shapePolygon(kind, w, h)!);
    case 'heart': {
      const sx = w / 100, sy = h / 90;
      const p = (x: number, y: number) => `${r(x * sx)} ${r(y * sy)}`;
      return `M${p(50, 90)}C${p(10, 60)} ${p(0, 35)} ${p(0, 25)}C${p(0, 10)} ${p(12, 0)} ${p(27, 0)}C${p(38, 0)} ${p(46, 6)} ${p(50, 14)}C${p(54, 6)} ${p(62, 0)} ${p(73, 0)}C${p(88, 0)} ${p(100, 10)} ${p(100, 25)}C${p(100, 35)} ${p(90, 60)} ${p(50, 90)}Z`;
    }
    case 'cloud': {
      const sx = w / 100, sy = h / 60;
      const p = (x: number, y: number) => `${r(x * sx)} ${r(y * sy)}`;
      const arc = (rx: number, ry: number) => `A${r(rx * sx)} ${r(ry * sy)} 0 0 1`;
      return `M${p(25, 60)}${arc(22, 22)} ${p(20, 17)}${arc(26, 26)} ${p(62, 8)}${arc(22, 22)} ${p(92, 30)}${arc(18, 18)} ${p(78, 60)}Z`;
    }
    case 'terminator': {
      const k = Math.min(h / 2, w / 2);
      return `M${k} 0H${w - k}A${k} ${h / 2} 0 0 1 ${w - k} ${h}H${k}A${k} ${h / 2} 0 0 1 ${k} 0Z`;
    }
    case 'document': {
      const k = h * 0.12;
      return `M0 0H${w}V${h - k}C${w * 0.75} ${h - 3 * k} ${w * 0.25} ${h + k} 0 ${h - k}Z`;
    }
    case 'cylinder': {
      const k = Math.min(h * 0.15, 18);
      return `M0 ${k}A${w / 2} ${k} 0 0 1 ${w} ${k}V${h - k}A${w / 2} ${k} 0 0 1 0 ${h - k}Z`;
    }
    case 'callout-round': {
      const bh = h * 0.78, kk = Math.min(16, w / 4, bh / 4);
      return `M${kk} 0H${w - kk}Q${w} 0 ${w} ${kk}V${bh - kk}Q${w} ${bh} ${w - kk} ${bh}H${w * 0.4}L${w * 0.15} ${h}L${w * 0.2} ${bh}H${kk}Q0 ${bh} 0 ${bh - kk}V${kk}Q0 0 ${kk} 0Z`;
    }
    case 'delay':
      return `M0 0H${w / 2}A${w / 2} ${h / 2} 0 0 1 ${w / 2} ${h}H0Z`;
    case 'display': {
      const kd = Math.min(w * 0.2, h / 2);
      return `M0 ${h / 2}L${kd} 0H${w - kd}A${kd} ${h / 2} 0 0 1 ${w - kd} ${h}H${kd}Z`;
    }
  }
}

/** Extra strokes drawn on top of the outline (inner lines on some kinds). */
export function shapeDecor(kind: ShapeKind, w: number, h: number): string {
  if (kind === 'cylinder') {
    const k = Math.min(h * 0.15, 18);
    return `M0 ${k}A${w / 2} ${k} 0 0 0 ${w} ${k}`;
  }
  if (kind === 'predefined') {
    const k = Math.min(12, w / 8);
    return `M${k} 0V${h}M${w - k} 0V${h}`;
  }
  return '';
}

/** Area available for a label inside the shape, in local coordinates. */
export function textBox(kind: ShapeKind, w: number, h: number): Rect {
  const pad = 10;
  switch (kind) {
    case 'ellipse':
      return { x: w * 0.15, y: h * 0.15, w: w * 0.7, h: h * 0.7 };
    case 'diamond':
      return { x: w * 0.22, y: h * 0.22, w: w * 0.56, h: h * 0.56 };
    case 'triangle':
      return { x: w * 0.22, y: h * 0.45, w: w * 0.56, h: h * 0.5 };
    case 'star':
      return { x: w * 0.3, y: h * 0.38, w: w * 0.4, h: h * 0.36 };
    case 'hexagon':
    case 'parallelogram':
    case 'trapezoid':
    case 'octagon':
      return { x: w * 0.18, y: pad, w: w * 0.64, h: Math.max(1, h - pad * 2) };
    case 'cylinder': {
      const k = Math.min(h * 0.15, 18);
      return { x: pad, y: k * 2, w: Math.max(1, w - pad * 2), h: Math.max(1, h - k * 3) };
    }
    case 'document':
      return { x: pad, y: pad, w: Math.max(1, w - pad * 2), h: Math.max(1, h * 0.8 - pad) };
    case 'predefined':
      return { x: 16, y: pad, w: Math.max(1, w - 32), h: Math.max(1, h - pad * 2) };
    case 'pentagon':
      return { x: w * 0.15, y: h * 0.3, w: Math.max(1, w * 0.7), h: Math.max(1, h * 0.6) };
    case 'cross':
      return { x: 10, y: h / 3, w: Math.max(1, w - 20), h: Math.max(1, h / 3) };
    case 'heart':
      return { x: w * 0.2, y: h * 0.2, w: Math.max(1, w * 0.6), h: Math.max(1, h * 0.5) };
    case 'cloud':
      return { x: w * 0.18, y: h * 0.25, w: Math.max(1, w * 0.64), h: Math.max(1, h * 0.5) };
    case 'arrow-right': {
      const hd = Math.min(w * 0.3, h * 0.6);
      return { x: 10, y: h * 0.25, w: Math.max(1, w - hd - 20), h: Math.max(1, h * 0.5) };
    }
    case 'arrow-left': {
      const hd = Math.min(w * 0.3, h * 0.6);
      return { x: hd + 10, y: h * 0.25, w: Math.max(1, w - hd - 20), h: Math.max(1, h * 0.5) };
    }
    case 'arrow-both': {
      const hd = Math.min(w * 0.3, h * 0.6);
      return { x: hd + 10, y: h * 0.25, w: Math.max(1, w - 2 * hd - 20), h: Math.max(1, h * 0.5) };
    }
    case 'chevron': {
      const k = Math.min(w * 0.3, h * 0.5);
      return { x: k + 8, y: 10, w: Math.max(1, w - 2 * k - 16), h: Math.max(1, h - 20) };
    }
    case 'arrow-pentagon': {
      const k = Math.min(w * 0.3, h * 0.5);
      return { x: 10, y: 10, w: Math.max(1, w - k - 20), h: Math.max(1, h - 20) };
    }
    case 'callout-rect':
    case 'callout-round':
      return { x: 10, y: 10, w: Math.max(1, w - 20), h: Math.max(1, h * 0.78 - 20) };
    case 'delay':
      return { x: 10, y: 10, w: Math.max(1, w * 0.7 - 10), h: Math.max(1, h - 20) };
    case 'merge':
      return { x: w * 0.25, y: 8, w: Math.max(1, w * 0.5), h: Math.max(1, h * 0.4) };
    case 'off-page':
      return { x: 10, y: 10, w: Math.max(1, w - 20), h: Math.max(1, h * 0.7 - 20) };
    case 'manual-operation':
      return { x: w * 0.2, y: 10, w: Math.max(1, w * 0.6), h: Math.max(1, h - 20) };
    case 'display': {
      const kd = Math.min(w * 0.2, h / 2);
      return { x: kd + 4, y: 10, w: Math.max(1, w - 2 * kd - 8), h: Math.max(1, h - 20) };
    }
    default:
      return { x: pad, y: pad, w: Math.max(1, w - pad * 2), h: Math.max(1, h - pad * 2) };
  }
}

const SIDE_UNIT: Record<Side, Point> = {
  top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};

// Curved outlines have no polygon to hit, so connectors meet them at fixed points.
const CURVED_ANCHORS: Partial<Record<ShapeKind, (w: number, h: number) => Record<Side, Point>>> = {
  heart: (w, h) => ({ top: { x: w / 2, y: (h * 14) / 90 }, bottom: { x: w / 2, y: h }, left: { x: 0, y: h * 0.28 }, right: { x: w, y: h * 0.28 } }),
  cloud: (w, h) => ({ top: { x: w / 2, y: h * 0.06 }, bottom: { x: w / 2, y: h }, left: { x: w * 0.05, y: h * 0.6 }, right: { x: w * 0.955, y: h * 0.5 } }),
  'callout-round': (w, h) => ({ top: { x: w / 2, y: 0 }, bottom: { x: w / 2, y: h * 0.78 }, left: { x: 0, y: h * 0.39 }, right: { x: w, y: h * 0.39 } }),
};

/** Local (top-left origin) point where a connector attaches to `side` of a shape. */
export function shapeAnchor(kind: ShapeKind, w: number, h: number, side: Side): Point {
  const pts = shapePolygon(kind, w, h);
  if (pts) {
    // Ray from the centre; the farthest edge it crosses is the outline point.
    const c = { x: w / 2, y: h / 2 }, dir = SIDE_UNIT[side];
    let bestT = -1;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const ex = bx - ax, ey = by - ay;
      const denom = dir.x * ey - dir.y * ex;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((ax - c.x) * ey - (ay - c.y) * ex) / denom;
      const u = ((ax - c.x) * dir.y - (ay - c.y) * dir.x) / denom;
      if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 && t > bestT) bestT = t;
    }
    if (bestT >= 0) return { x: c.x + dir.x * bestT, y: c.y + dir.y * bestT };
  }
  const curved = CURVED_ANCHORS[kind];
  if (curved) return curved(w, h)[side];
  return { top: { x: w / 2, y: 0 }, right: { x: w, y: h / 2 }, bottom: { x: w / 2, y: h }, left: { x: 0, y: h / 2 } }[side];
}

/** Small icon of a shape kind, centred in a box, for palettes and menus. */
export function shapePreviewSvg(kind: ShapeKind, box = { w: 52, h: 40 }, inset = 4): string {
  const size = defaultSize(kind);
  const scale = Math.min((box.w - 2 * inset) / size.w, (box.h - 2 * inset) / size.h);
  const pw = size.w * scale, ph = size.h * scale;
  const ox = (box.w - pw) / 2, oy = (box.h - ph) / 2;
  const stroke = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"';
  const decor = shapeDecor(kind, r(pw), r(ph));
  return `<svg width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}" aria-hidden="true"><g transform="translate(${r(ox)} ${r(oy)})"><path d="${shapePath(kind, r(pw), r(ph))}" ${stroke}/>${decor ? `<path d="${decor}" ${stroke}/>` : ''}</g></svg>`;
}

// ---------------------------------------------------------------- arrowheads

/**
 * Markup for an arrowhead with its tip at `tip`, pointing along `dir` (unit).
 * Returns how far the line should be pulled back so it ends at the head's base.
 */
export function headMarkup(head: Head, tip: Point, dir: Point, color: string, sw: number): { svg: string; inset: number } {
  if (head === 'none') return { svg: '', inset: 0 };
  const s = 10 + sw * 2;                    // head length
  const wv = { x: -dir.y, y: dir.x };      // perpendicular
  const at = (along: number, across: number) => ({
    x: tip.x - dir.x * along + wv.x * across,
    y: tip.y - dir.y * along + wv.y * across,
  });
  const P = (p: Point) => `${r(p.x)} ${r(p.y)}`;
  const strokeAttrs = `stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"`;
  switch (head) {
    case 'arrow': {
      const a = at(s, s * 0.45), b = at(s, -s * 0.45);
      return { svg: `<path d="M${P(tip)}L${P(a)}L${P(b)}Z" fill="${color}" ${strokeAttrs}/>`, inset: s * 0.8 };
    }
    case 'open': {
      const a = at(s, s * 0.5), b = at(s, -s * 0.5);
      return { svg: `<path d="M${P(a)}L${P(tip)}L${P(b)}" fill="none" ${strokeAttrs}/>`, inset: 0 };
    }
    case 'triangle': {
      const a = at(s * 1.2, s * 0.6), b = at(s * 1.2, -s * 0.6);
      return { svg: `<path d="M${P(tip)}L${P(a)}L${P(b)}Z" fill="var(--paper, #fff)" ${strokeAttrs}/>`, inset: s * 1.2 };
    }
    case 'diamond':
    case 'diamond-open': {
      const m1 = at(s * 0.8, s * 0.42), m2 = at(s * 0.8, -s * 0.42), back = at(s * 1.6, 0);
      const fill = head === 'diamond' ? color : 'var(--paper, #fff)';
      return { svg: `<path d="M${P(tip)}L${P(m1)}L${P(back)}L${P(m2)}Z" fill="${fill}" ${strokeAttrs}/>`, inset: s * 1.6 };
    }
    case 'circle': {
      const c = at(s * 0.45, 0);
      return { svg: `<circle cx="${r(c.x)}" cy="${r(c.y)}" r="${r(s * 0.45)}" fill="var(--paper, #fff)" ${strokeAttrs}/>`, inset: s * 0.9 };
    }
    case 'bar': {
      const a = at(s * 0.4, s * 0.55), b = at(s * 0.4, -s * 0.55);
      return { svg: `<path d="M${P(a)}L${P(b)}" ${strokeAttrs}/>`, inset: 0 };
    }
    case 'crow-many': {
      const base = at(s, 0), a = at(0, s * 0.55), b = at(0, -s * 0.55);
      return { svg: `<path d="M${P(a)}L${P(base)}L${P(b)}M${P(base)}L${P(tip)}" fill="none" ${strokeAttrs}/>`, inset: 0 };
    }
    case 'crow-one': {
      const a = at(s * 0.5, s * 0.55), b = at(s * 0.5, -s * 0.55);
      const c = at(s * 0.8, s * 0.55), d = at(s * 0.8, -s * 0.55);
      return { svg: `<path d="M${P(a)}L${P(b)}M${P(c)}L${P(d)}" fill="none" ${strokeAttrs}/>`, inset: 0 };
    }
  }
  return { svg: '', inset: 0 };
}

export const HEADS: { head: Head; label: string }[] = [
  { head: 'none', label: 'None' },
  { head: 'arrow', label: 'Arrow' },
  { head: 'open', label: 'Open arrow' },
  { head: 'triangle', label: 'Hollow triangle' },
  { head: 'diamond', label: 'Filled diamond' },
  { head: 'diamond-open', label: 'Hollow diamond' },
  { head: 'circle', label: 'Circle' },
  { head: 'bar', label: 'Bar' },
  { head: 'crow-many', label: 'Crow’s foot (many)' },
  { head: 'crow-one', label: 'Crow’s foot (one)' },
];
