import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/text', async (orig) => {
  const real = await orig<typeof import('../src/text')>();
  return {
    ...real,
    measure: (text: string, font: string) => {
      calls.n++;
      return real.measure(text, font);
    },
  };
});

import { layoutInlineText, layoutMarkdown, MAX_TOKEN_CHARS, MEASURE_BUDGET } from '../src/markdown-layout';

const style = { font: 'system', size: 16, weight: 400 };
const texts = (items: ReturnType<typeof layoutMarkdown>['items']) => items.filter((i): i is Extract<typeof i, { k: 'text' }> => i.k === 'text');

// no wall-clock timing: the cost of a layout is counted in text measurements, which a quadratic wrap would blow far past
describe('hostile Markdown layout', () => {
  beforeEach(() => {
    calls.n = 0;
  });

  it.each([8000, 20000])('wraps an unbroken %i-character word in a bounded number of measurements and cuts it at the token cap', (n) => {
    const l = layoutMarkdown('x'.repeat(n), 300, style);
    expect(calls.n).toBeLessThan(1200);
    const shown = texts(l.items).map((t) => t.s).join('');
    expect(shown.length).toBe(MAX_TOKEN_CHARS);
    expect(shown.endsWith('…')).toBe(true);
  });

  it.each([8000, 20000])('wraps a %i-character code line in a bounded number of measurements and cuts it', (n) => {
    const l = layoutMarkdown(`\`\`\`\n${'x'.repeat(n)}\n\`\`\``, 300, style);
    expect(calls.n).toBeLessThan(1200);
    const shown = texts(l.items).map((t) => t.s).join('');
    expect(shown.length).toBe(MAX_TOKEN_CHARS);
  });

  it('wraps an unbroken inline code span the same way', () => {
    layoutMarkdown(`\`${'y'.repeat(20000)}\``, 300, style);
    expect(calls.n).toBeLessThan(1200);
  });

  it('keeps a table cell word bounded', () => {
    layoutInlineText('z'.repeat(20000), 120, style);
    expect(calls.n).toBeLessThan(3000);
  });

  it('stops measuring at the budget on a text of many words and still lays everything out', () => {
    const l = layoutMarkdown('ab '.repeat(30000), 300, style);
    expect(calls.n).toBeLessThanOrEqual(MEASURE_BUDGET);
    expect(l.height).toBeGreaterThan(10000);
  });

  it('keeps ordinary text exact', () => {
    const l = layoutMarkdown('hello world', 400, style);
    expect(texts(l.items).map((t) => t.s)).toEqual(['hello', 'world']);
  });
});
