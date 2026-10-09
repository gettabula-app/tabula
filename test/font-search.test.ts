import { describe, expect, it } from 'vitest';
import { searchFonts, type FontEntry } from '../src/fonts';

const font = (name: string, category = 'Other', tags: string[] = []): FontEntry => ({
  name,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  category,
  weights: [400],
  italic: false,
  variable: false,
  tags,
});

describe('searchFonts', () => {
  it('ranks an exact family name ahead of name and category matches', () => {
    const fonts = [font('Serif Sans Pro'), font('Typeface', 'Serif'), font('Serif', 'Display')];
    expect(searchFonts('serif', fonts).map((f) => f.name)).toEqual(['Serif', 'Serif Sans Pro', 'Typeface']);
  });

  it('matches names without regard to case or diacritics', () => {
    const fonts = [font('Café Rêve'), font('Cafe Noir')];
    expect(searchFonts('CAFE REVE', fonts).map((f) => f.name)).toEqual(['Café Rêve']);
  });

  it('matches categories, style tags, and common style aliases', () => {
    const fonts = [
      font('Plain', 'Sans'),
      font('Tabular', 'Sans', ['Code']),
      font('Comico', 'Handwritten'),
      font('Clash', 'Display'),
      font('Bubble', 'Other', ['Rounded']),
      font('Angle', 'Other', ['Geometric']),
      font('Gambetta', 'Serif'),
    ];

    expect(searchFonts('sans serif', fonts).map((f) => f.name)).toContain('Plain');
    expect(searchFonts('mono', fonts).map((f) => f.name)).toContain('Tabular');
    expect(searchFonts('typewriter', fonts).map((f) => f.name)).toContain('Tabular');
    expect(searchFonts('handwriting', fonts).map((f) => f.name)).toContain('Comico');
    expect(searchFonts('script', fonts).map((f) => f.name)).toContain('Comico');
    expect(searchFonts('display', fonts).map((f) => f.name)).toContain('Clash');
    expect(searchFonts('rounded', fonts).map((f) => f.name)).toContain('Bubble');
    expect(searchFonts('geometric', fonts).map((f) => f.name)).toContain('Angle');
    expect(searchFonts('serif', fonts).map((f) => f.name)).toContain('Gambetta');
  });

  it('returns no results for an empty or unmatched query', () => {
    const fonts = [font('Satoshi', 'Sans')];
    expect(searchFonts('   ', fonts)).toEqual([]);
    expect(searchFonts('vintage slab', fonts)).toEqual([]);
  });
});
