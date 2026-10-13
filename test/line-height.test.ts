import { describe, expect, it } from 'vitest';
import { layoutText, objectMarkup, styleOf, textHeight } from '../src/markup';
import { layoutMarkdown } from '../src/markdown-layout';
import { fitText } from '../src/text';
import type { BaseObj } from '../src/types';

const textObj = (extra: Partial<BaseObj> = {}): BaseObj => ({
  id: 't', type: 'text', x: 0, y: 0, w: 400, h: 100, rotation: 0, z: 'a0', text: 'first\nsecond', fontSize: 20, ...extra,
});

describe('line height', () => {
  it('keeps the existing 1.3 layout and text height when lineHeight is absent', () => {
    const without = textObj();
    const withDefault = textObj({ lineHeight: 1.3 });
    const box = { x: 0, y: 0, w: 400, h: 100 };
    expect(styleOf(without).lineHeight).toBe(1.3);
    expect(layoutText(without.text!, box, styleOf(without), { valign: 'top' }))
      .toEqual(layoutText(withDefault.text!, box, styleOf(withDefault), { valign: 'top' }));
    expect(textHeight(without)).toBe(52);
    expect(textHeight(without)).toBe(textHeight(withDefault));
    expect(fitText(without.text!, without.font, 400, 20, 400, 100))
      .toEqual(fitText(without.text!, without.font, 400, 20, 400, 100, 9, 1.3));
  });

  it('uses the selected ratio for wrapped layout, fitted text and text-object height', () => {
    const box = { x: 0, y: 0, w: 400, h: 100 };
    const two = textObj({ lineHeight: 2 });
    const one = textObj({ lineHeight: 1 });
    const layoutTwo = layoutText(two.text!, box, styleOf(two), { valign: 'top' });
    const layoutOne = layoutText(one.text!, box, styleOf(one), { valign: 'top' });
    expect([layoutTwo.lines.length, layoutTwo.lineHeight, layoutTwo.height]).toEqual([2, 40, 80]);
    expect([layoutOne.lines.length, layoutOne.lineHeight, layoutOne.height]).toEqual([2, 20, 40]);
    expect(textHeight(two)).toBe(80);
    expect(textHeight(one)).toBe(40);
    expect(fitText(two.text!, two.font, 400, 20, 400, 100, 9, 2)).toMatchObject({ lines: ['first', 'second'], size: 20, lineHeight: 40, height: 80 });
    expect(fitText(one.text!, one.font, 400, 20, 400, 100, 9, 1)).toMatchObject({ lines: ['first', 'second'], size: 20, lineHeight: 20, height: 40 });
  });

  it('reads the stored ratio without clamping and places SVG tspans at its line step', () => {
    expect(styleOf(textObj({ lineHeight: 3.5 })).lineHeight).toBe(3.5);
    const svg = objectMarkup(textObj({ lineHeight: 2 }), { get: () => undefined });
    const ys = [...svg.matchAll(/<tspan[^>]* y="([\d.-]+)"/g)].map((match) => Number(match[1]));
    expect(ys).toHaveLength(2);
    expect(ys[1] - ys[0]).toBe(40);
  });

  it('keeps Markdown at 1.45 by default and scales paragraph and heading line steps', () => {
    const markdown = textObj({ type: 'markdown' });
    expect(styleOf(markdown).lineHeight).toBe(1.45);
    const base = { font: 'satoshi', size: 10, weight: 400 };
    const source = 'one two three';
    expect(layoutMarkdown(source, 30, base)).toEqual(layoutMarkdown(source, 30, { ...base, lineHeight: 1.45 }));

    const paragraph = layoutMarkdown(source, 30, { ...base, lineHeight: 2 });
    const paragraphYs = [...new Set(paragraph.items.filter((item) => item.k === 'text').map((item) => item.y))];
    expect(paragraphYs[1] - paragraphYs[0]).toBe(20);

    const heading = layoutMarkdown('# one two', 20, { ...base, lineHeight: 2 });
    const headingYs = [...new Set(heading.items.filter((item) => item.k === 'text').map((item) => item.y))];
    expect(headingYs[1] - headingYs[0]).toBeCloseTo(10 * 1.9 * 2);
  });
});
