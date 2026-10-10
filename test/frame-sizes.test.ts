import { describe, expect, it } from 'vitest';
import { CUSTOM_SIZE, FRAME_MAX, FRAME_MIN, FRAME_PRESETS, presetFor } from '../src/ui/frame-sizes';

const size = (id: string) => FRAME_PRESETS.find((p) => p.id === id);

describe('frame size presets', () => {
  it('has the screen, tablet, phone, paper and square sizes asked for', () => {
    const by = (g: string) => FRAME_PRESETS.filter((p) => p.group === g).map((p) => `${p.w}x${p.h}`);
    expect(by('Screen')).toEqual(['1920x1080', '1440x900', '1280x800']);
    expect(by('Tablet')).toEqual(['1024x768', '768x1024']);
    expect(by('Phone')).toEqual(['390x844']);
    expect(by('Paper')).toEqual(['1123x1587', '1587x1123', '794x1123', '1123x794', '816x1056', '1056x816']);
    expect(by('Other')).toEqual(['1000x1000']);
  });

  it('keeps ids unique and every size inside the limits', () => {
    expect(new Set(FRAME_PRESETS.map((p) => p.id)).size).toBe(FRAME_PRESETS.length);
    for (const p of FRAME_PRESETS) {
      expect(p.w).toBeGreaterThanOrEqual(FRAME_MIN);
      expect(p.h).toBeLessThanOrEqual(FRAME_MAX);
    }
  });

  it('paper landscape is portrait turned, and A sizes keep the 1:√2 ratio', () => {
    for (const n of ['a3', 'a4', 'letter']) {
      const p = size(`${n}-portrait`)!, l = size(`${n}-landscape`)!;
      expect([l.w, l.h]).toEqual([p.h, p.w]);
    }
    const a4 = size('a4-portrait')!;
    expect(a4.h / a4.w).toBeCloseTo(Math.SQRT2, 2);
    expect(size('a3-portrait')!.w).toBe(size('a4-portrait')!.h);
  });
});

describe('presetFor', () => {
  it('finds a preset by size and reads custom otherwise', () => {
    expect(presetFor(794, 1123)).toBe('a4-portrait');
    expect(presetFor(1123, 794)).toBe('a4-landscape');
    expect(presetFor(1920, 1080)).toBe('screen-1920');
    expect(presetFor(960, 600)).toBe(CUSTOM_SIZE);
  });
});
