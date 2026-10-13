import { describe, expect, it } from 'vitest';
import { layoutMarkdown, MD_PAD, markdownHeight, type MdItem } from '../src/markdown-layout';

// In node there is no canvas, so text.ts measures every character as 0.55 of the font size: the widths below are exact multiples of that.

const style = { font: 'system', size: 16, weight: 400 };
const lay = (src: string, w = 400) => layoutMarkdown(src, w, style);
const texts = (items: MdItem[]) => items.filter((i): i is Extract<MdItem, { k: 'text' }> => i.k === 'text');
const lines = (items: MdItem[]) => [...new Set(texts(items).map((t) => Math.round(t.y)))].sort((a, b) => a - b);

describe('layoutMarkdown', () => {
  it('lays a paragraph out in lines that fit the width, from the padding down, and grows with the text', () => {
    const short = lay('hello world');
    expect(texts(short.items).map((t) => t.s)).toEqual(['hello', 'world']);
    expect(texts(short.items)[0].x).toBe(MD_PAD);
    const long = lay('word '.repeat(60));
    expect(lines(long.items).length).toBeGreaterThan(3);
    for (const t of texts(long.items)) expect(t.x + t.s.length * 16 * 0.55).toBeLessThanOrEqual(400 - MD_PAD + 0.5);
    expect(long.height).toBeGreaterThan(short.height);
  });

  it('is narrower text taller text: height grows as the width shrinks', () => {
    const src = 'the quick brown fox jumps over the lazy dog '.repeat(5);
    expect(markdownHeight(src, 150, style)).toBeGreaterThan(markdownHeight(src, 600, style));
  });

  it('breaks a word wider than the column by character instead of overflowing', () => {
    const l = lay('x'.repeat(200), 200);
    expect(lines(l.items).length).toBeGreaterThan(1);
    for (const t of texts(l.items)) expect(t.x + t.s.length * 16 * 0.55).toBeLessThanOrEqual(200 - MD_PAD + 0.5);
  });

  it('draws a heading larger and bold, bold text bold and emphasis italic', () => {
    const l = lay('# Big\n\nplain **strong** *soft*');
    const t = texts(l.items);
    expect(t.find((x) => x.s === 'Big')).toMatchObject({ weight: 700, size: 16 * 1.9 });
    expect(t.find((x) => x.s === 'strong')).toMatchObject({ weight: 700, italic: false });
    expect(t.find((x) => x.s === 'soft')).toMatchObject({ italic: true, weight: 400 });
    expect(t.find((x) => x.s === 'plain')).toMatchObject({ weight: 400, size: 16 });
  });

  it('puts a tinted box behind inline code and a block of code, and draws code in the monospace face', () => {
    const l = lay('use `a+b` here\n\n```\nlet a = 1;\n```');
    expect(l.items.filter((i) => i.k === 'rect' && i.tone === 'code').length).toBe(2);
    expect(texts(l.items).filter((t) => t.mono).map((t) => t.s)).toEqual(['a+b', 'let a = 1;']);
  });

  it('draws bullets, numbers and task boxes, with a hit area on each task that names its source line', () => {
    const l = lay('- one\n- [ ] open\n- [x] done\n\n1. first\n2. second');
    const t = texts(l.items);
    expect(t.filter((x) => x.s === '•').length).toBe(1);
    expect(t.filter((x) => /^\d\.$/.test(x.s)).map((x) => x.s)).toEqual(['1.', '2.']);
    const checks = l.items.filter((i) => i.k === 'check') as Extract<MdItem, { k: 'check' }>[];
    expect(checks.map((c) => c.done)).toEqual([false, true]);
    expect((l.items.filter((i) => i.k === 'hit' && i.task !== undefined) as Extract<MdItem, { k: 'hit' }>[]).map((h) => h.task)).toEqual([1, 2]);
    expect(t.find((x) => x.s === 'done')!.dim).toBe(true); // a done task is quieter
    expect(t.find((x) => x.s === 'open')!.dim).toBe(false);
  });

  it('indents nested items and quotes, and draws the quote bar', () => {
    const l = lay('- a\n  - b\n\n> quoted');
    const t = texts(l.items);
    expect(t.find((x) => x.s === 'b')!.x).toBeGreaterThan(t.find((x) => x.s === 'a')!.x);
    expect(t.find((x) => x.s === 'quoted')!.dim).toBe(true);
    expect(l.items.some((i) => i.k === 'rect' && i.tone === 'quote')).toBe(true);
  });

  it('underlines a link and puts a hit area over it with its address; a dropped link has neither', () => {
    const l = lay('see [the page](https://example.com/p) and [bad](javascript:alert(1)) and [item](#obj:abc)');
    const hits = l.items.filter((i) => i.k === 'hit' && i.link) as Extract<MdItem, { k: 'hit' }>[];
    // "the", the space inside the link, "page" and "item"; nothing for "bad"
    expect(hits.map((h) => h.link)).toEqual([{ href: 'https://example.com/p', kind: 'web' }, { href: 'https://example.com/p', kind: 'web' }, { href: 'https://example.com/p', kind: 'web' }, { href: '#obj:abc', kind: 'obj' }]);
    expect(l.items.filter((i) => i.k === 'line' && i.tone === 'link').length).toBe(4);
    expect(texts(l.items).some((t) => t.s === 'bad')).toBe(true);
  });

  it('strikes through deleted text and draws rules', () => {
    const l = lay('~~gone~~\n\n---');
    expect(l.items.some((i) => i.k === 'line' && i.tone === 'strike')).toBe(true);
    expect(l.items.some((i) => i.k === 'line' && i.tone === 'rule')).toBe(true);
  });

  it('draws a table as a grid of equal columns with a heavier line under the header and the cells aligned as asked', () => {
    const l = lay('| a | b |\n|:--|--:|\n| 1 | 22 |');
    const ls = l.items.filter((i) => i.k === 'line') as Extract<MdItem, { k: 'line' }>[];
    expect(ls.filter((x) => x.x1 === x.x2).length).toBe(3); // three vertical lines for two columns
    expect(ls.some((x) => x.tone === 'rule')).toBe(true);
    const t = texts(l.items);
    const colW = (400 - MD_PAD * 2) / 2;
    expect(t.find((x) => x.s === 'b')!.x).toBeGreaterThan(MD_PAD + colW); // second column
    expect(t.find((x) => x.s === '22')!.x + 2 * 16 * 0.55).toBeCloseTo(MD_PAD + colW * 2 - 16 * 0.45, 0); // right aligned
  });

  it('shows a picture of the asset store as a placeholder box with its alt text, and never fetches anything', () => {
    const l = lay(`![a cat](asset:${'b'.repeat(64)})`);
    expect(l.items.filter((i) => i.k === 'picture')).toEqual([expect.objectContaining({ alt: 'a cat' })]);
  });

  it('keeps every item inside the box and every number finite, for anything', () => {
    const sources = ['', '#', '> '.repeat(40) + 'x', '- a\n'.repeat(80), `| a | b |\n| - | - |\n${'| 1 | 2 |\n'.repeat(50)}`, '*'.repeat(500), '[x](https://example.com)'.repeat(40), 'ä'.repeat(300)];
    for (const src of sources) {
      const l = lay(src, 260);
      expect(Number.isFinite(l.height) && l.height > 0).toBe(true);
      const numbers = l.items.flatMap((i) => Object.values(i).filter((v): v is number => typeof v === 'number'));
      expect(numbers.every(Number.isFinite)).toBe(true);
      expect(texts(l.items).every((t) => t.x + t.s.length * t.size * 0.55 * 0.99 <= 260 + 1)).toBe(true);
    }
  });
});
