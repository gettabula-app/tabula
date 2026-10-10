import { describe, expect, it } from 'vitest';
import { placeBesideAnchor } from '../src/ui/popover-place';

const safe = { top: 0, right: 0, bottom: 0, left: 0 };
const view = { width: 360, height: 740 };

describe('a popover that must not cover its anchor', () => {
  it('goes below the anchor when it fits', () => {
    const at = placeBesideAnchor({ left: 100, top: 100, right: 156, bottom: 156 }, { width: 220, height: 300 }, view, safe);
    expect(at.top).toBe(164);
    expect(at.maxHeight).toBeGreaterThanOrEqual(300);
  });

  it('goes to the roomier side and is shortened when neither side fits (a tall menu on a small phone)', () => {
    // the finger at y=390: 306 px below, 346 px above
    const anchor = { left: 182, top: 362, right: 238, bottom: 418 };
    const at = placeBesideAnchor(anchor, { width: 220, height: 426 }, view, safe);
    expect(at.maxHeight).toBeLessThan(426);
    expect(at.top + Math.min(426, at.maxHeight)).toBeLessThanOrEqual(anchor.top - 8);
    expect(at.top).toBeGreaterThanOrEqual(8);
  });

  it('keeps clear of the safe insets and the side edges', () => {
    const at = placeBesideAnchor({ left: 330, top: 100, right: 358, bottom: 128 }, { width: 220, height: 200 }, view, { top: 47, right: 10, bottom: 34, left: 10 });
    expect(at.left + 220).toBeLessThanOrEqual(360 - 10 - 8);
  });
});
