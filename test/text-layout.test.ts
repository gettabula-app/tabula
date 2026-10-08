import { describe, expect, it } from 'vitest';
import { curlSize, labelBox, layoutText, objectMarkup, styleOf } from '../src/markup';
import { SHAPE_KINDS, textBox } from '../src/shapes';
import type { BaseObj } from '../src/types';

const shape = (extra: Partial<BaseObj> = {}): BaseObj => ({
  id: 'a', type: 'shape', kind: 'rect', x: 0, y: 0, w: 200, h: 100, rotation: 0, z: 'a0', text: 'Hi', ...extra,
});
const sticky = (extra: Partial<BaseObj> = {}): BaseObj => ({
  id: 's', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', text: 'Hi', ...extra,
});
const textObj = (extra: Partial<BaseObj> = {}): BaseObj => ({
  id: 't', type: 'text', x: 0, y: 0, w: 100, h: 20, rotation: 0, z: 'a0', text: 'Hi', ...extra,
});
const none = { get: () => undefined };
const firstTspanY = (svg: string) => Number(svg.match(/<tspan[^>]* y="([-\d.]+)"/)?.[1]);

describe('layoutText', () => {
  const s = styleOf(shape());
  const box = { x: 0, y: 0, w: 200, h: 100 };

  it('places text at the top, middle or bottom of the box', () => {
    const top = layoutText('Hi', box, s, { valign: 'top' });
    const middle = layoutText('Hi', box, s, { valign: 'middle' });
    const bottom = layoutText('Hi', box, s, { valign: 'bottom' });
    expect(top.top).toBe(0);
    expect(middle.top).toBe((100 - middle.height) / 2);
    expect(bottom.top).toBe(100 - bottom.height);
  });

  it('centres vertically when no valign is given', () => {
    expect(layoutText('Hi', box, s).top).toBe(layoutText('Hi', box, s, { valign: 'middle' }).top);
  });

  it('shrinks long text to fit when shrink is set', () => {
    const words = Array.from({ length: 60 }, () => 'word').join(' ');
    const lay = layoutText(words, { x: 0, y: 0, w: 80, h: 40 }, s, { shrink: true });
    expect(lay.size).toBeLessThan(s.fontSize);
  });
});

describe('valign defaults', () => {
  it('centres shapes and stickies and tops text objects', () => {
    expect(styleOf(shape()).valign).toBe('middle');
    expect(styleOf(sticky()).valign).toBe('middle');
    expect(styleOf(textObj()).valign).toBe('top');
  });

  it('lets an object set its own valign', () => {
    expect(styleOf(shape({ valign: 'bottom' })).valign).toBe('bottom');
  });
});

describe('labelBox', () => {
  it('insets a sticky by its folded corner', () => {
    const box = labelBox(sticky());
    expect(box.h).toBeLessThan(192 - 28);
    expect(box.h).toBe(192 - 28 - curlSize(192, 192) * 0.35);
  });

  it('uses the shape text box for shapes', () => {
    expect(labelBox(shape({ kind: 'ellipse' }))).toEqual(textBox('ellipse', 200, 100));
  });

  it('keeps a small sticky label box at least 1 px in each direction', () => {
    const box = labelBox(sticky({ w: 20, h: 20 }));
    expect(box.w).toBeGreaterThanOrEqual(1);
    expect(box.h).toBeGreaterThanOrEqual(1);
  });
});

describe('textBox at small sizes', () => {
  it.each([[12, 12], [20, 30], [30, 20]])('keeps every kind at least 1 px in each direction at %dx%d', (w, h) => {
    for (const { kind } of SHAPE_KINDS) {
      const box = textBox(kind, w, h);
      expect(`${kind} ${box.w >= 1 && box.h >= 1}`).toBe(`${kind} true`);
    }
  });
});

describe('valign in markup', () => {
  it('draws the first line higher for top than for bottom', () => {
    const top = objectMarkup(shape({ valign: 'top' }), none);
    const bottom = objectMarkup(shape({ valign: 'bottom' }), none);
    expect(firstTspanY(top)).toBeLessThan(firstTspanY(bottom));
  });

  it('keeps centred shape text unchanged when no valign is set', () => {
    const svg = objectMarkup(shape(), none);
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('<tspan');
  });
});
