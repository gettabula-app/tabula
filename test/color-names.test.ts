import { describe, expect, it } from 'vitest';
import { CANVAS_INK, GRAPHITE, INK, STICKY_COLORS, TEXT_COLORS, USER_COLORS, colorName } from '../src/palette';

// docs/accessibility-audit.md, S3: swatches are named by colour, not by hex.

describe('colorName()', () => {
  it('uses the sticky note names', () => {
    for (const c of STICKY_COLORS) expect(colorName(c.fill)).toBe(c.name);
  });

  it('names ink, graphite and the canvas ink', () => {
    expect(colorName(INK)).toBe('Ink');
    expect(colorName(CANVAS_INK)).toBe('Ink');
    expect(colorName(GRAPHITE)).toBe('Graphite');
    expect(colorName('#FFFFFF')).toBe('White');
  });

  it('names the text colours and the person colours with a word, never a hex code', () => {
    for (const c of [...TEXT_COLORS, ...USER_COLORS]) expect(`${c} ${colorName(c)}`).toMatch(/^#\w+ [A-Z][a-z]+( [a-z]+)?$/);
  });

  it('names the hues people expect', () => {
    expect(colorName('#2F6FED')).toBe('Blue');
    expect(colorName('#D64545')).toBe('Red');
    expect(colorName('#1E9A6A')).toBe('Green');
    expect(colorName('#7A5AF8')).toBe('Violet');
    expect(colorName('#000000')).toBe('Black');
    expect(colorName('#808080')).toBe('Grey');
  });

  it('gives person colours different names', () => {
    expect(new Set(USER_COLORS.map(colorName)).size).toBe(USER_COLORS.length);
  });

  it('returns a value it cannot read as it is', () => {
    expect(colorName('none')).toBe('none');
  });
});
