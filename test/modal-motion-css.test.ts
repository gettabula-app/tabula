import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dialog entrance motion, read as text (a unit test cannot run the animation): the scrim fades in, the centred dialog eases in
// from a slight scale, a phone bottom sheet slides up on the drawer curve, and reduced motion keeps only a short fade.

const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const cardDialog = fs.readFileSync(new URL('../src/ui/card-dialog.css', import.meta.url), 'utf8');
const templatePicker = fs.readFileSync(new URL('../src/ui/template-picker.css', import.meta.url), 'utf8');

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The declarations of the rule whose selector is `selector`, at the start of a line (indentation allowed). */
const rule = (css: string, selector: string) => css.match(new RegExp(`\\n[ \\t]*${escape(selector)} \\{([^}]*)\\}`))?.[1] ?? '';
/** Every @keyframes block in a stylesheet. */
const keyframesIn = (css: string) => [...css.matchAll(/@keyframes [\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g)].map(([block]) => block);
const keyframeLine = (css: string, name: string) => css.split('\n').find((line) => line.startsWith(`@keyframes ${name} `)) ?? '';

describe('dialog entrance motion', () => {
  it('defines the keyframes for the scrim, the centred dialog and the phone sheet', () => {
    expect(styles).toMatch(/@keyframes modal-back-in\s*\{/);
    expect(styles).toMatch(/@keyframes modal-in\s*\{/);
    expect(styles).toMatch(/@keyframes modal-sheet-in\s*\{/);
  });

  it('fades the scrim in and eases the dialog in with var(--ease-out), without scaling from zero', () => {
    expect(rule(styles, '.modal-back')).toMatch(/animation:\s*modal-back-in\s+160ms\s+var\(--ease-out\)/);
    expect(rule(styles, '.modal')).toMatch(/animation:\s*modal-in\s+200ms\s+var\(--ease-out\)/);
    expect(keyframeLine(styles, 'modal-in')).toContain('scale(0.96)');
    for (const block of [...keyframesIn(styles), ...keyframesIn(cardDialog)]) expect(block).not.toMatch(/scale\(0\)/);
  });

  it('slides a phone bottom sheet up with translateY(100%) on var(--ease-drawer), inside the 860px query', () => {
    const phone = cardDialog.slice(cardDialog.indexOf('@media (max-width: 860px) {'), cardDialog.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(phone).toMatch(/\.k-card-dialog \.modal \{[^}]*animation:\s*modal-sheet-in 280ms var\(--ease-drawer\)/);
    expect(keyframeLine(styles, 'modal-sheet-in')).toContain('translateY(100%)');
    expect(templatePicker).toMatch(/@media \(max-width: 480px\) and \(prefers-reduced-motion: no-preference\) \{\s*\.template-picker-dialog \{ animation: modal-sheet-in 280ms var\(--ease-drawer\) both; \}/);
  });

  it('removes transform under reduced motion and keeps only a 120 ms fade for the scrim and the dialog', () => {
    const shared = styles.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.modal-back, \.modal \{([^}]*)\}/)?.[1] ?? '';
    expect(shared).toMatch(/animation:\s*modal-back-in 120ms var\(--ease-out\)/);
    expect(shared).toMatch(/transform:\s*none/);
    const sheet = cardDialog.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.k-card-dialog \.modal \{([^}]*)\}/)?.[1] ?? '';
    expect(sheet).toMatch(/animation:\s*modal-back-in 120ms var\(--ease-out\)/);
    expect(sheet).toMatch(/transform:\s*none/);
  });
});
