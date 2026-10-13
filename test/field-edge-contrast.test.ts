import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES, contrast } from '../src/themes';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../src/ui/controls.css', import.meta.url), 'utf8');
const sharedRulePercent = Number(styles.match(/--field-rule:\s*color-mix\(in srgb, var\(--tray-text\)\s*(\d+)%, var\(--tray\)\);/)?.[1]);
const evergreenRule = styles.match(/:root\[data-theme='evergreen'\]\s*\{([^}]*)\}/)?.[1] ?? '';
const evergreenRulePercent = Number(evergreenRule.match(/--field-rule:\s*color-mix\(in srgb, var\(--tray-text\)\s*(\d+)%, var\(--tray\)\);/)?.[1]);

function srgbMix(foreground: string, percentage: number, background: string): string {
  const channels = [1, 3, 5].map((offset) => {
    const fg = Number.parseInt(foreground.slice(offset, offset + 2), 16);
    const bg = Number.parseInt(background.slice(offset, offset + 2), 16);
    return Math.round(fg * percentage / 100 + bg * (1 - percentage / 100)).toString(16).padStart(2, '0');
  });
  return `#${channels.join('').toUpperCase()}`;
}

describe.each(THEMES)('resting field cue in $name', (theme) => {
  const percentage = theme.id === 'evergreen' ? evergreenRulePercent : sharedRulePercent;
  const cue = srgbMix(theme.vars['--tray-text'], percentage, theme.vars['--tray']);
  const fill = srgbMix(theme.vars['--tray-text'], 6, theme.vars['--tray']);
  const segmentedFill = srgbMix(theme.vars['--tray-text'], 5, theme.vars['--tray']);

  it.each(['--tray', '--paper', '--canvas'] as const)('contrasts with the field fill and %s by at least 3:1', (surface) => {
    expect(contrast(cue, fill)).toBeGreaterThanOrEqual(3);
    expect(contrast(cue, theme.vars[surface])).toBeGreaterThanOrEqual(3);
  });

  it.each(['--tray', '--paper', '--canvas'] as const)('contrasts with the segmented track fill and %s by at least 3:1', (surface) => {
    expect(contrast(cue, segmentedFill)).toBeGreaterThanOrEqual(3);
    expect(contrast(cue, theme.vars[surface])).toBeGreaterThanOrEqual(3);
  });
});

describe('shared field edge styles', () => {
  it('keeps the fill and references the resting bottom rule for shared fields', () => {
    expect(sharedRulePercent).toBe(58);
    expect(evergreenRulePercent).toBe(50);
    expect(styles).toMatch(/--field-rule:\s*color-mix\(in srgb, var\(--tray-text\) 58%, var\(--tray\)\);/);
    expect(evergreenRule).toMatch(/--field-rule:\s*color-mix\(in srgb, var\(--tray-text\) 50%, var\(--tray\)\);/);
    expect(styles).toMatch(/\.input,\s*select,\s*textarea:not\(\.text-editor\),\s*\.combo\s*\{[^}]*background-color:[^}]*box-shadow:[^}]*inset 0 -1px 0 var\(--field-rule\)/);
    expect(controls).toMatch(/\.combo\s*\{[^}]*box-shadow:[^}]*inset 0 -1px 0 var\(--field-rule\)/);
  });

  it('keeps strong edges on checkboxes, radios, switches, and the selected segmented thumb', () => {
    expect(styles).toMatch(/--field-edge-strong:\s*color-mix\(in srgb, var\(--tray-text\) 58%, var\(--tray\)\);/);
    expect(evergreenRule).toMatch(/--field-edge-strong:\s*color-mix\(in srgb, var\(--tray-text\) 50%, var\(--tray\)\);/);
    expect(styles).toMatch(/input\[type='checkbox'\],\s*input\[type='radio'\],\s*input\[role='switch'\],\s*\[role='switch'\]\s*\{\s*border:\s*1px solid var\(--field-edge-strong\);\s*\}/);
    expect(styles).toMatch(/\.segmented\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--field-edge\),\s*inset 0 -1px 0 var\(--field-rule\)/);
    expect(styles).toMatch(/\.segmented button\.on\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--field-edge-strong\)/);
  });
});
