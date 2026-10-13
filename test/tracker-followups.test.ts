import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES, contrast } from '../src/themes';

function mix(fg: string, pct: number, bg: string): string {
  const c = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [f, b] = [c(fg), c(bg)];
  return `#${f.map((v, i) => Math.round(v * pct / 100 + b[i] * (100 - pct) / 100).toString(16).padStart(2, '0')).join('')}`;
}

const css = readFileSync(new URL('../src/tracker/ui/tracker.css', import.meta.url), 'utf8');

describe('tracker field placeholders', () => {
  it('declare the placeholder as the text colour at 72% over the ground', () => {
    expect(css).toContain('.trk .trk-filter-input::placeholder { color: color-mix(in srgb, var(--trk-text) 72%, var(--trk-ground)); opacity: 1; }');
  });

  it.each(THEMES.map((theme) => [theme.id, theme] as const))('%s: the placeholder reads at 4.5:1 on the field tint', (_id, theme) => {
    const ground = theme.vars['--paper'];
    const field = mix(theme.vars['--ink'], 4, ground);
    const placeholder = mix(theme.vars['--ink'], 72, ground);
    expect(contrast(placeholder, field)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the new-issue + on a phone', () => {
  it('is hidden while a ticket page is open, where it would cover the composer\'s Send arrow', () => {
    expect(css).toMatch(/\.trk:has\(\.tk-page\) \.trk-new-trigger, \.trk-shell:has\(\.tk-page\) \.trk-new-trigger \{ display: none; \}/);
  });
});

describe('Escape in the tracker filter field', () => {
  it('is left to the field while it holds text, so the first Escape clears it and the next one leaves', () => {
    const shell = readFileSync(new URL('../src/tracker/ui/shell.ts', import.meta.url), 'utf8');
    expect(shell).toMatch(/event\.key === 'Escape' && target instanceof HTMLInputElement && target\.classList\.contains\('trk-filter-input'\) && target\.value && !filterController\?\.suggestionsOpen\(\)\) return;/);
  });
});
