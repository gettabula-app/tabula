import { describe, expect, it } from 'vitest';
import { placeBar } from '../src/ui/quickbar-layout';

const view = { w: 1000, h: 800 };
const bar = { w: 300, h: 40 };

describe('placeBar', () => {
  it('fits above the target, centred on it', () => {
    expect(placeBar({ x: 400, y: 300, w: 200, h: 100 }, bar, view)).toEqual({ x: 350, y: 248, below: false });
  });

  it('lifts above a rotate handle', () => {
    expect(placeBar({ x: 400, y: 150, w: 200, h: 100 }, bar, view, 28)).toEqual({ x: 350, y: 70, below: false });
  });

  it('flips below when too close to the top', () => {
    expect(placeBar({ x: 400, y: 90, w: 200, h: 50 }, bar, view)).toEqual({ x: 350, y: 152, below: true });
  });

  it('clamps x at the left edge', () => {
    expect(placeBar({ x: 0, y: 300, w: 20, h: 20 }, bar, view).x).toBe(12);
  });

  it('clamps x at the right edge', () => {
    expect(placeBar({ x: 980, y: 300, w: 20, h: 20 }, bar, view).x).toBe(688);
  });

  it('uses the margin when the bar is wider than the view', () => {
    expect(placeBar({ x: 0, y: 300, w: 20, h: 20 }, bar, { w: 200, h: 800 }).x).toBe(12);
  });

  it('keeps the fallback fully inside the viewport', () => {
    const p = placeBar({ x: 0, y: 0, w: 800, h: 600 }, bar, { w: 1000, h: 600 });
    expect(p.below).toBe(true);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + bar.h).toBeLessThanOrEqual(600);
  });

  it('moves below the target when above would cover one of its connectors, and below would not', () => {
    const target = { x: 400, y: 300, w: 200, h: 100 };
    const connector = { x: 480, y: 250, w: 200, h: 20 }; // runs right above the shape
    expect(placeBar(target, bar, view, 0, undefined, undefined, undefined, [connector])).toEqual({ x: 350, y: 412, below: true });
    // nothing in the way: above, as before
    expect(placeBar(target, bar, view, 0, undefined, undefined, undefined, [{ x: 0, y: 700, w: 10, h: 10 }]).below).toBe(false);
    // covered either way: stays above
    expect(placeBar(target, bar, view, 0, undefined, undefined, undefined, [connector, { x: 400, y: 420, w: 300, h: 30 }]).below).toBe(false);
  });
});
