import { describe, expect, it } from 'vitest';
import { FRAME_PRESETS, presetChoiceId, presetForChoice, presetFrameBox, presetFrameName, presetSize } from '../src/ui/frame-presets';

const byId = (id: string) => FRAME_PRESETS.find((p) => p.id === id)!;
const sizes = (group: string) => FRAME_PRESETS.filter((p) => p.group === group).map((p) => [p.label, p.w, p.h]);

describe('frame presets', () => {
  it('lists the paper and screen sizes asked for', () => {
    expect(sizes('paper')).toEqual([['A5', 559, 794], ['A4', 794, 1123], ['A3', 1123, 1587], ['US Letter', 816, 1056]]);
    expect(sizes('screen')).toEqual([
      ['Full HD', 1920, 1080], ['HD', 1280, 720], ['Square post', 1080, 1080], ['Story', 1080, 1920], ['Phone', 390, 844],
    ]);
  });

  it('gives every preset a unique id and a unique choice id that no other group choice uses', () => {
    expect(new Set(FRAME_PRESETS.map((p) => p.id)).size).toBe(FRAME_PRESETS.length);
    const choiceIds = FRAME_PRESETS.map(presetChoiceId);
    expect(new Set(choiceIds).size).toBe(FRAME_PRESETS.length);
    expect(choiceIds).not.toContain('frame');
    for (const preset of FRAME_PRESETS) expect(presetForChoice(presetChoiceId(preset))).toBe(preset);
    expect(presetForChoice('frame')).toBeUndefined();
  });

  it('turns paper for landscape and keeps screen sizes as listed', () => {
    expect(presetSize(byId('a4'), 'portrait')).toEqual({ w: 794, h: 1123 });
    expect(presetSize(byId('a4'), 'landscape')).toEqual({ w: 1123, h: 794 });
    expect(presetSize(byId('letter'), 'landscape')).toEqual({ w: 1056, h: 816 });
    expect(presetSize(byId('story'), 'landscape')).toEqual({ w: 1080, h: 1920 });
    expect(presetSize(byId('phone'), 'landscape')).toEqual({ w: 390, h: 844 });
  });

  it('names landscape paper after its orientation and leaves the rest alone', () => {
    expect(presetFrameName(byId('a4'), 'portrait')).toBe('A4');
    expect(presetFrameName(byId('a4'), 'landscape')).toBe('A4 landscape');
    expect(presetFrameName(byId('letter'), 'landscape')).toBe('US Letter landscape');
    expect(presetFrameName(byId('hd'), 'landscape')).toBe('HD');
  });

  it('centres a box on the world point it is given', () => {
    expect(presetFrameBox({ w: 794, h: 1123 }, { x: 1000, y: -200 })).toEqual({ x: 603, y: -761.5, w: 794, h: 1123 });
    const box = presetFrameBox({ w: 1920, h: 1080 }, { x: 0, y: 0 });
    expect(box).toEqual({ x: -960, y: -540, w: 1920, h: 1080 });
  });
});
