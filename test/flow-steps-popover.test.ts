import { describe, expect, it } from 'vitest';
import { placePopover, type PopoverRect } from '../src/ui/popover-layout';

describe('popover placement above a session bar', () => {
  it.each([
    [1024, 700], [1280, 700], [1440, 700],
    [1024, 900], [1280, 900], [1440, 900],
  ])('keeps a tall Steps popover above the bar at %ipx by %ipx', (width, height) => {
    const barTop = height - 86;
    const anchor: PopoverRect = { left: width / 2 - 48, top: barTop + 8, right: width / 2 + 48, bottom: barTop + 44, width: 96, height: 36 };
    const bar: PopoverRect = { left: width / 2 - 250, top: barTop, right: width / 2 + 250, bottom: height - 12, width: 500, height: 74 };
    const placement = placePopover(anchor, { width: 720, height: 900 }, { width, height }, { top: 0, right: 0, bottom: 0, left: 0 }, 'top', bar);
    const panelBottom = placement.top + (placement.maxHeight ?? 900);

    expect(placement.maxHeight).toBeLessThanOrEqual(bar.top - 18);
    expect(panelBottom).toBeLessThanOrEqual(bar.top - 10);
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.left + 720).toBeLessThanOrEqual(width - 8);
  });
});
