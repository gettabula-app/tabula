import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_PRESETS, frameOrientation, presetChoiceId, presetForChoice, presetFrameBox, presetFrameName, presetSize, rememberFrameOrientation,
} from '../src/ui/frame-presets';

const byId = (id: string) => FRAME_PRESETS.find((p) => p.id === id)!;
const rows = (group: string) => FRAME_PRESETS.filter((p) => p.group === group).map((p) => [p.label, p.w, p.h]);

/** An in-memory localStorage, so the orientation can be remembered across calls. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
  };
}

describe('frame presets', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); rememberFrameOrientation('portrait'); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('lists the paper, screen and social sizes asked for, in order', () => {
    expect(FRAME_PRESETS.map((p) => p.label)).toEqual(['A5', 'A4', 'A3', 'US Letter', 'Full HD', 'HD', 'Tablet', 'Phone', 'Square post', 'Story']);
    expect(rows('paper')).toEqual([['A5', 559, 794], ['A4', 794, 1123], ['A3', 1123, 1587], ['US Letter', 816, 1056]]);
    expect(rows('screen')).toEqual([['Full HD', 1920, 1080], ['HD', 1280, 720], ['Tablet', 1024, 768], ['Phone', 390, 844]]);
    expect(rows('social')).toEqual([['Square post', 1080, 1080], ['Story', 1080, 1920]]);
  });

  it('drops the old inspector-only sizes', () => {
    const sizes = FRAME_PRESETS.map((p) => `${p.w}x${p.h}`);
    expect(sizes).not.toContain('1440x900');
    expect(sizes).not.toContain('1280x800');
  });

  it('gives every preset a unique id and a unique choice id that no other group choice uses', () => {
    expect(new Set(FRAME_PRESETS.map((p) => p.id)).size).toBe(FRAME_PRESETS.length);
    const choiceIds = FRAME_PRESETS.map(presetChoiceId);
    expect(new Set(choiceIds).size).toBe(FRAME_PRESETS.length);
    expect(choiceIds).not.toContain('frame');
    for (const preset of FRAME_PRESETS) expect(presetForChoice(presetChoiceId(preset))).toBe(preset);
    expect(presetForChoice('frame')).toBeUndefined();
  });

  it('shows every row in its natural orientation under Portrait', () => {
    expect(presetSize(byId('a4'), 'portrait')).toEqual({ w: 794, h: 1123 });
    expect(presetSize(byId('full-hd'), 'portrait')).toEqual({ w: 1920, h: 1080 });
    expect(presetSize(byId('tablet'), 'portrait')).toEqual({ w: 1024, h: 768 });
    expect(presetSize(byId('phone'), 'portrait')).toEqual({ w: 390, h: 844 });
    expect(presetSize(byId('story'), 'portrait')).toEqual({ w: 1080, h: 1920 });
  });

  it('swaps w and h for every non-square row under Landscape, and leaves the square alone', () => {
    expect(presetSize(byId('a4'), 'landscape')).toEqual({ w: 1123, h: 794 });
    expect(presetSize(byId('letter'), 'landscape')).toEqual({ w: 1056, h: 816 });
    expect(presetSize(byId('full-hd'), 'landscape')).toEqual({ w: 1080, h: 1920 });
    expect(presetSize(byId('phone'), 'landscape')).toEqual({ w: 844, h: 390 });
    expect(presetSize(byId('story'), 'landscape')).toEqual({ w: 1920, h: 1080 });
    expect(presetSize(byId('square-post'), 'landscape')).toEqual({ w: 1080, h: 1080 });
    expect(presetSize(byId('square-post'), 'portrait')).toEqual({ w: 1080, h: 1080 });
  });

  it('names a turned row by its shape and leaves the natural one alone', () => {
    expect(presetFrameName(byId('a4'), 'portrait')).toBe('A4');
    expect(presetFrameName(byId('a4'), 'landscape')).toBe('A4 landscape');
    expect(presetFrameName(byId('full-hd'), 'portrait')).toBe('Full HD');
    expect(presetFrameName(byId('full-hd'), 'landscape')).toBe('Full HD portrait');
    expect(presetFrameName(byId('square-post'), 'landscape')).toBe('Square post');
  });

  it('centres a box on the world point it is given', () => {
    expect(presetFrameBox({ w: 794, h: 1123 }, { x: 1000, y: -200 })).toEqual({ x: 603, y: -761.5, w: 794, h: 1123 });
    expect(presetFrameBox({ w: 1920, h: 1080 }, { x: 0, y: 0 })).toEqual({ x: -960, y: -540, w: 1920, h: 1080 });
  });

  it('flips w and h with the toggle and remembers the choice for the person', () => {
    expect(frameOrientation()).toBe('portrait');
    rememberFrameOrientation('landscape');
    expect(frameOrientation()).toBe('landscape');
    expect(presetSize(byId('a4'), frameOrientation())).toEqual({ w: 1123, h: 794 });
    // a new page load reads the same remembered choice from storage
    expect(localStorage.getItem('tabula.frame.orientation')).toBe('landscape');
    rememberFrameOrientation('portrait');
    expect(frameOrientation()).toBe('portrait');
  });

  it('keeps the choice for the session when storage is missing or refuses to work', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    expect(() => rememberFrameOrientation('landscape')).not.toThrow();
    expect(frameOrientation()).toBe('landscape');
    vi.stubGlobal('localStorage', undefined);
    expect(frameOrientation()).toBe('landscape');
    rememberFrameOrientation('portrait');
  });

  it('ignores a stored value that is not an orientation', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'tabula.frame.orientation': 'sideways' }));
    expect(frameOrientation()).toBe('portrait');
  });
});
