import { describe, expect, it } from 'vitest';
import { center, connectorGeom, rotate } from '../src/geometry';
import { mirrorPoint, normalizeRotation, planFlip } from '../src/flip';
import type { BaseObj, ConnectorObj, Obj, Point } from '../src/types';

const corners = (o: BaseObj): Point[] => {
  const box = [[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]] as const;
  return box.map(([x0, y0]) => {
    const x = o.flipX === true ? o.w - x0 : x0;
    const y = o.flipY === true ? o.h - y0 : y0;
    return rotate({ x: o.x + x, y: o.y + y }, center(o), o.rotation || 0);
  });
};

const pointSet = (points: Point[]) => points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();
const pointList = (points: Point[]) => points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);
const object = (extra: Partial<BaseObj> = {}): BaseObj => ({
  id: 'a', type: 'shape', x: 80, y: 40, w: 80, h: 50, rotation: 0, z: 'a0', ...extra,
});

describe('selection flip math', () => {
  it.each([0, 30, 90, -45, 180])('mirrors rotated corners for horizontal and vertical flips at %i°', (degrees) => {
    const before = object({ rotation: degrees * Math.PI / 180 });
    const about = { x: 160, y: 90 };
    for (const axis of ['horizontal', 'vertical'] as const) {
      const patch = planFlip([before], [], axis, about)[0].patch as Partial<BaseObj>;
      const after = { ...before, ...patch };
      const expected = corners(before).map((p) => mirrorPoint(p, axis, about));
      expect(pointSet(corners(after))).toEqual(pointSet(expected));
      expect(after.w).toBe(before.w);
      expect(after.h).toBe(before.h);
      expect(after.rotation).toBe(normalizeRotation(-before.rotation));
    }
  });

  it('returns the original flag and rotation after flipping the same axis twice', () => {
    const before = object({ rotation: 0.73 });
    const about = center(before);
    const once = { ...before, ...planFlip([before], [], 'horizontal', about)[0].patch } as BaseObj;
    const twice = { ...once, ...planFlip([once], [], 'horizontal', about)[0].patch } as BaseObj;
    expect(twice.flipX).toBeUndefined();
    expect(twice.rotation).toBe(before.rotation);
    expect(twice.x).toBe(before.x);
    expect(twice.y).toBe(before.y);
  });

  it('mirrors every selected box centre around the selection bounds centre', () => {
    const a = object({ id: 'a', x: 10, y: 20, w: 40, h: 30 });
    const b = object({ id: 'b', x: 190, y: 70, w: 60, h: 50 });
    const about = { x: 130, y: 55 };
    const patches = new Map(planFlip([a, b], [], 'horizontal', about).map((p) => [p.id, p.patch as Partial<BaseObj>]));
    expect(center({ ...a, ...patches.get('a') })).toEqual({ x: 230, y: 35 });
    expect(center({ ...b, ...patches.get('b') })).toEqual({ x: 40, y: 95 });
  });

  it('mirrors free connector ends and swaps bound anchor sides only when both attached objects move', () => {
    const a = object({ id: 'a', x: 0 });
    const b = object({ id: 'b', x: 200 });
    const between: Obj = {
      id: 'line', type: 'connector', z: 'a1', route: 'elbow', startHead: 'none', endHead: 'arrow',
      from: { kind: 'bound', id: 'a', anchor: 'left' }, to: { kind: 'bound', id: 'b', anchor: 'right' },
    };
    const free: Obj = {
      id: 'free', type: 'connector', z: 'a2', route: 'curved', startHead: 'none', endHead: 'none',
      from: { kind: 'free', x: 20, y: 40 }, to: { kind: 'free', x: 100, y: 80 },
    };
    const patches = new Map(planFlip([a, b, free], [between as Extract<Obj, { type: 'connector' }>, free as Extract<Obj, { type: 'connector' }>], 'horizontal', { x: 100, y: 65 }).map((p) => [p.id, p.patch]));
    expect(patches.get('line')).toEqual({ from: { kind: 'bound', id: 'a', anchor: 'right' }, to: { kind: 'bound', id: 'b', anchor: 'left' } });
    expect(patches.get('free')).toEqual({
      from: { kind: 'free', x: 180, y: 40 }, to: { kind: 'free', x: 100, y: 80 },
    });
  });

  it.each(['straight', 'elbow', 'curved'] as const)('rebuilds mirrored %s routes from flipped endpoints', (route) => {
    const a = object({ id: 'a', x: 0, y: 0, w: 80, h: 60 });
    const b = object({ id: 'b', x: 220, y: 100, w: 80, h: 60 });
    const line: ConnectorObj = {
      id: 'line', type: 'connector', z: 'a1', route, startHead: 'none', endHead: 'arrow',
      from: { kind: 'bound', id: 'a', anchor: 'right' }, to: { kind: 'bound', id: 'b', anchor: 'left' },
    };
    const about = { x: 150, y: 80 };
    const beforeObjects = new Map<string, Obj>([['a', a], ['b', b], ['line', line]]);
    const beforeGet = (id: string): Obj | undefined => beforeObjects.get(id);
    const before = connectorGeom(beforeGet, line)!;
    for (const axis of ['horizontal', 'vertical'] as const) {
      let nextA = a, nextB = b, nextLine = line;
      for (const { id, patch } of planFlip([a, b], [line], axis, about)) {
        if (id === 'a') nextA = { ...a, ...patch } as BaseObj;
        if (id === 'b') nextB = { ...b, ...patch } as BaseObj;
        if (id === 'line') nextLine = { ...line, ...patch } as ConnectorObj;
      }
      const afterGet = (id: string): Obj | undefined => {
        if (id === 'a') return nextA;
        if (id === 'b') return nextB;
        if (id === 'line') return nextLine;
      };
      const after = connectorGeom(afterGet, nextLine)!;
      const expected = before.pts.map((p) => mirrorPoint(p, axis, about));
      expect(pointList(after.pts)).toEqual(pointList(expected));
    }
  });
});
