import { describe, expect, it } from 'vitest';
import {
  center, connectorGeom, distToPolyline, rotate, sideAnchor, slotAnchor,
} from '../src/geometry';
import { shapeAnchor, shapePolygon } from '../src/shapes';
import type { BaseObj, ConnectorObj, Point, ShapeKind, Side } from '../src/types';

const box = (id: string, kind: ShapeKind, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'shape', kind, x: 80, y: 40, w: 150, h: 100, rotation: 0, z: 'a0', ...extra,
});

const opposite = (side: Side, flipX: boolean, flipY: boolean): Side => {
  let out = side;
  if (flipX) out = out === 'left' ? 'right' : out === 'right' ? 'left' : out;
  if (flipY) out = out === 'top' ? 'bottom' : out === 'bottom' ? 'top' : out;
  return out;
};

const mirrorLocal = (o: BaseObj, p: Point): Point => ({
  x: o.flipX === true ? o.w - p.x : p.x,
  y: o.flipY === true ? o.h - p.y : p.y,
});

const worldPoint = (o: BaseObj, p: Point): Point => {
  const q = mirrorLocal(o, p);
  return rotate({ x: o.x + q.x, y: o.y + q.y }, center(o), o.rotation || 0);
};

const visibleAnchor = (o: BaseObj, side: Side): Point => {
  const contentSide = opposite(side, o.flipX === true, o.flipY === true);
  return worldPoint(o, shapeAnchor(o.kind || 'rect', o.w, o.h, contentSide));
};

function visibleOutline(o: BaseObj): Point[] {
  const polygon = shapePolygon(o.kind || 'rect', o.w, o.h);
  if (!polygon) throw new Error(`${o.kind} has no polygon outline`);
  const points = polygon.map(([x, y]) => worldPoint(o, { x, y }));
  return [...points, points[0]];
}

function expectOnVisibleOutline(o: BaseObj, p: Point) {
  expect(distToPolyline(p, visibleOutline(o))).toBeLessThan(1e-5);
}

const bound = (id: string, anchor: Side): ConnectorObj['from'] => ({ kind: 'bound', id, anchor });

describe('flipped connector anchors', () => {
  it.each([0, 30, 90])('mirrors arrow and callout anchors onto their visual sides at %i°', (degrees) => {
    const rotation = degrees * Math.PI / 180;
    const arrow = box('arrow', 'arrow-right', { flipX: true, rotation });
    const callout = box('callout', 'callout-round', { flipX: true, rotation });

    expect(sideAnchor(arrow, 'right').p).toEqual(visibleAnchor(arrow, 'right'));
    expect(sideAnchor(callout, 'right').p).toEqual(visibleAnchor(callout, 'right'));
  });

  it.each([0, 30, 90])('maps a vertically asymmetric shape through flipY at %i°', (degrees) => {
    const o = box('manual-input', 'manual-input', { flipY: true, rotation: degrees * Math.PI / 180 });
    expect(sideAnchor(o, 'top').p).toEqual(visibleAnchor(o, 'top'));
    expectOnVisibleOutline(o, sideAnchor(o, 'top').p);
  });

  it('keeps rect and ellipse anchors exactly unchanged by either mirror', () => {
    for (const kind of ['rect', 'ellipse'] as const) {
      for (const rotation of [0, Math.PI / 6, Math.PI / 2]) {
        const original = box('symmetric', kind, { rotation });
        for (const flags of [{ flipX: true }, { flipY: true }, { flipX: true, flipY: true }]) {
          const flipped = { ...original, ...flags };
          for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
            expect(sideAnchor(flipped, side)).toEqual(sideAnchor(original, side));
          }
        }
      }
    }
  });

  it('keeps symmetric rect and ellipse fan-out points exactly unchanged', () => {
    for (const kind of ['rect', 'ellipse'] as const) {
      const original = box('symmetric', kind);
      for (const flags of [{ flipX: true }, { flipY: true }, { flipX: true, flipY: true }]) {
        const flipped = { ...original, ...flags };
        for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
          for (let index = 0; index < 3; index++) {
            const slot = { index, count: 3 };
            expect(slotAnchor(flipped, side, slot)).toEqual(slotAnchor(original, side, slot));
          }
        }
      }
    }
  });

  it('mirrors the fan-out curve and preserves the visible side direction', () => {
    const o = box('triangle', 'triangle', { flipY: true });
    const points = [0, 1, 2].map((index) => slotAnchor(o, 'right', { index, count: 3 })!);
    for (const p of points) expectOnVisibleOutline(o, p);
    expect(points[0].y).toBeLessThan(points[1].y);
    expect(points[1].y).toBeLessThan(points[2].y);
    expect(sideAnchor(o, 'right').dir).toEqual({ x: 1, y: 0 });
  });

  it.each(['straight', 'elbow', 'curved'] as const)('keeps a flipped asymmetric endpoint on its outline for %s routes', (route) => {
    const o = box('manual-input', 'manual-input', { flipY: true });
    const connector: ConnectorObj = {
      id: 'line', type: 'connector', z: 'a1',
      from: bound(o.id, 'top'), to: { kind: 'free', x: 400, y: 60 }, route,
      startHead: 'none', endHead: 'none',
    };
    const get = (id: string) => id === o.id ? o : id === connector.id ? connector : undefined;
    const geom = connectorGeom(get, connector)!;

    expect(geom.start).toEqual(sideAnchor(o, 'top').p);
    expectOnVisibleOutline(o, geom.start);
  });
});
