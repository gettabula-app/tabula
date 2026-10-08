import { describe, expect, it } from 'vitest';
import { SHAPE_GROUPS, SHAPE_KINDS, defaultSize, shapeAnchor, shapePath, shapePolygon, shapePreviewSvg, textBox } from '../src/shapes';
import { distToPolyline, sideAnchor } from '../src/geometry';
import type { BaseObj, ShapeKind, Side } from '../src/types';

const SIZES: [number, number][] = [[192, 96], [144, 144], [60, 60], [300, 60], [60, 300]];
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
const SQUARE: ShapeKind[] = ['ellipse', 'diamond', 'star', 'octagon', 'pentagon', 'cross', 'heart', 'triangle', 'merge'];

describe('shape catalogue', () => {
  it('lists each kind once, in contiguous groups in SHAPE_GROUPS order', () => {
    const kinds = SHAPE_KINDS.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);

    const groups = SHAPE_KINDS.map((s) => s.group);
    const runs = groups.filter((g, i) => i === 0 || groups[i - 1] !== g);
    expect(runs).toEqual(['basic', 'arrows', 'callouts', 'flow']);
    expect(SHAPE_GROUPS.map(([g]) => g)).toEqual(['basic', 'arrows', 'callouts', 'flow']);

    const listed = SHAPE_GROUPS.map(([g]) => g);
    for (const { group } of SHAPE_KINDS) expect(listed).toContain(group);
  });

  it('gives the nine square kinds square default sizes', () => {
    for (const kind of SQUARE) {
      const { w, h } = defaultSize(kind);
      expect(w).toBe(h);
    }
  });
});

describe('every shape kind at several sizes', () => {
  for (const { kind } of SHAPE_KINDS) {
    for (const [W, H] of SIZES) {
      it(`${kind} ${W}x${H}`, () => {
        const path = shapePath(kind, W, H);
        expect(path.length).toBeGreaterThan(0);
        expect(path).not.toContain('NaN');

        const tb = textBox(kind, W, H);
        expect(tb.w).toBeGreaterThan(0);
        expect(tb.h).toBeGreaterThan(0);
        expect(tb.x).toBeGreaterThanOrEqual(0);
        expect(tb.y).toBeGreaterThanOrEqual(0);
        expect(tb.x + tb.w).toBeLessThanOrEqual(W + 1e-6);
        expect(tb.y + tb.h).toBeLessThanOrEqual(H + 1e-6);

        const poly = shapePolygon(kind, W, H);
        const outline = poly ? [...poly.map(([x, y]) => ({ x, y })), { x: poly[0][0], y: poly[0][1] }] : null;
        for (const side of SIDES) {
          const a = shapeAnchor(kind, W, H, side);
          expect(a.x).toBeGreaterThanOrEqual(-1e-6);
          expect(a.y).toBeGreaterThanOrEqual(-1e-6);
          expect(a.x).toBeLessThanOrEqual(W + 1e-6);
          expect(a.y).toBeLessThanOrEqual(H + 1e-6);
          expect(outline ? distToPolyline(a, outline) : 0).toBeLessThan(0.01);
        }

        expect(shapePreviewSvg(kind)).not.toContain('NaN');
      });
    }
  }
});

describe('existing outlines', () => {
  it('keep their original paths', () => {
    expect(shapePath('triangle', 192, 96)).toBe('M96 0L192 96L0 96Z');
    expect(shapePath('diamond', 192, 96)).toBe('M96 0L192 48L96 96L0 48Z');
    expect(shapePath('hexagon', 192, 96)).toBe('M48 0L144 0L192 48L144 96L48 96L0 48Z');
    expect(shapePath('rect', 192, 96)).toBe('M0 0H192V96H0Z');
  });
});

describe('connector anchors on shapes', () => {
  it('attach to the outline of a triangle', () => {
    const tri: BaseObj = { id: 't', type: 'shape', kind: 'triangle', x: 100, y: 100, w: 200, h: 100, rotation: 0, z: 'a0' };
    const top = sideAnchor(tri, 'top');
    expect(top.p.x).toBeCloseTo(200);
    expect(top.p.y).toBeCloseTo(100);
    // Mid-height of the left edge sits a quarter of the way across the box.
    const left = sideAnchor(tri, 'left');
    expect(left.p.x).toBeCloseTo(150);
    expect(left.p.y).toBeCloseTo(150);
  });
});
