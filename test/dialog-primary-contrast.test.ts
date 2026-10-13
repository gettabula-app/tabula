import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES, contrast } from '../src/themes';

// A dialog's primary button is --tray-text filled with --tray as its label (src/styles.css, .modal .btn.primary): it must stand off the dialog surface (3:1) and keep a readable label (4.5:1) in every theme.
describe('dialog primary buttons', () => {
  it('are drawn from the dialog tokens, not --ink (dark on Evergreen\'s dark tray)', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.modal \.btn\.primary \{ border: 0; background: var\(--tray-text\); color: var\(--tray\); \}/);
    expect(css).toMatch(/\.popover \.btn\.primary \{ border: 0; background: var\(--tray-text\); color: var\(--tray\); \}/);
    expect(css).toMatch(/\.tray \.btn\.primary, \.drawer \.btn\.primary, \.side-tray \.btn\.primary, \.props \.btn\.primary,[\s\S]*?\.aibar \.btn\.primary, \.aibar-pop \.btn\.primary,[\s\S]*?\.toast \.btn\.primary, \.focus-card \.btn\.primary, \.mention-card \.btn\.primary \{\s*border: 0; background: var\(--tray-text\); color: var\(--tray\);\s*\}/);
    expect(css).toMatch(/\.btn\.primary \{ border: 0; background: var\(--ink\); color: var\(--paper\); \}/);
  });

  const surfaces = [
    ['modal', '--tray-text', '--tray', '--tray'],
    ['popover', '--tray-text', '--tray', '--tray'],
    ['drawer', '--tray-text', '--tray', '--tray'],
    ['side tray', '--tray-text', '--tray', '--tray'],
    ['properties panel', '--tray-text', '--tray', '--tray'],
    ['flow bar', '--tray-text', '--tray', '--tray'],
    ['chat dock', '--tray-text', '--tray', '--tray'],
    ['toast action', '--tray-text', '--tray', '--tray'],
    ['AI bar', '--tray-text', '--tray', '--tray'],
    ['poll card', '--tray-text', '--tray', '--tray'],
    ['home page', '--ink', '--paper', '--paper'],
    ['admin page', '--ink', '--paper', '--paper'],
    ['sign-in page', '--ink', '--paper', '--paper'],
    ['OAuth consent', '--ink', '--paper', '--paper'],
    ['tracker dialog', '--ink', '--paper', '--paper'],
    ['tracker picker', '--ink', '--paper', '--paper'],
    ['focus and mention cards', '--tray-text', '--tray', '--tray'],
  ] as const;

  it.each(THEMES.map((theme) => [theme.id, theme] as const))('%s: every primary fill stands off its surface and keeps readable text', (_id, theme) => {
    for (const [surface, fillKey, labelKey, surfaceKey] of surfaces) {
      const fill = theme.vars[fillKey];
      const label = theme.vars[labelKey];
      const background = theme.vars[surfaceKey];
      expect(contrast(fill, background), `${surface} fill`).toBeGreaterThanOrEqual(3);
      expect(contrast(fill, label), `${surface} label`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
