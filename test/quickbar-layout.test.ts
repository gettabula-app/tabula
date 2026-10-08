import { describe, expect, it } from 'vitest';
import { clearOfDock, dockTopOf, placeBar } from '../src/ui/quickbar-layout';

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

describe('docked panels', () => {
  it('finds the top of a panel docked to the bottom edge, and none for a side panel', () => {
    expect(dockTopOf({ top: 300 }, 120)).toBe(300);
    expect(dockTopOf({ top: 120 }, 120)).toBeNull();
    expect(dockTopOf({ top: 72 }, 72)).toBeNull();
    expect(dockTopOf(null, 120)).toBeNull();
  });

  it('leaves a bar that already clears the panel where it is', () => {
    expect(clearOfDock(200, 44, 300, 120)).toBe(200);
    expect(clearOfDock(244, 44, 300, 120)).toBe(244);
    expect(clearOfDock(400, 44, null, 120)).toBe(400);
  });

  it('lifts a bar over the panel to just above it, but not into the top bars', () => {
    expect(clearOfDock(260, 44, 300, 120)).toBe(244);
    expect(clearOfDock(500, 44, 300, 120)).toBe(244);
    expect(clearOfDock(500, 44, 150, 120)).toBe(120);
  });

  it('keeps a bar placed in the room above the panel out of it', () => {
    const view = { w: 500, h: 300 };
    const wide = { w: 300, h: 44 };
    // selection in the room above the panel: above it, as before
    expect(placeBar({ x: 100, y: 200, w: 120, h: 40 }, wide, view, 0, undefined, 120).below).toBe(false);
    // selection low, under the panel: the bar lands above the panel rather than inside it
    const p = placeBar({ x: 100, y: 450, w: 120, h: 120 }, wide, view, 0, undefined, 120);
    expect(clearOfDock(p.y, wide.h, 300, 120) + wide.h + 12).toBeLessThanOrEqual(300);
  });
});
