import { describe, expect, it } from 'vitest';
import { placePopover, type PopoverRect } from '../src/ui/popover-layout';

const rect = (left: number, top: number, width: number, height: number): PopoverRect => ({ left, top, right: left + width, bottom: top + height, width, height });
const safe = { top: 0, right: 0, bottom: 0, left: 0 };
const viewport = { width: 1000, height: 700 };

describe('a panel meant to open upward', () => {
  it('keeps above its anchor when it fits there', () => {
    const anchor = rect(480, 400, 32, 32);
    const placed = placePopover(anchor, { width: 220, height: 260 }, viewport, safe, 'top');
    expect(placed.top + 260).toBeLessThanOrEqual(anchor.top);
    expect(placed.maxHeight).not.toBeNull();
  });

  it('flips below when a selection sits near the top and there is more room below', () => {
    // the selection toolbar's More button 40px from the top of the window: no room for a 320px menu above, plenty below
    const anchor = rect(480, 40, 32, 32);
    const placed = placePopover(anchor, { width: 220, height: 320 }, viewport, safe, 'top');
    expect(placed.top).toBeGreaterThanOrEqual(anchor.bottom);
    // and it is fully inside the window, scrolling inside the room it has if it must
    const height = Math.min(320, placed.maxHeight ?? 320);
    expect(placed.top + height).toBeLessThanOrEqual(viewport.height - 8);
  });

  it('stays inside the window at the left and right edges', () => {
    const left = placePopover(rect(2, 40, 32, 32), { width: 220, height: 320 }, viewport, safe, 'top');
    const right = placePopover(rect(970, 40, 28, 32), { width: 220, height: 320 }, viewport, safe, 'top');
    expect(left.left).toBeGreaterThanOrEqual(8);
    expect(right.left + 220).toBeLessThanOrEqual(viewport.width - 8);
  });

  it('keeps its side when it is placed against another box', () => {
    const bar = rect(400, 20, 200, 40);
    const placed = placePopover(rect(480, 40, 32, 32), { width: 220, height: 320 }, viewport, safe, 'top', bar);
    expect(placed.top + Math.min(320, placed.maxHeight ?? 320)).toBeLessThanOrEqual(bar.top);
  });
});
