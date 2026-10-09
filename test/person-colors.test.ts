import { describe, it, expect } from 'vitest';
import { USER_COLORS, PERSON_INK, personColor, luminance } from '../src/palette';
import { THEMES } from '../src/themes';

const ratio = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const OLD = ['#2F6FED', '#D64545', '#1E9A6A', '#C98A00', '#7A5AF8', '#E0559B', '#0E9AA7', '#E06D2B'];

describe('person colours', () => {
  it('has eight distinct colours', () => {
    expect(USER_COLORS).toHaveLength(8);
    expect(new Set(USER_COLORS).size).toBe(8);
  });

  it.each(USER_COLORS)('%s: white text on the fill is at least 4.5:1', (c) => {
    expect(ratio(c, PERSON_INK)).toBeGreaterThanOrEqual(4.5);
  });

  it('is an outline of at least 3:1 on every theme canvas', () => {
    const canvases = THEMES.map((t) => t.vars['--canvas']);
    expect(canvases.length).toBeGreaterThanOrEqual(5);
    for (const c of USER_COLORS) for (const bg of canvases) expect(ratio(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it('maps every old colour to its replacement and keeps current ones', () => {
    OLD.forEach((o, i) => {
      expect(personColor(o)).toBe(USER_COLORS[i]);
      expect(personColor(o.toLowerCase())).toBe(USER_COLORS[i]);
    });
    for (const c of USER_COLORS) expect(personColor(c)).toBe(c);
  });

  it('maps any other hex to a current colour and survives junk', () => {
    expect(USER_COLORS).toContain(personColor('#FF0000'));
    expect(personColor('#00F')).toBe(personColor('#0000FF'));
    expect(personColor('red')).toBe(USER_COLORS[0]);
    expect(personColor(undefined)).toBe(USER_COLORS[0]);
    expect(personColor(null)).toBe(USER_COLORS[0]);
  });
});
