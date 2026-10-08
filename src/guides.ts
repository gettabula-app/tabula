// Smart guides: alignment and equal-spacing snapping for move and resize. Pure: rectangles in, corrections out.
// See docs/guides.md.

import type { BaseObj, Id, Obj, Rect } from './types';
import { isBox } from './types';
import { boxBounds, rectsIntersect, unionRects } from './geometry';

/** Snap distance in screen px; the world distance is this divided by zoom. */
export const SNAP_PX = 6;
/** Spacing wins over alignment when its correction is at most this much (screen px) worse. */
export const SPACING_HEAD_PX = 2;
/** Gaps narrower than this (screen px) are neither matched nor marked. */
export const MIN_GAP_PX = 4;
/** World-unit tolerance for deciding that two values are equal. */
export const EPS = 0.1;
/** The smallest size a resize may produce; matches the clamp in doResize. */
export const MIN_SIZE = 8;
/** Gap markers other than the one or two next to the moving rectangle. */
export const MAX_OTHER_MARKERS = 4;
/** The candidate region is the viewport grown by this fraction of its size on every side. */
export const VIEW_MARGIN = 0.5;

export type Axis = 'x' | 'y';
type Edge = 'lo' | 'hi' | null;

export interface GuideLine { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
/** A bracket over a gap. `axis` is the direction measured: 'x' is a horizontal gap, drawn at height `at`. */
export interface GapMark { kind: 'gap'; axis: Axis; from: number; to: number; at: number; label: string }
export type Guide = GuideLine | GapMark;

/** Corrections to add to the proposed position, or null on an axis where nothing is within the threshold. */
export interface Snap { dx: number | null; dy: number | null; guides: GuideLine[]; gaps: GapMark[] }

export interface AxisIndex { vals: Float64Array; owner: Int32Array; kind: Uint8Array }

export interface GuideSession {
  rects: Rect[];
  region: Rect;
  base: Rect | null;
  xi: AxisIndex;
  yi: AxisIndex;
}

const start = (r: Rect, a: Axis) => (a === 'x' ? r.x : r.y);
const size = (r: Rect, a: Axis) => (a === 'x' ? r.w : r.h);
const stop = (r: Rect, a: Axis) => start(r, a) + size(r, a);
const cross = (a: Axis): Axis => (a === 'x' ? 'y' : 'x');

const none = (): Snap => ({ dx: null, dy: null, guides: [], gaps: [] });

/** Bounds of every box object that may be a reference: not skipped, not a connector, not hidden. */
export function referenceRects(objs: Iterable<Obj>, skip: ReadonlySet<Id>, isHidden: (o: BaseObj) => boolean): Rect[] {
  const out: Rect[] = [];
  for (const o of objs) {
    if (skip.has(o.id) || !isBox(o) || isHidden(o)) continue;
    out.push(boxBounds(o));
  }
  return out;
}

function buildAxis(rects: Rect[], a: Axis): AxisIndex {
  const n = rects.length * 3;
  const raw = new Float64Array(n);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    raw[3 * i] = start(r, a);
    raw[3 * i + 1] = start(r, a) + size(r, a) / 2;
    raw[3 * i + 2] = stop(r, a);
  }
  const order = Array.from({ length: n }, (_, j) => j).sort((p, q) => raw[p] - raw[q] || p - q);
  const vals = new Float64Array(n), owner = new Int32Array(n), kind = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    vals[j] = raw[order[j]];
    owner[j] = Math.floor(order[j] / 3);
    kind[j] = order[j] % 3;
  }
  return { vals, owner, kind };
}

/**
 * Build the index for one drag. `refs` are candidate rectangles, `movers` the boxes being moved (their union is the
 * moving rectangle of a move; a resize passes none) and `view` the current viewport in world units.
 */
export function startGuides(refs: Rect[], movers: Rect[], view: Rect): GuideSession {
  const mx = view.w * VIEW_MARGIN, my = view.h * VIEW_MARGIN;
  const region: Rect = { x: view.x - mx, y: view.y - my, w: view.w + 2 * mx, h: view.h + 2 * my };
  const rects = refs.filter((r) => rectsIntersect(r, region));
  return { rects, region, base: unionRects(movers), xi: buildAxis(rects, 'x'), yi: buildAxis(rects, 'y') };
}

/** True while the viewport is inside the region the session was built for. */
export function guidesCover(s: GuideSession, view: Rect): boolean {
  const g = s.region;
  return g.x <= view.x && g.y <= view.y && g.x + g.w >= view.x + view.w && g.y + g.h >= view.y + view.h;
}

function lowerBound(vals: Float64Array, x: number): number {
  let lo = 0, hi = vals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vals[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------------ alignment

/** Smallest correction that brings one of the values onto a reference value, or null. [value, kind 0 low / 1 centre / 2 high] */
function alignCorr(ix: AxisIndex, values: [number, number][], thr: number): number | null {
  let best: { c: number; d: number; rank: number; at: number } | null = null;
  for (const [v, kv] of values) {
    for (let i = lowerBound(ix.vals, v - thr); i < ix.vals.length && ix.vals[i] <= v + thr; i++) {
      const c = ix.vals[i] - v, d = Math.abs(c), kc = ix.kind[i];
      const rank = kv === 1 && kc === 1 ? 0 : kv === kc ? 1 : 2;
      const at = ix.vals[i];
      if (!best || d < best.d - EPS || (d <= best.d + EPS && (rank < best.rank || (rank === best.rank && at < best.at)))) {
        best = { c, d, rank, at };
      }
    }
  }
  return best ? best.c : null;
}

function lineMarks(s: GuideSession, r: Rect, a: Axis, values: number[]): GuideLine[] {
  const ix = a === 'x' ? s.xi : s.yi;
  const o = cross(a);
  const out: GuideLine[] = [];
  const seen = new Set<number>();
  for (const v of values) {
    if (seen.has(v)) continue;
    let from = start(r, o), to = stop(r, o), found = false;
    for (let i = lowerBound(ix.vals, v - EPS); i < ix.vals.length && ix.vals[i] <= v + EPS; i++) {
      found = true;
      const ref = s.rects[ix.owner[i]];
      from = Math.min(from, start(ref, o));
      to = Math.max(to, stop(ref, o));
    }
    if (!found) continue;
    seen.add(v);
    out.push(a === 'x' ? { kind: 'line', x1: v, y1: from, x2: v, y2: to } : { kind: 'line', x1: from, y1: v, x2: to, y2: v });
  }
  return out;
}

// -------------------------------------------------------------------- spacing

interface Member { lo: number; hi: number; i: number }
interface Gap { from: number; to: number; size: number; p: number; q: number }

const contains = (outer: Rect, inner: Rect) =>
  outer.x - EPS <= inner.x && outer.y - EPS <= inner.y &&
  outer.x + outer.w + EPS >= inner.x + inner.w && outer.y + outer.h + EPS >= inner.y + inner.h;

/** References whose extent on the other axis overlaps [olo, ohi] by more than EPS; a reference containing `within` is a container and left out. */
function bandMembers(rects: Rect[], a: Axis, olo: number, ohi: number, within: Rect | null): Member[] {
  const o = cross(a);
  const out: Member[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const s0 = start(r, o), s1 = stop(r, o);
    if (s1 <= olo + EPS || s0 >= ohi - EPS) continue;
    if (within && contains(r, within)) continue;
    out.push({ lo: start(r, a), hi: stop(r, a), i });
  }
  return out;
}

/** The stretches between clusters of members that are at least `minGap` wide. Sorts `ms`. */
function freeGaps(ms: Member[], minGap: number): Gap[] {
  const out: Gap[] = [];
  if (ms.length < 2) return out;
  ms.sort((p, q) => p.lo - q.lo || p.hi - q.hi);
  let maxHi = ms[0].hi, holder = ms[0].i;
  for (let k = 1; k < ms.length; k++) {
    const m = ms[k];
    const g = m.lo - maxHi;
    if (g > EPS && g >= minGap) out.push({ from: maxHi, to: m.lo, size: g, p: holder, q: m.i });
    if (m.hi > maxHi) {
      maxHi = m.hi;
      holder = m.i;
    }
  }
  return out;
}

/** Gaps that the rectangle [r0, r1] currently sits inside are not gaps between other objects. */
const outsideOf = (gs: Gap[], r0: number, r1: number) => gs.filter((g) => !(g.from <= r0 + EPS && g.to >= r1 - EPS));

function distinctSizes(gs: Gap[]): number[] {
  const sizes = gs.map((g) => g.size).sort((p, q) => p - q);
  const out: number[] = [];
  for (const v of sizes) if (!out.length || v - out[out.length - 1] > EPS) out.push(v);
  return out;
}

/** Nearest member on each side of [r0, r1]; one that the range overlaps by more than `slack` is neither. */
function neighbours(ms: Member[], r0: number, r1: number, slack: number): { A: Member | null; B: Member | null } {
  const mid = (r0 + r1) / 2;
  let A: Member | null = null, B: Member | null = null;
  for (const m of ms) {
    const mm = (m.lo + m.hi) / 2;
    if (mm < mid && m.hi <= r0 + slack && (!A || m.hi > A.hi)) A = m;
    if (mm > mid && m.lo >= r1 - slack && (!B || m.lo < B.lo)) B = m;
  }
  return { A, B };
}

/**
 * Correction along axis `a` that makes the gap next to the rectangle equal to an existing gap in its row or column,
 * or (a move only) puts the rectangle exactly between its two neighbours. `edge` is the moving edge of a resize.
 */
function spacingCorr(s: GuideSession, r: Rect, a: Axis, thr: number, minGap: number, edge: Edge): number | null {
  const o = cross(a);
  const r0 = start(r, a), r1 = stop(r, a);
  const ms = bandMembers(s.rects, a, start(r, o), stop(r, o), r);
  if (ms.length < 2) return null;
  const { A, B } = neighbours(ms, r0, r1, thr);
  if (!A && !B) return null;
  const sizes = distinctSizes(outsideOf(freeGaps(ms, minGap), r0, r1));
  const cands: { c: number; p: number }[] = [];
  const add = (c: number, p: number) => {
    if (Math.abs(c) <= thr) cands.push({ c, p });
  };
  const len = r1 - r0;
  if (edge !== 'hi' && A) {
    for (const g of sizes) add(A.hi + g - r0, A.hi + g);
    if (edge === 'lo' && B && B.lo - r1 >= minGap) add(A.hi + (B.lo - r1) - r0, A.hi + (B.lo - r1));
  }
  if (edge !== 'lo' && B) {
    for (const g of sizes) add(B.lo - g - r1, B.lo - g - len);
    if (edge === 'hi' && A && r0 - A.hi >= minGap) add(B.lo - (r0 - A.hi) - r1, B.lo - (r0 - A.hi) - len);
  }
  if (edge === null && A && B && (B.lo - A.hi - len) / 2 >= minGap) {
    const lo = (A.hi + B.lo - len) / 2;
    add(lo - r0, lo);
  }
  cands.sort((p, q) => {
    const d = Math.abs(p.c) - Math.abs(q.c);
    return Math.abs(d) > EPS ? d : p.p - q.p;
  });
  for (const k of cands) {
    const n0 = edge === 'hi' ? r0 : r0 + k.c, n1 = edge === 'lo' ? r1 : r1 + k.c;
    if (!ms.some((m) => m.lo < n1 - EPS && m.hi > n0 + EPS)) return k.c;
  }
  return null;
}

/** Brackets for every equal gap that holds at rectangle `r`. */
function gapMarks(s: GuideSession, r: Rect, a: Axis, minGap: number, edge: Edge): GapMark[] {
  const o = cross(a);
  const r0 = start(r, a), r1 = stop(r, a);
  const ms = bandMembers(s.rects, a, start(r, o), stop(r, o), r);
  if (ms.length < 2) return [];
  const gaps = outsideOf(freeGaps(ms, minGap), r0, r1);
  const { A, B } = neighbours(ms, r0, r1, EPS);
  const gL = A ? r0 - A.hi : 0, gR = B ? B.lo - r1 : 0;
  const useL = !!A && gL >= minGap, useR = !!B && gR >= minGap;
  const same = (p: number, q: number) => Math.abs(p - q) <= EPS;
  const known = (g: number) => gaps.some((x) => same(x.size, g));
  const sizes: number[] = [];
  let markL = false, markR = false;
  if (edge === null) {
    if (useL && known(gL)) { markL = true; sizes.push(gL); }
    if (useR && known(gR)) { markR = true; sizes.push(gR); }
    if (useL && useR && same(gL, gR)) { markL = markR = true; sizes.push(gL); }
  } else {
    const moving = edge === 'lo' ? useL : useR;
    const fixed = edge === 'lo' ? useR : useL;
    const gm = edge === 'lo' ? gL : gR;
    const gf = edge === 'lo' ? gR : gL;
    if (moving && (known(gm) || (fixed && same(gm, gf)))) {
      sizes.push(gm);
      if (edge === 'lo') markL = true; else markR = true;
      if (fixed && same(gm, gf)) {
        if (edge === 'lo') markR = true; else markL = true;
      }
    }
  }
  if (!markL && !markR) return [];
  const mid = (r0 + r1) / 2;
  const crossMid = start(r, o) + size(r, o) / 2;
  const atOf = (p: Rect, q: Rect) => {
    const l = Math.max(start(p, o), start(q, o)), h = Math.min(stop(p, o), stop(q, o));
    return h - l > EPS ? (l + h) / 2 : crossMid;
  };
  const mark = (from: number, to: number, at: number): GapMark => ({ kind: 'gap', axis: a, from, to, at, label: String(Math.round(to - from)) });
  const out: GapMark[] = [];
  if (markL && A) out.push(mark(A.hi, r0, atOf(s.rects[A.i], r)));
  if (markR && B) out.push(mark(r1, B.lo, atOf(r, s.rects[B.i])));
  const others = gaps
    .filter((g) => sizes.some((v) => same(g.size, v)))
    .sort((p, q) => Math.abs((p.from + p.to) / 2 - mid) - Math.abs((q.from + q.to) / 2 - mid))
    .slice(0, MAX_OTHER_MARKERS);
  for (const g of others) out.push(mark(g.from, g.to, atOf(s.rects[g.p], s.rects[g.q])));
  return out;
}

/** The free gaps (stretches no reference covers) of the row or column band [lo, hi] on the other axis. For reuse by placement code. */
export function gapsInBand(s: GuideSession, axis: Axis, lo: number, hi: number, minGap = 0): { from: number; to: number; size: number }[] {
  return freeGaps(bandMembers(s.rects, axis, lo, hi, null), minGap).map(({ from, to, size: sz }) => ({ from, to, size: sz }));
}

// -------------------------------------------------------------------- queries

const choose = (align: number | null, space: number | null, head: number): number | null =>
  align === null ? space : space === null ? align : Math.abs(space) <= Math.abs(align) + head ? space : align;

function moved(r: Rect, a: Axis, edge: Edge, c: number): Rect {
  if (edge === null) return a === 'x' ? { ...r, x: r.x + c } : { ...r, y: r.y + c };
  if (a === 'x') return edge === 'lo' ? { ...r, x: r.x + c, w: r.w - c } : { ...r, w: r.w + c };
  return edge === 'lo' ? { ...r, y: r.y + c, h: r.h - c } : { ...r, h: r.h + c };
}

function finish(s: GuideSession, r: Rect, cx: number | null, cy: number | null, ex: Edge, ey: Edge, minGap: number): Snap {
  let fin = r;
  if (cx !== null) fin = moved(fin, 'x', ex, cx);
  if (cy !== null) fin = moved(fin, 'y', ey, cy);
  const out: Snap = { dx: cx, dy: cy, guides: [], gaps: [] };
  const values = (a: Axis, e: Edge) => {
    const v0 = start(fin, a), v1 = stop(fin, a);
    return e === null ? [v0, (v0 + v1) / 2, v1] : [e === 'lo' ? v0 : v1];
  };
  if (cx !== null) {
    out.guides.push(...lineMarks(s, fin, 'x', values('x', ex)));
    out.gaps.push(...gapMarks(s, fin, 'x', minGap, ex));
  }
  if (cy !== null) {
    out.guides.push(...lineMarks(s, fin, 'y', values('y', ey)));
    out.gaps.push(...gapMarks(s, fin, 'y', minGap, ey));
  }
  return out;
}

const values3 = (r: Rect, a: Axis): [number, number][] => [[start(r, a), 0], [start(r, a) + size(r, a) / 2, 1], [stop(r, a), 2]];

/** Corrections for moving the session's moving rectangle by (dx, dy). */
export function snapMove(s: GuideSession, dx: number, dy: number, zoom: number): Snap {
  const b = s.base;
  if (!b) return none();
  const r: Rect = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
  const thr = SNAP_PX / zoom, minGap = MIN_GAP_PX / zoom, head = SPACING_HEAD_PX / zoom;
  const cx = choose(alignCorr(s.xi, values3(r, 'x'), thr), spacingCorr(s, r, 'x', thr, minGap, null), head);
  const cy = choose(alignCorr(s.yi, values3(r, 'y'), thr), spacingCorr(s, r, 'y', thr, minGap, null), head);
  if (cx === null && cy === null) return none();
  return finish(s, r, cx, cy, null, null, minGap);
}

/**
 * Corrections for the moving edge of a resize. `rect` is the proposed unrotated rectangle and `handle` the handle
 * ('n', 'se', ...); only the edges the handle moves can snap, and never to a size below MIN_SIZE.
 */
export function snapResize(s: GuideSession, rect: Rect, handle: string, zoom: number): Snap {
  const ex: Edge = handle.includes('w') ? 'lo' : handle.includes('e') ? 'hi' : null;
  const ey: Edge = handle.includes('n') ? 'lo' : handle.includes('s') ? 'hi' : null;
  if ((!ex && !ey) || (ex && rect.w < MIN_SIZE) || (ey && rect.h < MIN_SIZE)) return none();
  const thr = SNAP_PX / zoom, minGap = MIN_GAP_PX / zoom, head = SPACING_HEAD_PX / zoom;
  const axis = (a: Axis, e: Edge): number | null => {
    if (!e) return null;
    const v = e === 'lo' ? start(rect, a) : stop(rect, a);
    const c = choose(alignCorr(a === 'x' ? s.xi : s.yi, [[v, e === 'lo' ? 0 : 2]], thr), spacingCorr(s, rect, a, thr, minGap, e), head);
    if (c === null) return null;
    return size(rect, a) + (e === 'lo' ? -c : c) < MIN_SIZE ? null : c;
  };
  const cx = axis('x', ex), cy = axis('y', ey);
  if (cx === null && cy === null) return none();
  return finish(s, rect, cx, cy, ex, ey, minGap);
}
