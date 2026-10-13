import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES, contrast } from '../src/themes';

// A dialog's primary button is --tray-text filled with --tray as its label (src/styles.css, .modal .btn.primary): it must stand off the dialog surface (3:1) and keep a readable label (4.5:1) in every theme.
describe('dialog primary buttons', () => {
  it('are drawn from the dialog tokens, not --ink (dark on Evergreen\'s dark tray)', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.modal \.btn\.primary \{ border: 0; background: var\(--tray-text\); color: var\(--tray\); \}/);
  });

  it.each(THEMES.map((theme) => [theme.id, theme] as const))('%s: the fill reads against the dialog (3:1) and its label is readable (4.5:1)', (_id, theme) => {
    expect(contrast(theme.vars['--tray-text'], theme.vars['--tray'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.vars['--tray-text'], theme.vars['--tray'])).toBeGreaterThanOrEqual(3);
  });
});
