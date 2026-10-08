import type { BaseObj, ConnectorObj, End, Id, Obj, Point, Rect, Side } from './types';
import { isBox, isConnector } from './types';
import { shapeAnchor, shapeSideCurve } from './shapes';

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

/** How far, in board units, a click on a connection dot looks for a shape to connect to before making a new one. */
export const NEIGHBOR_REACH = 400;

/**
 * The shape a click on the connection dot on `side` of `src` connects to: the nearest candidate that lies beyond
 * that side within `reach`, and overlaps the source across that direction (roughly aligned with it). Ties go to the
 * better aligned one. Locked candidates are skipped, as they are when dragging a connector. Works on rotated shapes:
 * every corner is measured along and across the side's outward direction.
 */
export function neighborInDirection(src: BaseObj, side: Side, candidates: BaseObj[], reach = NEIGHBOR_REACH): BaseObj | null {
  const { dir } = sideAnchor(src, side);
  const across = { x: -dir.y, y: dir.x };
  const origin = center(src);
  const extent = (o: BaseObj) => {
    const c = center(o);
    const corners = [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]].map(([x, y]) =>
      rotate({ x, y }, c, o.rotation || 0));
    const along = corners.map((p) => (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y);
    const side2 = corners.map((p) => (p.x - origin.x) * across.x + (p.y - origin.y) * across.y);
    return { near: Math.min(...along), far: Math.max(...along), lo: Math.min(...side2), hi: Math.max(...side2) };
  };
  const s = extent(src);
  let best: BaseObj | null = null;
  let bestGap = Infinity;
  let bestOffset = Infinity;
  for (const o of candidates) {
    if (o.id === src.id || o.locked) continue;
    const e = extent(o);
    const gap = e.near - s.far;
    if (gap < 0 || gap > reach) continue; // overlapping or behind it is not "next to" it
    if (e.hi <= s.lo || e.lo >= s.hi) continue; // not aligned with the source
    const offset = Math.abs((e.lo + e.hi) / 2 - (s.lo + s.hi) / 2);
    if (gap < bestGap || (gap === bestGap && offset < bestOffset)) {
      best = o;
      bestGap = gap;
      bestOffset = offset;
    }
  }
  return best;
}

/** Space between a shape and the copy a click on its connection dot makes. */
export const QUICK_GAP = 96;
/** Clear space kept around the copy when it has to move past other shapes. */
export const QUICK_CLEARANCE = 48;

/**
 * Where the copy a click on the connection dot on `side` of `src` goes: `gap` beyond that side, or, when that spot
 * overlaps another shape, the nearest spot further along the same direction that does not. Returns the top left
 * corner. Every shape in `obstacles` other than `src` counts, rotated ones by their outline's bounds.
 */
export function freeSpotInDirection(src: BaseObj, side: Side, obstacles: BaseObj[], gap = QUICK_GAP, clearance = QUICK_CLEARANCE): Point {
  const r = { x: src.x, y: src.y, w: src.w, h: src.h };
  if (side === 'right') r.x += src.w + gap;
  else if (side === 'left') r.x -= src.w + gap;
  else if (side === 'bottom') r.y += src.h + gap;
  else r.y -= src.h + gap;
  const bounds = obstacles.filter((o) => o.id !== src.id).map(boxBounds);
  // Each pass moves past every shape in the way, so it ends after at most one pass per shape.
  for (let pass = 0; pass <= bounds.length; pass++) {
    const hits = bounds.filter((b) =>
      b.x < r.x + r.w + clearance && b.x + b.w > r.x - clearance && b.y < r.y + r.h + clearance && b.y + b.h > r.y - clearance);
    if (hits.length === 0) break;
    if (side === 'right') r.x = Math.max(...hits.map((b) => b.x + b.w)) + clearance;
    else if (side === 'left') r.x = Math.min(...hits.map((b) => b.x)) - clearance - r.w;
    else if (side === 'bottom') r.y = Math.max(...hits.map((b) => b.y + b.h)) + clearance;
    else r.y = Math.min(...hits.map((b) => b.y)) - clearance - r.h;
  }
  return { x: r.x, y: r.y };
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

/** One end of a connector, resolved: the line's attachment, the box and side it sits on, and where the other end is. */
export interface EndSide extends ResolvedEnd {
  /** The box this end is attached to; null for a free end. */
  id: Id | null;
  /** The point this end faces: the other end's position, or its box's centre. */
  toward: Point;
}

export interface ResolvedSides { from: EndSide; to: EndSide }

/**
 * Where each end of a connector attaches: for a bound end, the box and the side (explicit, facing the other end, or
 * across the larger gap when both ends are auto-anchored). Null when an end is bound to something that is not a box.
 */
export function resolveSides(get: (id: string) => Obj | undefined, c: Pick<ConnectorObj, 'from' | 'to'>): ResolvedSides | null {
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
  return {
    from: { ...a, id: a.side && c.from.kind === 'bound' ? c.from.id : null, toward: toC },
    to: { ...b, id: b.side && c.to.kind === 'bound' ? c.to.id : null, toward: fromC },
  };
}

export type EndName = 'from' | 'to';

/** Where a connector end sits among the ends attached to the same side of a shape, counted along that side. */
export interface EndSlot { index: number; count: number }

/** Slots of the connector ends that are attached to a shape, keyed by connector id and end. */
export type ConnectorLayout = ReadonlyMap<string, EndSlot>;

const slotKey = (id: Id, end: EndName) => `${id}:${end}`;

export const endSlot = (layout: ConnectorLayout | undefined, id: Id | undefined, end: EndName): EndSlot | undefined =>
  id === undefined ? undefined : layout?.get(slotKey(id, end));

/**
 * Groups the bound ends of `connectors` by shape and side, and numbers each group along the side's own axis (top to
 * bottom on a left or right side, left to right on a top or bottom side, in the shape's unrotated frame) by where the
 * other end lies, so that lines to the far end do not cross. Free ends and loops back to the same shape take no slot.
 */
export function buildConnectorLayout(get: (id: string) => Obj | undefined, connectors: Iterable<ConnectorObj>): ConnectorLayout {
  const groups = new Map<string, { key: string; at: number; id: Id }[]>();
  for (const c of connectors) {
    const r = resolveSides(get, c);
    if (!r || (r.from.id !== null && r.from.id === r.to.id)) continue;
    for (const name of ['from', 'to'] as const) {
      const e = r[name];
      if (e.id === null || !e.side) continue;
      const box = get(e.id);
      if (!isBox(box)) continue;
      const l = toLocal(box, e.toward);
      // rounded so that rotation noise cannot defeat the tie-break by id, which all collaborators must agree on
      const at = Math.round((e.side === 'left' || e.side === 'right' ? l.y : l.x) * 1000);
      const gk = `${box.id}:${e.side}`;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = []));
      g.push({ key: slotKey(c.id, name), at, id: c.id });
    }
  }
  const layout = new Map<string, EndSlot>();
  for (const g of groups.values()) {
    g.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    g.forEach((e, index) => layout.set(e.key, { index, count: g.length }));
  }
  return layout;
}

/** Ids of the connectors with an end whose slot is not the same in both layouts: added, removed or moved. */
export function movedConnectors(prev: ConnectorLayout, next: ConnectorLayout): Id[] {
  const out = new Set<Id>();
  const idOf = (key: string) => key.slice(0, key.lastIndexOf(':'));
  for (const [key, slot] of next) {
    const was = prev.get(key);
    if (!was || was.index !== slot.index || was.count !== slot.count) out.add(idOf(key));
  }
  for (const key of prev.keys()) if (!next.has(key)) out.add(idOf(key));
  return [...out];
}

/**
 * The most that neighbouring connector ends on one side are spread apart, in board units. A side that is shorter than
 * this times the number of ends plus one packs them closer, evenly; a long side keeps them together around its middle
 * instead of throwing them to its corners.
 */
export const FAN_GAP = 28;

const ELLIPSE_TYPES = new Set(['uml-usecase', 'uml-initial', 'uml-final']);

/**
 * Where an end with `slot` attaches to `side` of `o`: spread evenly along the side, `FAN_GAP` apart at most, centred on
 * its middle (so the middle one of an odd number is where a lone end would be) and on the outline of the shape.
 * Null for kinds that have no outline to spread along; those keep the side's anchor.
 */
export function slotAnchor(o: BaseObj, side: Side, slot: EndSlot): Point | null {
  const kind = o.type === 'shape' ? o.kind || 'rect' : ELLIPSE_TYPES.has(o.type) ? 'ellipse' : 'rect';
  const curve = shapeSideCurve(kind, o.w, o.h, side);
  if (!curve || curve.span <= 0) return null;
  const gap = Math.min(curve.span / (slot.count + 1), FAN_GAP);
  const local = curve.at((slot.index - (slot.count - 1) / 2) * gap);
  if (!local) return null;
  return rotate({ x: o.x + local.x, y: o.y + local.y }, center(o), o.rotation || 0);
}

/** The end with its attachment moved to its slot, when it shares its side with others; the direction stays the side's. */
function spread(get: (id: string) => Obj | undefined, e: EndSide, slot: EndSlot | undefined): EndSide {
  if (!slot || slot.count < 2 || e.id === null || !e.side) return e;
  const o = get(e.id);
  const p = isBox(o) ? slotAnchor(o, e.side, slot) : null;
  return p ? { ...e, p } : e;
}

/**
 * The routed geometry of a connector. With a `layout`, ends that share a side of a shape with other connectors attach
 * at their own point along it instead of all at its anchor. A connector without an `id`, or one the layout does not
 * know, keeps the anchor.
 */
export function connectorGeom(
  get: (id: string) => Obj | undefined,
  c: Pick<ConnectorObj, 'from' | 'to' | 'route'> & { id?: Id },
  layout?: ConnectorLayout,
): ConnectorGeom | null {
  const sides = resolveSides(get, c);
  if (!sides) return null;
  const a = spread(get, sides.from, endSlot(layout, c.id, 'from'));
  const b = spread(get, sides.to, endSlot(layout, c.id, 'to'));
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
export function objBounds(get: (id: string) => Obj | undefined, o: Obj, layout?: ConnectorLayout): Rect | null {
  if (isConnector(o)) {
    const g = connectorGeom(get, o, layout);
    return g ? rectOfPoints(g.pts) : null;
  }
  if (o.type === 'frame') {
    const b = boxBounds(o);
    return { x: b.x, y: b.y - 28, w: b.w, h: b.h + 28 };
  }
  return boxBounds(o);
}

export const snapTo = (v: number, step: number) => Math.round(v / step) * step;
