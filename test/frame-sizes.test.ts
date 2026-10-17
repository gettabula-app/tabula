import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUSTOM_SIZE, FRAME_MAX, FRAME_MIN, FRAME_PRESETS, presetFor } from '../src/ui/frame-sizes';
import * as framePresets from '../src/ui/frame-presets';

describe('the inspector and the Frame menu read one list', () => {
  it('re-exports the same list the Frame menu uses', () => {
    expect(FRAME_PRESETS).toBe(framePresets.FRAME_PRESETS);
  });

  it('keeps ids unique and every size inside the limits', () => {
    expect(new Set(FRAME_PRESETS.map((p) => p.id)).size).toBe(FRAME_PRESETS.length);
    for (const p of FRAME_PRESETS) {
      expect(Math.min(p.w, p.h)).toBeGreaterThanOrEqual(FRAME_MIN);
      expect(Math.max(p.w, p.h)).toBeLessThanOrEqual(FRAME_MAX);
    }
  });

  it('keeps the A sizes at the 1:√2 ratio', () => {
    for (const id of ['a5', 'a4', 'a3']) {
      const p = FRAME_PRESETS.find((x) => x.id === id)!;
      // whole pixels at 96 dpi (A5 559 x 794 is 1.4204): within 1 %
      expect(Math.abs(p.h / p.w / Math.SQRT2 - 1)).toBeLessThan(0.01);
    }
  });
});

describe('presetFor', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('finds the preset in either orientation and reads custom otherwise', () => {
    expect(presetFor(794, 1123)).toBe('a4');
    expect(presetFor(1123, 794)).toBe('a4');
    expect(presetFor(1920, 1080)).toBe('full-hd');
    expect(presetFor(1080, 1920)).toBe('story');
    expect(presetFor(1080, 1080)).toBe('square-post');
    expect(presetFor(960, 600)).toBe(CUSTOM_SIZE);
    expect(presetFor(1440, 900)).toBe(CUSTOM_SIZE);
    expect(presetFor(1280, 800)).toBe(CUSTOM_SIZE);
  });

  it('shows a preset name for a frame the toggle turned', () => {
    vi.stubGlobal('localStorage', undefined);
    framePresets.rememberFrameOrientation('landscape');
    const turned = framePresets.presetSize(FRAME_PRESETS.find((p) => p.id === 'phone')!, 'landscape');
    expect(presetFor(turned.w, turned.h)).toBe('phone');
    framePresets.rememberFrameOrientation('portrait');
  });
});
