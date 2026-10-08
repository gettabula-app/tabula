import { describe, expect, it } from 'vitest';
import type { BaseObj, ConnectorObj, End, Obj, Point, Route, Side, ShapeKind } from '../src/types';
import {
  FAN_GAP, buildConnectorLayout, center, connectorGeom, distToPolyline, movedConnectors, rotate, sideAnchor, slotAnchor, toLocal,
} from '../src/geometry';
import { SHAPE_KINDS, shapeAnchor, shapePolygon } from '../src/shapes';

const box = (id: string, x: number, y: number, w = 100, h = 100, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'shape', kind: 'rect', x, y, w, h, rotation: 0, z: 'a0', ...extra,
});

const conn = (id: string, from: End, to: End, route: Route = 'straight'): ConnectorObj => ({
  id, type: 'connector', z: 'a1', from, to, route, startHead: 'none', endHead: 'arrow',
});

const at = (id: string, anchor: 'auto' | Side): End => ({ kind: 'bound', id, anchor });
const free = (x: number, y: number): End => ({ kind: 'free', x, y });

const board = (...objs: Obj[]) => {
  const m = new Map(objs.map((o) => [o.id, o]));
  return (id: string) => m.get(id);
};

/** The routed geometry of each connector, with the layout of the whole set. */
function route(objs: Obj[], cs: ConnectorObj[]) {
  const get = board(...objs, ...cs);
  const layout = buildConnectorLayout(get, cs);
  return cs.map((c) => connectorGeom(get, c, layout)!);
}

/**
 * Where `n` connectors leave `side` of `o`, in the order of their targets, which lie far off along that side in the
 * shape's own frame, one per 80 units, so the order of the targets is the order of the slots whatever the rotation.
 */
function fan(o: BaseObj, side: Side, n: number): Point[] {
  const horizontal = side === 'top' || side === 'bottom';
  const c = center(o);
  const far = side === 'right' || side === 'bottom' ? 1000 : -1000;
  const cs = Array.from({ length: n }, (_, i) => {
    const off = (i - (n - 1) / 2) * 80;
    const t = rotate(horizontal ? { x: c.x + off, y: c.y + far } : { x: c.x + far, y: c.y + off }, c, o.rotation || 0);
    return conn(`c${i}`, at(o.id, side), free(t.x, t.y));
  });
  return route([o], cs).map((g) => g.start);
}

const crosses = (a: Point, b: Point, c: Point, d: Point) => {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
};

describe('connectors spread along a side', () => {
  const hub = box('hub', 0, 0);

  it('puts two ends evenly either side of the middle', () => {
    const [up, down] = fan(hub, 'right', 2);
    expect(up).toEqual({ x: 100, y: 36 });
    expect(down).toEqual({ x: 100, y: 64 });
  });

  it('puts three ends an equal step apart, the middle one where a lone end would be', () => {
    const [a, b, c] = fan(hub, 'right', 3);
    expect([a.y, b.y, c.y]).toEqual([25, 50, 75]);
    expect(b).toEqual(sideAnchor(hub, 'right').p);
  });

  it('spreads along top and bottom sides from left to right', () => {
    expect(fan(hub, 'bottom', 3).map((p) => [p.x, p.y])).toEqual([[25, 100], [50, 100], [75, 100]]);
    expect(fan(hub, 'top', 2).map((p) => [p.x, p.y])).toEqual([[36, 0], [64, 0]]);
    expect(fan(hub, 'left', 2).map((p) => [p.x, p.y])).toEqual([[0, 36], [0, 64]]);
  });

  it('leaves a single end where it always was', () => {
    const [only] = route([hub], [conn('c', at('hub', 'right'), free(400, 0))]);
    expect(only.start).toEqual(sideAnchor(hub, 'right').p);
  });

  it('leaves a connector without an id, or one the layout does not know, at the anchor', () => {
    const cs = [conn('a', at('hub', 'right'), free(400, 0)), conn('b', at('hub', 'right'), free(400, 300))];
    const get = board(hub, ...cs);
    const layout = buildConnectorLayout(get, cs);
    const anchor = sideAnchor(hub, 'right').p;
    expect(connectorGeom(get, { from: cs[0].from, to: cs[0].to, route: 'straight' }, layout)!.start).toEqual(anchor);
    expect(connectorGeom(get, { ...cs[0], id: 'other' }, layout)!.start).toEqual(anchor);
    expect(connectorGeom(get, cs[0], layout)!.start).not.toEqual(anchor);
  });

  it('keeps the ends of one connector apart from each other', () => {
    const a = box('a', 0, 0), b = box('b', 300, 0);
    const cs = [conn('x', at('a', 'right'), at('b', 'left')), conn('y', at('a', 'right'), at('b', 'left'))];
    const gs = route([a, b], cs);
    expect(gs[0].start.y).toBeLessThan(gs[1].start.y);
    expect(gs[0].end.y).toBeLessThan(gs[1].end.y);
    expect(gs[0].end.x).toBe(300);
  });

  it('never spreads the ends further apart than FAN_GAP, however big the shape', () => {
    const big = box('big', 0, 0, 1000, 1000);
    expect(fan(big, 'right', 3).map((p) => p.y)).toEqual([500 - FAN_GAP, 500, 500 + FAN_GAP]);
    expect(fan(big, 'top', 2).map((p) => p.x)).toEqual([500 - FAN_GAP / 2, 500 + FAN_GAP / 2]);
  });

  it('packs the ends evenly inside a short side, none on its corners', () => {
    const tiny = box('tiny', 0, 0, 20, 20);
    const ys = fan(tiny, 'right', 5).map((p) => p.y);
    for (let i = 0; i < 5; i++) expect(ys[i]).toBeCloseTo(10 + (i - 2) * (20 / 6));
    expect(ys[0]).toBeGreaterThan(0);
    expect(ys[4]).toBeLessThan(20);
    const many = fan(box('many', 0, 0, 100, 40), 'bottom', 40).map((p) => p.x);
    expect(many[0]).toBeGreaterThan(0);
    expect(many[39]).toBeLessThan(100);
    expect(new Set(many).size).toBe(40);
  });

  it('follows a rotated shape: the points lie on its rotated side, in order along it', () => {
    const o = box('r', 20, 40, 200, 100, { rotation: Math.PI / 2 });
    const pts = fan(o, 'right', 2).map((p) => toLocal(o, p));
    expect(pts[0].x).toBeCloseTo(200);
    expect(pts[1].x).toBeCloseTo(200);
    expect(pts[0].y).toBeCloseTo(36);
    expect(pts[1].y).toBeCloseTo(64);
    const top = fan(box('r2', 0, 0, 160, 80, { rotation: 0.6 }), 'top', 3);
    const local = top.map((p) => toLocal(box('r2', 0, 0, 160, 80, { rotation: 0.6 }), p));
    for (const l of local) expect(l.y).toBeCloseTo(0);
    expect(local.map((l) => Math.round(l.x * 1000) / 1000)).toEqual([52, 80, 108]);
  });

  it('keeps leaving the shape along the side\'s normal', () => {
    const cs = [conn('a', at('hub', 'right'), free(500, -200), 'elbow'), conn('b', at('hub', 'right'), free(500, 300), 'elbow')];
    for (const g of route([hub], cs)) {
      expect(g.pts[1].x).toBeGreaterThan(g.start.x);
      expect(g.pts[1].y).toBeCloseTo(g.start.y);
      expect(g.startDir).toEqual({ x: -1, y: 0 });
    }
  });

  it('orders the ends so that lines to targets above and below do not cross', () => {
    const above = box('above', 400, -300), below = box('below', 400, 300);
    const cs = [
      conn('down', at('hub', 'auto'), at('below', 'auto')),
      conn('up', at('hub', 'auto'), at('above', 'auto')),
      conn('level', at('hub', 'right'), free(600, 50)),
    ];
    const gs = route([hub, above, below], cs);
    const [down, up, level] = gs;
    expect(up.start.y).toBeLessThan(level.start.y);
    expect(level.start.y).toBeLessThan(down.start.y);
    for (const [p, q] of [[down, up], [down, level], [up, level]]) expect(crosses(p.start, p.end, q.start, q.end)).toBe(false);
  });

  it('orders the ends on a bottom side from left to right by where they go', () => {
    const left = box('left', -400, 300), right = box('right', 400, 300);
    const cs = [conn('r', at('hub', 'bottom'), at('right', 'top')), conn('l', at('hub', 'bottom'), at('left', 'top'))];
    const [r, l] = route([hub, left, right], cs);
    expect(l.start.x).toBeLessThan(r.start.x);
    expect(crosses(l.start, l.end, r.start, r.end)).toBe(false);
  });

  it('puts auto-anchored ends on the side that the pair of shapes chose', () => {
    const a = box('a', 0, 0), b = box('b', 110, 300, 1000, 100);
    const cs = [conn('c1', at('a', 'auto'), at('b', 'auto')), conn('c2', at('a', 'auto'), at('b', 'auto'))];
    const [g1, g2] = route([a, b], cs);
    expect(g1.start.y).toBe(100);
    expect(g2.start.y).toBe(100);
    expect(g1.start.x).toBeCloseTo(36);
    expect(g2.start.x).toBeCloseTo(64);
    expect(g1.end.y).toBe(300);
  });
});

describe('connectors spread along the outline of a shape', () => {
  const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

  it('ellipse: the points lie on the ellipse', () => {
    for (const rotation of [0, 0.5]) {
      const e = box('e', 30, 20, 200, 100, { kind: 'ellipse', rotation });
      for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
        for (const n of [2, 3, 5]) {
          for (const p of fan(e, side, n)) {
            const l = toLocal(e, p);
            expect(((l.x - 100) / 100) ** 2 + ((l.y - 50) / 50) ** 2).toBeCloseTo(1, 6);
          }
        }
      }
    }
  });

  it('ellipse: the ends are as far apart along the side as on a rectangle', () => {
    const e = box('e', 0, 0, 200, 100, { kind: 'ellipse' });
    const [a, b] = fan(e, 'right', 2);
    near(b.y - a.y, FAN_GAP);
    expect(a.x).toBeLessThan(200);
    near(a.x, b.x);
  });

  it('diamond: the points lie on its edges', () => {
    const d = box('d', 0, 0, 160, 100, { kind: 'diamond' });
    const [a, b] = fan(d, 'right', 2);
    // the right corner is (160, 50); the edges run up and down to (80, 0) and (80, 100)
    near(a.x, 160 - (14 * 80) / 50);
    near(a.y, 36);
    near(b.x, a.x);
    near(b.y, 64);
    const [t1, t2, t3] = fan(d, 'top', 3);
    near(t2.x, 80);
    near(t2.y, 0);
    near(t1.y, t3.y);
    expect(t1.y).toBeGreaterThan(0);
  });

  it('every polygon kind: the points lie on its outline, and the middle of an odd number is the anchor', () => {
    let seen = 0;
    for (const { kind } of SHAPE_KINDS) {
      const pts = shapePolygon(kind, 160, 100);
      if (!pts) continue;
      seen++;
      const closed = [...pts, pts[0]].map(([x, y]) => ({ x, y }));
      const o = box('p', 0, 0, 160, 100, { kind });
      for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
        for (const n of [2, 3]) {
          const ps = fan(o, side, n);
          for (const p of ps) expect(distToPolyline(p, closed), `${kind} ${side} ${n}`).toBeLessThan(1e-6);
          if (n === 3) {
            const a = shapeAnchor(kind, 160, 100, side);
            near(ps[1].x, a.x);
            near(ps[1].y, a.y);
          }
        }
      }
    }
    expect(seen).toBe(19);
  });

  it('rounded rectangle: the ends stay on the straight part of the side', () => {
    const r = box('r', 0, 0, 100, 60, { kind: 'rounded' });
    const ys = fan(r, 'right', 3).map((p) => p.y);
    expect(ys).toEqual([22.5, 30, 37.5]);
    expect(fan(box('r', 0, 0, 100, 20, { kind: 'rounded' }), 'bottom', 2).every((p) => p.x > 5 && p.x < 95)).toBe(true);
  });

  it('terminator: flat on top and bottom, on the rounded ends at the sides', () => {
    const t = box('t', 0, 0, 160, 60, { kind: 'terminator' });
    expect(fan(t, 'top', 3).map((p) => [p.x, p.y])).toEqual([[55, 0], [80, 0], [105, 0]]);
    for (const p of fan(t, 'right', 3)) near(((p.x - 130) / 30) ** 2 + ((p.y - 30) / 30) ** 2, 1);
    for (const p of fan(t, 'left', 2)) near(((p.x - 30) / 30) ** 2 + ((p.y - 30) / 30) ** 2, 1);
    const [a, b, c] = fan(t, 'right', 3);
    expect([a.x < 160, b.x, c.x < 160]).toEqual([true, 160, true]);
  });

  it('cylinder: flat at the sides, on the arcs at the top and bottom', () => {
    const c = box('c', 0, 0, 100, 120, { kind: 'cylinder' });
    expect(fan(c, 'left', 3).map((p) => [p.x, p.y])).toEqual([[0, 39], [0, 60], [0, 81]]);
    for (const p of fan(c, 'top', 3)) near(((p.x - 50) / 50) ** 2 + ((p.y - 18) / 18) ** 2, 1);
    for (const p of fan(c, 'bottom', 2)) near(((p.x - 50) / 50) ** 2 + ((p.y - 102) / 18) ** 2, 1);
  });

  it('kinds without an outline worked out keep every end at the anchor', () => {
    for (const kind of ['heart', 'cloud', 'callout-round', 'document', 'delay', 'display'] as ShapeKind[]) {
      const o = box('k', 0, 0, 160, 100, { kind });
      for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
        const anchor = sideAnchor(o, side).p;
        for (const p of fan(o, side, 3)) expect(p, `${kind} ${side}`).toEqual(anchor);
      }
    }
  });

  it('other objects spread along the edge of their box, and ellipse-like ones along the ellipse', () => {
    const sticky: BaseObj = { id: 's', type: 'sticky', x: 0, y: 0, w: 120, h: 90, rotation: 0, z: 'a0' };
    expect(fan(sticky, 'right', 2).map((p) => [p.x, p.y])).toEqual([[120, 31], [120, 59]]);
    const usecase: BaseObj = { id: 'u', type: 'uml-usecase', x: 0, y: 0, w: 200, h: 100, rotation: 0, z: 'a0' };
    for (const p of fan(usecase, 'right', 3)) near(((p.x - 100) / 100) ** 2 + ((p.y - 50) / 50) ** 2, 1);
  });

  it('slotAnchor gives nothing for a shape without an outline', () => {
    expect(slotAnchor(box('h', 0, 0, 100, 100, { kind: 'heart' }), 'right', { index: 0, count: 2 })).toBeNull();
    expect(slotAnchor(box('z', 0, 0, 0, 0), 'right', { index: 0, count: 2 })).toBeNull();
  });
});

describe('movedConnectors', () => {
  const hub = box('hub', 0, 0);
  const t1 = box('t1', 400, -300), t2 = box('t2', 400, 300);
  const layoutOf = (objs: Obj[], cs: ConnectorObj[]) => buildConnectorLayout(board(...objs), cs);
  const c1 = conn('c1', at('hub', 'right'), at('t1', 'left'));
  const c2 = conn('c2', at('hub', 'right'), at('t2', 'left'));

  it('finds nothing when no slot changed', () => {
    expect(movedConnectors(layoutOf([hub, t1, t2], [c1, c2]), layoutOf([hub, t1, t2], [c1, c2]))).toEqual([]);
  });

  it('finds the connector that was already there when another joins its side', () => {
    const before = layoutOf([hub, t1, t2], [c1]);
    const after = layoutOf([hub, t1, t2], [c1, c2]);
    expect(movedConnectors(before, after).sort()).toEqual(['c1', 'c2']);
  });

  it('finds the one left behind when a connector leaves', () => {
    const before = layoutOf([hub, t1, t2], [c1, c2]);
    expect(movedConnectors(before, layoutOf([hub, t1, t2], [c2])).sort()).toEqual(['c1', 'c2']);
  });

  it('finds both when moving a target changes their order', () => {
    const before = layoutOf([hub, t1, t2], [c1, c2]);
    const swapped = layoutOf([hub, box('t1', 400, 300), box('t2', 400, -300)], [c1, c2]);
    expect(movedConnectors(before, swapped).sort()).toEqual(['c1', 'c2']);
  });

  it('does not report a connector whose slot is the same', () => {
    const c3 = conn('c3', at('t1', 'top'), free(0, -900));
    const before = layoutOf([hub, t1, t2], [c1, c2]);
    expect(movedConnectors(before, layoutOf([hub, t1, t2], [c1, c2, c3]))).toEqual(['c3']);
  });
});
