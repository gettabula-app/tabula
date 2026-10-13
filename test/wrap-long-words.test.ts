import { describe, expect, it } from 'vitest';
import { measure, wrap } from '../src/text';

// In node there is no canvas, so measure() is 0.55 of the font size per character (src/text.ts): widths here are exact multiples of that.
const FONT = '400 20px system-ui';
const W = (n: number) => measure('x'.repeat(n), FONT);

/** The wrap before the change, kept as the reference: it broke an over-wide word by character only when the word started a line. */
function wrapBefore(text: string, font: string, maxWidth: number): string[] {
  const out: string[] = [];
  const max = Math.max(4, maxWidth);
  for (const para of text.split('\n')) {
    if (!para) { out.push(''); continue; }
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (measure(candidate.trimEnd(), font) <= max || !line.trim()) {
        if (measure(word, font) > max && !line.trim()) {
          let chunk = '';
          for (const ch of Array.from(word)) {
            if (measure(chunk + ch, font) > max && chunk) { out.push(chunk); chunk = ch; } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        out.push(line.trimEnd());
        line = /^\s+$/.test(word) ? '' : word;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

describe('wrap', () => {
  it('wraps texts with no word wider than the box exactly as before (random strings)', () => {
    const rand = rng(7);
    const alphabet = 'abcdefghij klmnop qrstuv wxyz\n ,.-ÅÄö';
    let checked = 0;
    for (let i = 0; i < 800; i++) {
      const len = 1 + Math.floor(rand() * 120);
      let s = '';
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
      const max = W(6 + Math.floor(rand() * 30));
      if (s.split(/\s+/).some((w) => measure(w, FONT) > max)) continue; // only plain texts are compared
      expect(wrap(s, FONT, max)).toEqual(wrapBefore(s, FONT, max));
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('breaks a word wider than the box by character even when it comes after other words', () => {
    const max = W(10);
    const lines = wrap('see supercalifragilisticexpialidocious now', FONT, max);
    expect(lines.every((l) => measure(l, FONT) <= max + 1e-9)).toBe(true);
    expect(lines.join('').replace(/ /g, '')).toBe('seesupercalifragilisticexpialidociousnow'); // nothing lost
    expect(lines[0]).toBe('see');
    // before the change the long word was one line wider than the box
    expect(wrapBefore('see supercalifragilisticexpialidocious now', FONT, max).some((l) => measure(l, FONT) > max)).toBe(true);
  });

  it('still starts a long word on its own lines at the start of a line, and keeps what follows it', () => {
    const max = W(8);
    expect(wrap('abcdefghijklmnopq tail', FONT, max)).toEqual(wrapBefore('abcdefghijklmnopq tail', FONT, max));
  });
});
