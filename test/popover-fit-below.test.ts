import { describe, expect, it } from 'vitest';
import { placePopover, type PopoverRect } from '../src/ui/popover-layout';

const rect = (left: number, top: number, width: number, height: number): PopoverRect => ({ left, top, width, height, right: left + width, bottom: top + height });
const safe = { top: 0, right: 0, bottom: 0, left: 0 };

describe('a bottom panel that must not cover its anchor', () => {
  const anchor = rect(500, 235, 100, 80);
  const panel = { width: 344, height: 900 };
  const viewport = { width: 1280, height: 800 };

  it('slid up over the anchor without the option (the old behaviour other popovers rely on)', () => {
    const p = placePopover(anchor, panel, viewport, safe, 'bottom');
    expect(p.maxHeight).toBeNull();
    expect(p.top).toBeLessThan(anchor.bottom);
  });

  it('stays below the anchor and takes the room left as its height with fitBelow', () => {
    const p = placePopover(anchor, panel, viewport, safe, 'bottom', undefined, true);
    expect(p.top).toBeGreaterThanOrEqual(anchor.bottom);
    expect(p.maxHeight).toBe(800 - 8 - (anchor.bottom + 8));
  });
});
