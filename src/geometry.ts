import type { BaseObj, ConnectorObj, End, Obj, Point, Rect, Side } from './types';
import { isBox, isConnector } from './types';
import { shapeAnchor } from './shapes';

export const EPS = 1e-6;

export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const len = (a: Point) => Math.hypot(a.x, a.y);
export const norm = (a: Point): Point => {
  const l = len(a);
  return l < EPS ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};

export function rotate(p: Point, c: Point, angle: number): Point {
  if (!angle) return p;
  const s = Math.sin(angle), co = Math.cos(angle);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
}

export const center = (o: { x: number; y: number; w: number; h: number }): Point => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

export function corners(o: BaseObj): Point[] {
  const c = center(o);
  return [
    { x: o.x, y: o.y }, { x: o.x + o.w, y: o.y },
    { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h },
  ].map((p) => rotate(p, c, o.rotation || 0));
}

export function rectOfPoints(pts: Point[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRects(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  return rectOfPoints(rs.flatMap((r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }]));
}

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

export const rectContains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export const pointInRect = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Axis-aligned bounds of a box object, accounting for rotation. */
export function boxBounds(o: BaseObj): Rect {
  return o.rotation ? rectOfPoints(corners(o)) : { x: o.x, y: o.y, w: o.w, h: o.h };
}

/** Point expressed in the object's unrotated frame, relative to its top-left. */
export function toLocal(o: BaseObj, p: Point): Point {
  const q = rotate(p, center(o), -(o.rotation || 0));
  return { x: q.x - o.x, y: q.y - o.y };
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 < EPS) return len(sub(p, a));
  let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  t = Math.max(0, Math.min(1, t));
  return len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
}

export function distToPolyline(p: Point, pts: Point[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i - 1], pts[i]));
  return d;
}

export function pathPoints(o: BaseObj): Point[] {
  const pts: Point[] = [];
  const a = o.points || [];
  for (let i = 0; i + 1 < a.length; i += 2) pts.push({ x: o.x + a[i], y: o.y + a[i + 1] });
  return pts;
}

/** Hit test for a box-like object. `tol` is in world units. */
export function hitBox(o: BaseObj, p: Point, tol: number): boolean {
  if (o.type === 'path') return distToPolyline(p, pathPoints(o)) <= tol + (o.strokeWidth || 2) / 2;
  const l = toLocal(o, p);
  if (o.type === 'frame') {
    // Frames are grabbed by their title bar or border, so clicks inside them can
    // still start a marquee selection of their contents.
    const inTitle = l.x >= 0 && l.x <= Math.max(o.w, 120) && l.y >= -28 && l.y <= 0;
    const inside = l.x >= -tol && l.y >= -tol && l.x <= o.w + tol && l.y <= o.h + tol;
    const nearEdge = inside && (l.x < tol + 4 || l.y < tol + 4 || l.x > o.w - tol - 4 || l.y > o.h - tol - 4);
    return inTitle || nearEdge;
  }
  if (o.type === 'shape' && o.kind === 'ellipse') {
    const rx = o.w / 2 + tol, ry = o.h / 2 + tol;
    const dx = l.x - o.w / 2, dy = l.y - o.h / 2;
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  }
  return l.x >= -tol && l.y >= -tol && l.x <= o.w + tol && l.y <= o.h + tol;
}

// ---------------------------------------------------------------- connectors

const SIDE_DIR: Record<Side, Point> = {
  top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};

export function sideAnchor(o: BaseObj, side: Side): { p: Point; dir: Point } {
  const c = center(o);
  const local: Record<Side, Point> = {
    top: { x: c.x, y: o.y }, right: { x: o.x + o.w, y: c.y },
    bottom: { x: c.x, y: o.y + o.h }, left: { x: o.x, y: c.y },
  };
  if (o.type === 'shape') {
    const lp = shapeAnchor(o.kind || 'rect', o.w, o.h, side);
    local[side] = { x: o.x + lp.x, y: o.y + lp.y };
  }
  const r = o.rotation || 0;
  return { p: rotate(local[side], c, r), dir: rotate(SIDE_DIR[side], { x: 0, y: 0 }, r) };
}

/** Pick the side of `o` that faces `toward`. */
export function autoSide(o: BaseObj, toward: Point): Side {
  const l = toLocal(o, toward);
  const dx = (l.x - o.w / 2) / Math.max(o.w, 1);
  const dy = (l.y - o.h / 2) / Math.max(o.h, 1);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

export interface ResolvedEnd { p: Point; dir: Point | null; side?: Side }

export function endPoint(get: (id: string) => Obj | undefined, end: End): Point | null {
  if (end.kind === 'free') return { x: end.x, y: end.y };
  const o = get(end.id);
  return isBox(o) ? center(o) : null;
}

export function resolveEnd(get: (id: string) => Obj | undefined, end: End, other: Point): ResolvedEnd {
  if (end.kind === 'free') return { p: { x: end.x, y: end.y }, dir: null };
  const o = get(end.id);
  if (!isBox(o)) return { p: other, dir: null };
  const side = end.anchor === 'auto' ? autoSide(o, other) : end.anchor;
  const a = sideAnchor(o, side);
  return { p: a.p, dir: a.dir, side };
}

export interface ConnectorGeom {
  d: string;
  pts: Point[];            // polyline (curves sampled) for hit-testing and bounds
  start: Point;
  end: Point;
  startDir: Point;         // unit vector pointing out of the line at the start tip
  endDir: Point;           // unit vector pointing out of the line at the end tip
  mid: Point;
}

const axisDir = (v: Point): Point =>
  Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x) || 1, y: 0 } : { x: 0, y: Math.sign(v.y) || 1 };

function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  // drop collinear middles
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 0.01) out.splice(i, 1);
  }
  return out;
}

export function polylineMid(pts: Point[]): Point {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += len(sub(pts[i], pts[i - 1]));
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = len(sub(pts[i], pts[i - 1]));
    if (half <= seg && seg > EPS) {
      const t = half / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    half -= seg;
  }
  return pts[pts.length - 1] ?? { x: 0, y: 0 };
}

/**
 * Sides for two auto-anchored, unrotated boxes: connect across the larger gap
 * between them, which reads better than comparing centres.
 */
function pairSides(a: BaseObj, b: BaseObj): [Side, Side] | null {
  if (a.rotation || b.rotation) return null;
  const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gx < 0 && gy < 0) return null; // overlapping
  if (gx >= gy) return b.x > a.x ? ['right', 'left'] : ['left', 'right'];
  return b.y > a.y ? ['bottom', 'top'] : ['top', 'bottom'];
}

export function connectorGeom(get: (id: string) => Obj | undefined, c: Pick<ConnectorObj, 'from' | 'to' | 'route'>): ConnectorGeom | null {
  const fromC = endPoint(get, c.from);
  const toC = endPoint(get, c.to);
  if (!fromC || !toC) return null;
  let a = resolveEnd(get, c.from, toC);
  let b = resolveEnd(get, c.to, fromC);
  if (c.from.kind === 'bound' && c.to.kind === 'bound' && c.from.anchor === 'auto' && c.to.anchor === 'auto') {
    const oa = get(c.from.id), ob = get(c.to.id);
    const sides = isBox(oa) && isBox(ob) && oa.id !== ob.id ? pairSides(oa, ob) : null;
    if (sides && isBox(oa) && isBox(ob)) {
      const sa = sideAnchor(oa, sides[0]), sb = sideAnchor(ob, sides[1]);
      a = { p: sa.p, dir: sa.dir, side: sides[0] };
      b = { p: sb.p, dir: sb.dir, side: sides[1] };
    }
  }
  const p1 = a.p, p2 = b.p;
  const travel = sub(p2, p1);

  if (c.route === 'straight') {
    const dir = norm(travel);
    return {
      d: `M${p1.x} ${p1.y}L${p2.x} ${p2.y}`,
      pts: [p1, p2], start: p1, end: p2,
      startDir: mul(dir, -1), endDir: dir, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
    };
  }

  const d1 = a.dir ?? axisDir(travel);
  const d2 = b.dir ?? mul(axisDir(travel), -1);

  if (c.route === 'curved') {
    const k = Math.max(40, len(travel) / 3);
    const c1 = add(p1, mul(d1, k)), c2 = add(p2, mul(d2, k));
    const pts: Point[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20, u = 1 - t;
      pts.push({
        x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
        y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
      });
    }
    return {
      d: `M${p1.x} ${p1.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`,
      pts, start: p1, end: p2,
      startDir: mul(d1, -1), endDir: mul(d2, -1), mid: pts[10],
    };
  }

  // elbow
  const stub = 20;
  const s = add(p1, mul(d1, stub));
  const e = add(p2, mul(d2, stub));
  const h1 = Math.abs(d1.x) > 0.5, h2 = Math.abs(d2.x) > 0.5;
  let middle: Point[];
  if (h1 && h2) {
    const mx = (s.x + e.x) / 2;
    middle = [{ x: mx, y: s.y }, { x: mx, y: e.y }];
  } else if (!h1 && !h2) {
    const my = (s.y + e.y) / 2;
    middle = [{ x: s.x, y: my }, { x: e.x, y: my }];
  } else if (h1) {
    middle = [{ x: e.x, y: s.y }];
  } else {
    middle = [{ x: s.x, y: e.y }];
  }
  const pts = simplify([p1, s, ...middle, e, p2]);
  const n = pts.length;
  const startDir = norm(sub(pts[0], pts[1] ?? p2));
  const endDir = norm(sub(pts[n - 1], pts[n - 2] ?? p1));
  return {
    d: 'M' + pts.map((p) => `${p.x} ${p.y}`).join('L'),
    pts, start: p1, end: p2, startDir, endDir, mid: polylineMid(pts),
  };
}

/** Bounds of any object (connectors need their routed geometry). */
export function objBounds(get: (id: string) => Obj | undefined, o: Obj): Rect | null {
  if (isConnector(o)) {
    const g = connectorGeom(get, o);
    return g ? rectOfPoints(g.pts) : null;
  }
  if (o.type === 'frame') {
    const b = boxBounds(o);
    return { x: b.x, y: b.y - 28, w: b.w, h: b.h + 28 };
  }
  return boxBounds(o);
}

export const snapTo = (v: number, step: number) => Math.round(v / step) * step;
