import { describe, expect, it } from 'vitest';
import { wrap } from '../src/text';

describe('wrap emoji graphemes', () => {
  it('keeps families, flags, skin tones and keycaps intact in an overlong word', () => {
    const word = '👨‍👩‍👧🇸🇪👍🏽1️⃣';
    const clusters = Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(word), ({ segment }) => segment);
    const lines = wrap(word, '400 16px sans-serif', 4);

    expect(lines.join('')).toBe(word);
    expect(lines.every((line) => clusters.includes(line))).toBe(true);
  });
});
