import { describe, expect, it } from 'vitest';
import { THEMES } from '../src/themes';
import { USER_COLORS } from '../src/palette';

// The chat's new colours in all five themes (docs/chat.md, Interface): the compact name lightened toward the tray text, the signal
// label and bar, the own bubble's tint, the mention row and the unread badge, against the tray. Text 4.5:1, accents 3:1.

type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const v = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgb;
};
/** CSS color-mix(in srgb, a p%, b): a straight mix of the encoded channels. */
const mix = (a: Rgb, p: number, b: Rgb): Rgb => a.map((c, i) => c * p + b[i] * (1 - p)) as Rgb;
const lum = ([r, g, b]: Rgb) => {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: Rgb, b: Rgb) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe.each(THEMES.map((t) => [t.name, t.vars] as const))('chat colours in %s', (_name, vars) => {
  const tray = hex(vars['--tray']);
  const text = hex(vars['--tray-text']);
  const signal = hex(vars['--signal']);

  it('keeps every person colour legible as a name in the compact dock (lightened 55% toward the tray text)', () => {
    const worst = Math.min(...USER_COLORS.map((colour) => ratio(mix(hex(colour), 0.55, text), tray)));
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the signal label and bar against the tray, and the unread badge text on the signal', () => {
    expect(ratio(signal, tray)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(vars['--on-signal']), signal)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps text readable on the own bubble tint and on the mention row', () => {
    expect(ratio(text, mix(signal, 0.14, tray))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(text, mix(signal, 0.14, tray))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(text, mix(signal, 0.24, tray))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the muted text and the time readable on the tray and on the hover tray', () => {
    expect(ratio(hex(vars['--tray-muted']), tray)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(vars['--tray-muted']), hex(vars['--tray-2']))).toBeGreaterThanOrEqual(4.5);
  });

  it('draws the reaction you gave with a signal border the tray shows at 3:1', () => {
    expect(ratio(signal, mix(signal, 0.14, tray))).toBeGreaterThanOrEqual(3);
  });
});
