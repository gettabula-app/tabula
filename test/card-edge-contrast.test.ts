import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES, contrast } from '../src/themes';

// the card edge is --ink at 22% over the card surface (src/ui/home.css, --card-edge); it must stand off the page ground in every theme
function mix(fg: string, pct: number, bg: string): string {
  const c = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [f, b] = [c(fg), c(bg)];
  return `#${f.map((v, i) => Math.round(v * pct / 100 + b[i] * (100 - pct) / 100).toString(16).padStart(2, '0')).join('')}`;
}

describe('template and board cards', () => {
  const css = readFileSync(new URL('../src/ui/home.css', import.meta.url), 'utf8');

  it('declare the edge as ink 22% over the card surface', () => {
    expect(css).toContain('--card-edge: color-mix(in srgb, var(--ink) 22%, var(--paper))');
  });

  it.each(THEMES.map((theme) => [theme.id, theme] as const))('%s: the card edge reads against the page ground (1.3:1) and the card surface is a step off it', (_id, theme) => {
    const edge = mix(theme.vars['--ink'], 22, theme.vars['--paper']);
    expect(contrast(edge, theme.vars['--canvas'])).toBeGreaterThanOrEqual(1.3);
    expect(contrast(theme.vars['--paper'], theme.vars['--canvas'])).toBeGreaterThanOrEqual(1.05);
  });

  it('frame the thumbnail on the card instead of letting it run to the edges', () => {
    expect(css).toMatch(/\.tpl-card \.tpl-thumb \{ width: 100%; margin: 0 0 8px; border: 1px solid var\(--page-hairline\)/);
  });
});

describe('the empty Boards state', () => {
  it('sets its heading in the page ink, not a colour it inherits (it read 1.9:1 in Evergreen)', () => {
    const css = readFileSync(new URL('../src/ui/home.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.home-empty-state h2 \{[^}]*color: var\(--ink\)/);
  });
});
