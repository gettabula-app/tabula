import { describe, expect, it } from 'vitest';
import { CODE_THEMES, SHIKI_THEME_IDS, themeTokenColours } from '../src/code-themes';
import { MIN_CODE_CONTRAST, clampCodeColour, contrastRgb, parseHexColour, rgbDistance } from '../src/code-contrast';
import { THEME_LOADERS } from '../src/code-tokenize';

const load = async (id: string) => ((await THEME_LOADERS[id]()).default as Parameters<typeof themeTokenColours>[0]);
const rgb = (hex: string, surface: string) => parseHexColour(hex, parseHexColour(surface)!)!;
const ratio = (hex: string, surface: string) => contrastRgb(rgb(hex, surface), parseHexColour(surface)!);

describe('code theme map', () => {
  it('maps every app theme to a shipped Shiki theme and uses the app surface and ink', () => {
    expect(Object.fromEntries(CODE_THEMES.map((t) => [t.id, t.shiki]))).toEqual({
      default: 'github-light', ayu: 'ayu-dark', kanagawa: 'kanagawa-wave', matrix: 'vitesse-black', evergreen: 'github-light',
    });
    expect([...SHIKI_THEME_IDS].sort()).toEqual(Object.keys(THEME_LOADERS).sort());
    expect(CODE_THEMES.find((t) => t.id === 'matrix')).toMatchObject({ surface: '#0B140C', ink: '#3DFF70' });
  });
});

describe('clampCodeColour', () => {
  it('leaves a colour that already passes exactly as it was', () => {
    expect(clampCodeColour('#24292e', '#FFFFFF', '#111111')).toBe('#24292e');
    expect(clampCodeColour('#DCD7BA', '#2A2A37', '#DCD7BA')).toBe('#DCD7BA');
    expect(clampCodeColour('#000000FF', '#FFFFFF', '#111111')).toBe('#000000FF');
  });

  it('lifts a dim colour toward the ink until it reaches 4.5:1, and never past the ink', () => {
    const out = clampCodeColour('#aaaaaa', '#FFFFFF', '#111111')!;
    expect(out).not.toBe('#aaaaaa');
    expect(ratio(out, '#FFFFFF')).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST);
    expect(parseHexColour(out)![0]).toBeLessThan(0xaa);
    expect(clampCodeColour('#333344', '#2A2A37', '#DCD7BA')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('gives the plain ink (null) for missing or non-hex colours, and composites alpha over the surface', () => {
    expect(clampCodeColour(undefined, '#FFFFFF', '#111111')).toBeNull();
    expect(clampCodeColour('red', '#FFFFFF', '#111111')).toBeNull();
    expect(clampCodeColour('var(--x)', '#FFFFFF', '#111111')).toBeNull();
    const faint = clampCodeColour('#00000020', '#FFFFFF', '#111111')!;
    expect(ratio(faint, '#FFFFFF')).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST);
  });
});

describe.each(CODE_THEMES.map((t) => [t.id, t] as const))('code colours on the %s theme', (_id, theme) => {
  it('every token colour of its Shiki theme reaches 4.5:1 on the surface after the clamp, and passing ones are unchanged', async () => {
    const colours = themeTokenColours(await load(theme.shiki)).filter((c) => parseHexColour(c));
    expect(colours.length).toBeGreaterThan(5);
    const problems: string[] = [];
    for (const colour of colours) {
      const out = clampCodeColour(colour, theme.surface, theme.ink);
      if (out === null) problems.push(`${colour}: null`);
      else if (ratio(out, theme.surface) < MIN_CODE_CONTRAST) problems.push(`${colour} -> ${out}: ${ratio(out, theme.surface).toFixed(2)}`);
      else if (ratio(colour, theme.surface) >= MIN_CODE_CONTRAST && out !== colour) problems.push(`${colour} changed to ${out}`);
    }
    expect(problems).toEqual([]);
  });

  it('keeps token classes tellable apart (informational: reports how many colours were lifted and how many collapse)', async () => {
    const raw = [...new Set(themeTokenColours(await load(theme.shiki)).filter((c) => parseHexColour(c)).map((c) => `#${rgb(c, theme.surface).map((v) => v.toString(16).padStart(2, '0')).join('')}`))];
    const after = raw.map((c) => clampCodeColour(c, theme.surface, theme.ink)!);
    const lifted = raw.filter((c, i) => after[i] !== c);
    const distinct = [...new Set(after)];
    // Lifted colours that sit within 12 RGB units of a different colour of the same theme: classes that now look alike.
    const collapsed = lifted.filter((c) => {
      const out = clampCodeColour(c, theme.surface, theme.ink)!;
      return distinct.some((d) => d !== out && rgbDistance(d, out) <= 12);
    });
    console.info(`[code-theme] ${theme.id}/${theme.shiki}: ${raw.length} distinct colours, ${lifted.length} lifted, ${distinct.length} distinct after, ${collapsed.length} lifted ones within 12 RGB units of another`);
    expect(distinct.length).toBeGreaterThanOrEqual(6);
  });
});
