import type { Head, Point, Rect, ShapeKind } from './types';

export const SHAPE_KINDS: { kind: ShapeKind; label: string; group: 'basic' | 'flow' }[] = [
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
  { kind: 'terminator', label: 'Terminator', group: 'flow' },
  { kind: 'document', label: 'Document', group: 'flow' },
  { kind: 'cylinder', label: 'Database', group: 'flow' },
  { kind: 'manual-input', label: 'Manual input', group: 'flow' },
  { kind: 'predefined', label: 'Predefined process', group: 'flow' },
];

const poly = (pts: [number, number][]) => 'M' + pts.map(([x, y]) => `${r(x)} ${r(y)}`).join('L') + 'Z';
const r = (n: number) => Math.round(n * 100) / 100;

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
      return poly([[w / 2, 0], [w, h], [0, h]]);
    case 'diamond':
      return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case 'hexagon': {
      const k = Math.min(w / 4, h / 2);
      return poly([[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]]);
    }
    case 'octagon': {
      const k = Math.min(w, h) * 0.29;
      return poly([[k, 0], [w - k, 0], [w, k], [w, h - k], [w - k, h], [k, h], [0, h - k], [0, k]]);
    }
    case 'parallelogram': {
      const k = Math.min(w / 4, h);
      return poly([[k, 0], [w, 0], [w - k, h], [0, h]]);
    }
    case 'trapezoid': {
      const k = Math.min(w / 4, h);
      return poly([[k, 0], [w - k, 0], [w, h], [0, h]]);
    }
    case 'manual-input':
      return poly([[0, h * 0.25], [w, 0], [w, h], [0, h]]);
    case 'star': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? 0.5 : 0.21;
        pts.push([w / 2 + Math.cos(a) * w * rr, h * 0.53 + Math.sin(a) * h * rr * 1.05]);
      }
      return poly(pts);
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
      return { x: w * 0.18, y: pad, w: w * 0.64, h: h - pad * 2 };
    case 'cylinder': {
      const k = Math.min(h * 0.15, 18);
      return { x: pad, y: k * 2, w: w - pad * 2, h: h - k * 3 };
    }
    case 'document':
      return { x: pad, y: pad, w: w - pad * 2, h: h * 0.8 - pad };
    case 'predefined':
      return { x: 16, y: pad, w: w - 32, h: h - pad * 2 };
    default:
      return { x: pad, y: pad, w: w - pad * 2, h: h - pad * 2 };
  }
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
