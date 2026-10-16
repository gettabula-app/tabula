import { describe, expect, it } from 'vitest';
import { popoverOrigin } from '../src/ui/popover-origin';

// a 300 by 200 panel at (200, 80)
const pop = { left: 200, top: 80, width: 300, height: 200 };

describe('popoverOrigin', () => {
  it('puts the origin on the left edge, at the anchor centre height, when the anchor is left of the panel', () => {
    expect(popoverOrigin({ left: 0, top: 100, width: 40, height: 40 }, pop)).toBe('0px 40px');
  });

  it('puts the origin on the top edge, at the anchor centre across, when the anchor is above the panel', () => {
    expect(popoverOrigin({ left: 300, top: 0, width: 40, height: 40 }, pop)).toBe('120px 0px');
  });

  it('puts the origin on the anchor centre when the anchor overlaps the panel', () => {
    expect(popoverOrigin({ left: 240, top: 100, width: 40, height: 40 }, pop)).toBe('60px 40px');
  });

  it('clamps the origin to the panel box when the anchor is past its right and bottom edges', () => {
    expect(popoverOrigin({ left: 900, top: 900, width: 40, height: 40 }, pop)).toBe('300px 200px');
  });
});
