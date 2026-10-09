import { describe, expect, it } from 'vitest';
import { cleanColor, isSafeColor, safeColor } from '../shared/colors';

// TAB-203: stored colours reach `fill="…"` and `style="color:…"`. Anything outside the colour grammar must come back
// as the fallback, never as itself.
const HOSTILE = [
  'red;filter:url(//evil.example/x)',
  '#fff;background:url(https://evil.example/a.png)',
  'url(#x)',
  'url(https://evil.example/x)',
  'expression(alert(1))',
  '#FFF" onload="alert(1)',
  "#FFF' onmouseover='alert(1)",
  '#FFF"/><script>alert(1)</script>',
  '</style><script>alert(1)</script>',
  'var(--x, url(//evil))',
  'var(--x);background:url(//evil)',
  'var(--x, #FFFFFF);filter:url(//evil)',
  'rgb(1,2,3)',
  'rgba(0,0,0,.5)',
  'hsl(10 20% 30%)',
  'red',
  'currentColor',
  'inherit',
  '#GGGGGG',
  '#12345',
  '#1234567',
  '# FFF',
  '\u0000#FFF',
  '',
  '   ',
  '#'.padEnd(80, 'F'),
];

describe('safe colours', () => {
  it('accepts hex and returns it in upper case, expanding #rgb', () => {
    expect(cleanColor('#ffe16b')).toBe('#FFE16B');
    expect(cleanColor('#abc')).toBe('#AABBCC');
    expect(cleanColor('#11223344')).toBe('#11223344');
    expect(cleanColor('  #2F6FED ')).toBe('#2F6FED');
    // surrounding whitespace is dropped; the result is the clean colour, never the input
    expect(cleanColor('#fff\n')).toBe('#FFFFFF');
  });

  it('accepts none, transparent and a theme variable with a hex fallback', () => {
    expect(cleanColor('none')).toBe('none');
    expect(cleanColor('NONE')).toBe('none');
    expect(cleanColor('transparent')).toBe('transparent');
    expect(cleanColor('var(--canvas-ink, #18212b)')).toBe('var(--canvas-ink, #18212B)');
  });

  it.each(HOSTILE)('refuses %j', (value) => {
    expect(cleanColor(value)).toBeNull();
    expect(isSafeColor(value)).toBe(false);
    expect(safeColor(value, '#18212B')).toBe('#18212B');
  });

  it('refuses what is not a string', () => {
    for (const v of [null, undefined, 0, 1, true, {}, [], ['#FFF'], { toString: () => '#FFF' }]) {
      expect(cleanColor(v)).toBeNull();
      expect(safeColor(v, 'none')).toBe('none');
    }
  });

  it('returns null with no fallback, and refuses a fallback that is not safe itself', () => {
    expect(safeColor('red;x', null)).toBeNull();
    expect(safeColor('red;x')).toBeNull();
    expect(() => safeColor('red;x', 'red;filter:url(//evil)')).toThrow(TypeError);
  });

  it('never lets a character through that can end an attribute, a declaration or a tag', () => {
    const outputs = [...HOSTILE, '#abc', 'none', 'var(--canvas-ink, #18212B)'].map((v) => safeColor(v, '#000000'));
    for (const out of outputs) expect(out).not.toMatch(/[;"'<>\\]|url\(|expression/i);
  });
});
