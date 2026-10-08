import { describe, expect, it } from 'vitest';
import type { BaseObj, ConnectorObj, End, Obj, Route, Side } from '../src/types';
import { buildConnectorLayout, center, connectorGeom, endSlot, objBounds, resolveSides, rotate } from '../src/geometry';
import { objectMarkup } from '../src/markup';

const box = (id: string, x: number, y: number, w = 100, h = 100, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'shape', kind: 'rect', x, y, w, h, rotation: 0, z: 'a0', ...extra,
});

const conn = (id: string, from: End, to: End, route: Route = 'elbow'): ConnectorObj => ({
  id, type: 'connector', z: 'a1', from, to, route, startHead: 'none', endHead: 'arrow',
});

const at = (id: string, anchor: 'auto' | Side): End => ({ kind: 'bound', id, anchor });
const free = (x: number, y: number): End => ({ kind: 'free', x, y });

const board = (...objs: Obj[]) => {
  const m = new Map(objs.map((o) => [o.id, o]));
  return (id: string) => m.get(id);
};

const slots = (layout: ReturnType<typeof buildConnectorLayout>, ...keys: [string, 'from' | 'to'][]) =>
  keys.map(([id, end]) => endSlot(layout, id, end));

describe('resolveSides', () => {
  it('gives the box and side of each bound end, and nothing for a free end', () => {
    const get = board(box('a', 0, 0), box('b', 400, 0));
    const r = resolveSides(get, { from: at('a', 'auto'), to: free(500, 500) })!;
    expect(r.from.id).toBe('a');
    expect(r.from.side).toBe('bottom');
    expect(r.to.id).toBeNull();
    expect(r.to.side).toBeUndefined();
    expect(r.to.p).toEqual({ x: 500, y: 500 });
    const e = resolveSides(get, { from: at('a', 'left'), to: at('b', 'top') })!;
    expect([e.from.side, e.to.side]).toEqual(['left', 'top']);
  });

  it('faces each end towards the other end', () => {
    const get = board(box('a', 0, 0), box('b', 400, 0));
    const r = resolveSides(get, { from: at('a', 'right'), to: free(7, 9) })!;
    expect(r.from.toward).toEqual({ x: 7, y: 9 });
    expect(r.to.toward).toEqual(center(box('a', 0, 0)));
  });

  it('is null when an end is bound to something that is not a box', () => {
    const get = board(box('a', 0, 0), conn('c', free(0, 0), free(9, 9)));
    expect(resolveSides(get, { from: at('a', 'auto'), to: at('c', 'auto') })).toBeNull();
    expect(resolveSides(get, { from: at('a', 'auto'), to: at('missing', 'auto') })).toBeNull();
  });

  it('connects auto-anchored boxes across the larger gap, not towards the centre', () => {
    const a = box('a', 0, 0), b = box('b', 110, 300, 1000, 100);
    const r = resolveSides(board(a, b), { from: at('a', 'auto'), to: at('b', 'auto') })!;
    expect([r.from.side, r.to.side]).toEqual(['bottom', 'top']);
  });
});

describe('buildConnectorLayout', () => {
  const hub = box('hub', 0, 0, 100, 100);

  it('orders the ends on a left or right side by the other end, top to bottom', () => {
    const cs = [
      conn('low', at('hub', 'right'), free(400, 300)),
      conn('high', at('hub', 'right'), free(400, -200)),
      conn('mid', at('hub', 'right'), free(400, 40)),
    ];
    const layout = buildConnectorLayout(board(hub), cs);
    expect(slots(layout, ['high', 'from'], ['mid', 'from'], ['low', 'from'])).toEqual([
      { index: 0, count: 3 }, { index: 1, count: 3 }, { index: 2, count: 3 },
    ]);
    const left = buildConnectorLayout(board(hub), cs.map((c) => ({ ...c, from: at('hub', 'left') as End })));
    expect(slots(left, ['high', 'from'], ['mid', 'from'], ['low', 'from']).map((s) => s?.index)).toEqual([0, 1, 2]);
  });

  it('orders the ends on a top or bottom side by the other end, left to right', () => {
    const cs = [
      conn('east', at('hub', 'bottom'), free(500, 400)),
      conn('west', at('hub', 'bottom'), free(-300, 400)),
      conn('mid', at('hub', 'bottom'), free(60, 400)),
    ];
    const layout = buildConnectorLayout(board(hub), cs);
    expect(slots(layout, ['west', 'from'], ['mid', 'from'], ['east', 'from']).map((s) => s?.index)).toEqual([0, 1, 2]);
    const top = buildConnectorLayout(board(hub), cs.map((c) => ({ ...c, from: at('hub', 'top') as End })));
    expect(slots(top, ['west', 'from'], ['mid', 'from'], ['east', 'from']).map((s) => s?.index)).toEqual([0, 1, 2]);
  });

  it('uses the centre of a bound other end', () => {
    const get = board(hub, box('up', 300, -400), box('down', 300, 400));
    const layout = buildConnectorLayout(get, [
      conn('c1', at('hub', 'right'), at('down', 'left')),
      conn('c2', at('hub', 'right'), at('up', 'left')),
    ]);
    expect(slots(layout, ['c2', 'from'], ['c1', 'from'])).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }]);
    expect(slots(layout, ['c1', 'to'], ['c2', 'to'])).toEqual([{ index: 0, count: 1 }, { index: 0, count: 1 }]);
  });

  it('breaks ties by connector id, whatever order the connectors come in', () => {
    const cs = [
      conn('b', at('hub', 'right'), free(400, 50)),
      conn('c', at('hub', 'right'), free(400, 50)),
      conn('a', at('hub', 'right'), free(400, 50)),
    ];
    for (const list of [cs, [...cs].reverse(), [cs[1], cs[2], cs[0]]]) {
      const layout = buildConnectorLayout(board(hub), list);
      expect(slots(layout, ['a', 'from'], ['b', 'from'], ['c', 'from']).map((s) => s?.index)).toEqual([0, 1, 2]);
    }
  });

  it('treats positions closer than a thousandth of a unit as a tie', () => {
    const layout = buildConnectorLayout(board(hub), [
      conn('a', at('hub', 'right'), free(400, 100.0004)),
      conn('b', at('hub', 'right'), free(400, 100)),
    ]);
    expect(slots(layout, ['a', 'from'], ['b', 'from']).map((s) => s?.index)).toEqual([0, 1]);
  });

  it('measures a rotated shape in its own frame', () => {
    const a = box('a', 0, 0, 200, 100, { rotation: Math.PI / 2 });
    // turned a quarter turn, its right side faces down, and its local y runs towards world -x
    const layout = buildConnectorLayout(board(a), [
      conn('a', at('a', 'right'), free(-50, 400)),
      conn('b', at('a', 'right'), free(250, 400)),
    ]);
    expect(slots(layout, ['b', 'from'], ['a', 'from'])).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }]);
  });

  it('keeps a rotated shape\'s tie to the id even when the projection is not exact', () => {
    const o = box('o', 0, 0, 200, 100, { rotation: 0.3 });
    const world = (lx: number, ly: number) => rotate({ x: o.x + lx, y: o.y + ly }, center(o), 0.3);
    const p = world(500, 40), q = world(-300, 40);
    const layout = buildConnectorLayout(board(o), [
      conn('a', at('o', 'right'), free(p.x, p.y)),
      conn('b', at('o', 'right'), free(q.x, q.y)),
    ]);
    expect(slots(layout, ['a', 'from'], ['b', 'from']).map((s) => s?.index)).toEqual([0, 1]);
  });

  it('counts each side of a shape on its own', () => {
    const layout = buildConnectorLayout(board(hub), [
      conn('r1', at('hub', 'right'), free(400, 0)),
      conn('r2', at('hub', 'right'), free(400, 90)),
      conn('t', at('hub', 'top'), free(50, -400)),
      conn('l', at('hub', 'left'), free(-400, 50)),
    ]);
    expect(slots(layout, ['r1', 'from'], ['r2', 'from'], ['t', 'from'], ['l', 'from'])).toEqual([
      { index: 0, count: 2 }, { index: 1, count: 2 }, { index: 0, count: 1 }, { index: 0, count: 1 },
    ]);
  });

  it('numbers the ends of both directions together, and lets a line enter a shape that others leave', () => {
    const get = board(hub, box('far', 500, 0));
    const layout = buildConnectorLayout(get, [
      conn('out', at('hub', 'right'), free(400, 90)),
      conn('in', at('far', 'left'), at('hub', 'right')),
    ]);
    // the incoming line's other end is far's centre (y 50), above the outgoing line's target (y 90)
    expect(slots(layout, ['in', 'to'], ['out', 'from'])).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }]);
  });

  it('gives a free end no slot but still slots the bound end of the same connector', () => {
    const layout = buildConnectorLayout(board(hub), [
      conn('half', at('hub', 'right'), free(400, 50)),
      conn('loose', free(0, 0), free(100, 100)),
    ]);
    expect(endSlot(layout, 'half', 'from')).toEqual({ index: 0, count: 1 });
    expect(endSlot(layout, 'half', 'to')).toBeUndefined();
    expect(endSlot(layout, 'loose', 'from')).toBeUndefined();
    expect(endSlot(layout, 'loose', 'to')).toBeUndefined();
  });

  it('leaves out a connector from a shape to itself, and does not count it for the others', () => {
    const layout = buildConnectorLayout(board(hub), [
      conn('loop', at('hub', 'right'), at('hub', 'right')),
      conn('auto-loop', at('hub', 'auto'), at('hub', 'auto')),
      conn('other', at('hub', 'right'), free(400, 50)),
    ]);
    expect(endSlot(layout, 'loop', 'from')).toBeUndefined();
    expect(endSlot(layout, 'loop', 'to')).toBeUndefined();
    expect(endSlot(layout, 'auto-loop', 'from')).toBeUndefined();
    expect(endSlot(layout, 'other', 'from')).toEqual({ index: 0, count: 1 });
  });

  it('leaves out connectors that cannot be resolved', () => {
    const layout = buildConnectorLayout(board(hub), [
      conn('gone', at('hub', 'right'), at('missing', 'auto')),
      conn('ok', at('hub', 'right'), free(400, 50)),
    ]);
    expect(endSlot(layout, 'gone', 'from')).toBeUndefined();
    expect(endSlot(layout, 'ok', 'from')).toEqual({ index: 0, count: 1 });
  });

  it('groups auto-anchored ends under the side that is actually used', () => {
    // facing the centre of b would pick the right side of a; the larger gap is below it
    const a = box('a', 0, 0), b = box('b', 110, 300, 1000, 100);
    const get = board(a, b);
    const layout = buildConnectorLayout(get, [
      conn('auto', at('a', 'auto'), at('b', 'auto')),
      conn('explicit', at('a', 'bottom'), free(-200, 500)),
    ]);
    expect(slots(layout, ['explicit', 'from'], ['auto', 'from'])).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }]);
    expect(endSlot(layout, 'auto', 'to')).toEqual({ index: 0, count: 1 });
  });

  it('groups an auto end under the side that faces the other end when only one end is auto', () => {
    const b = box('b', 400, 0);
    const layout = buildConnectorLayout(board(hub, b), [
      conn('x', at('hub', 'auto'), at('b', 'left')),
      conn('y', at('hub', 'right'), free(600, 300)),
    ]);
    expect(slots(layout, ['x', 'from'], ['y', 'from'])).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }]);
  });

  it('is empty for a board without connectors', () => {
    expect(buildConnectorLayout(board(hub), []).size).toBe(0);
  });
});

describe('connectorGeom with a layout', () => {
  const objs: Obj[] = [
    box('hub', 200, 200, 120, 80),
    box('n', 200, -100),
    box('e', 600, 180, 100, 140),
    box('s', 180, 600, 160, 60),
    box('w', -200, 220, 100, 100, { rotation: 0.4 }),
    box('ell', 500, 500, 100, 100, { kind: 'ellipse' }),
  ];
  const cs: ConnectorObj[] = [
    conn('c1', at('hub', 'right'), at('e', 'left')),
    conn('c2', at('hub', 'right'), at('e', 'auto'), 'curved'),
    conn('c3', at('hub', 'auto'), at('e', 'auto'), 'straight'),
    conn('c4', at('hub', 'top'), at('n', 'bottom')),
    conn('c5', at('n', 'auto'), at('hub', 'top'), 'curved'),
    conn('c6', at('s', 'auto'), at('hub', 'auto')),
    conn('c7', at('hub', 'left'), at('w', 'auto'), 'straight'),
    conn('c8', at('w', 'right'), at('hub', 'left')),
    conn('c9', at('hub', 'bottom'), free(260, 800)),
    conn('c10', free(0, 0), at('hub', 'bottom'), 'curved'),
    conn('c11', at('hub', 'auto'), at('hub', 'auto')),
    conn('c12', at('ell', 'top'), at('hub', 'auto')),
    conn('c13', at('ell', 'auto'), at('ell', 'auto')),
    conn('c14', free(0, 0), free(50, 50)),
    conn('c15', at('missing', 'auto'), at('hub', 'auto')),
  ];
  const get = board(...objs, ...cs);
  const layout = buildConnectorLayout(get, cs);

  it('shares sides between several connectors in this board', () => {
    expect(endSlot(layout, 'c1', 'from')!.count).toBeGreaterThan(1);
    expect(endSlot(layout, 'c4', 'from')!.count).toBeGreaterThan(1);
    expect(endSlot(layout, 'c9', 'from')!.count).toBeGreaterThan(1);
  });

  it('returns the same geometry with and without it', () => {
    for (const c of cs) {
      expect(connectorGeom(get, c, layout)).toEqual(connectorGeom(get, c));
      expect(objBounds(get, c, layout)).toEqual(objBounds(get, c));
    }
  });

  it('returns the same geometry with an empty layout', () => {
    const none = buildConnectorLayout(get, []);
    for (const c of cs) expect(connectorGeom(get, c, none)).toEqual(connectorGeom(get, c));
  });

  it('draws the same markup with and without it', () => {
    for (const c of cs) {
      expect(objectMarkup(c, { get, layout: () => layout })).toBe(objectMarkup(c, { get }));
    }
  });
});
