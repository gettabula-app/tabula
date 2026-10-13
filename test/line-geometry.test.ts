import { describe, expect, it } from 'vitest';
import type { ConnectorObj, Obj } from '../src/types';
import { axisLock, isLine, lineAngleDeg, lineFlag, lineLabel, snapAngle } from '../src/line-geometry';

const deg = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;

const line = (extra: Partial<ConnectorObj> = {}): ConnectorObj => ({
  id: 'l1', type: 'connector', z: 'a0', from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 100, y: 0 },
  route: 'straight', startHead: 'none', endHead: 'none', line: true, ...extra,
});

describe('lineAngleDeg', () => {
  it('measures counter-clockwise from +x as the user sees it (screen y points down)', () => {
    const o = { x: 0, y: 0 };
    expect(lineAngleDeg(o, { x: 10, y: 0 })).toBe(0);
    expect(lineAngleDeg(o, { x: 0, y: -10 })).toBe(90); // up on screen
    expect(lineAngleDeg(o, { x: -10, y: 0 })).toBe(180);
    expect(lineAngleDeg(o, { x: 0, y: 10 })).toBe(270); // down on screen
  });

  it('rounds to whole degrees and stays in 0 to 359', () => {
    const o = { x: 0, y: 0 };
    expect(lineAngleDeg(o, { x: 100, y: -57.735 })).toBe(30);
    expect(lineAngleDeg(o, { x: 100, y: 0.2 })).toBe(0); // a tiny dip below the axis is 0, not 360
    expect(lineAngleDeg(o, { x: 100, y: 1 })).toBe(359);
    for (let a = 0; a < 360; a += 7) {
      const r = (a * Math.PI) / 180;
      const v = lineAngleDeg(o, { x: Math.cos(r) * 50, y: -Math.sin(r) * 50 });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(360);
      expect(v).toBe(a);
    }
  });
});

describe('lineLabel', () => {
  it('shows the length in whole world px and the angle, joined by a middle dot', () => {
    expect(lineLabel({ x: 0, y: 0 }, { x: 161, y: -93 })).toBe('186 px · 30°');
    expect(lineLabel({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe('0 px · 0°');
  });

  it('rounds the length, not the angle, separately', () => {
    expect(lineLabel({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe('5 px · 307°');
  });
});

describe('snapAngle', () => {
  it('snaps to 15 degree steps from the start, keeping the distance', () => {
    const start = { x: 0, y: 0 };
    const snapped = snapAngle(start, { x: 100, y: 30 });
    expect(Math.hypot(snapped.x, snapped.y)).toBeCloseTo(Math.hypot(100, 30), 9);
    // y points down here, so the step at +15 degrees in screen terms is 15 degrees below the axis in the maths sense
    expect((Math.atan2(snapped.y, snapped.x) * 180) / Math.PI).toBeCloseTo(15, 9);
  });

  it('leaves a point that is already on a step alone and rounds the ones between', () => {
    const start = { x: 5, y: 5 };
    const on = snapAngle(start, { x: 5 + 40, y: 5 - 40 * Math.tan((30 * Math.PI) / 180) });
    expect(deg(start, on)).toBeCloseTo(30, 9);
    expect(deg(start, snapAngle(start, { x: 5 + 40, y: 5 - 40 * Math.tan((7 * Math.PI) / 180) }))).toBeCloseTo(0, 9);
    expect(deg(start, snapAngle(start, { x: 5 + 40, y: 5 - 40 * Math.tan((8 * Math.PI) / 180) }))).toBeCloseTo(15, 9);
  });

  it('snaps to the 15 degree grid anywhere round the circle', () => {
    const start = { x: 0, y: 0 };
    for (const step of [-165, -90, -15, 45, 100, 170]) {
      const r = (step * Math.PI) / 180;
      const p = { x: Math.cos(r) * 80 + 1, y: Math.sin(r) * 80 - 1 };
      const a = deg(start, snapAngle(start, p));
      const n = Math.round(a / 15) * 15;
      expect(Math.abs(a - n)).toBeLessThan(1e-9);
    }
  });

  it('returns the start for a point on the start', () => {
    expect(snapAngle({ x: 3, y: 4 }, { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });
});

describe('axisLock', () => {
  it('keeps the start on the other axis, the axis the pointer is further along', () => {
    expect(axisLock({ x: 0, y: 0 }, { x: 80, y: 20 })).toEqual({ x: 80, y: 0 });
    expect(axisLock({ x: 0, y: 0 }, { x: 20, y: -80 })).toEqual({ x: 0, y: -80 });
  });
});

describe('lineFlag and isLine', () => {
  it('is a line only while both ends are free and the route is straight', () => {
    expect(isLine(line())).toBe(true);
    expect(lineFlag(line())).toBe(true);
  });

  it('is not a line once an end is bound, or the route is elbow or curved, even with the flag still set', () => {
    expect(isLine(line({ to: { kind: 'bound', id: 'b', anchor: 'auto' } }))).toBe(false);
    expect(isLine(line({ route: 'elbow' }))).toBe(false);
    expect(isLine(line({ route: 'curved' }))).toBe(false);
  });

  it('is not a line without the flag, and never a non-connector', () => {
    expect(isLine(line({ line: undefined }))).toBe(false);
    expect(isLine(line({ line: false }))).toBe(false);
    const box = { id: 'r', type: 'shape', kind: 'rect', x: 0, y: 0, w: 1, h: 1, z: 'a', line: true } as unknown as Obj;
    expect(isLine(box)).toBe(false);
    expect(isLine(undefined)).toBe(false);
  });
});
