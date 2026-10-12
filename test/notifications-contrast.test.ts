import { describe, expect, it } from 'vitest';
import { THEMES } from '../src/themes';

// The bell and panel's colours in all five themes (proto/designer-preview/notifications/SPEC.md): text 4.5:1, graphics 3:1.

type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const v = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgb;
};
const mix = (a: Rgb, p: number, b: Rgb): Rgb => a.map((c, i) => c * p + b[i] * (1 - p)) as Rgb;
const lum = ([r, g, b]: Rgb) => {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: Rgb, b: Rgb) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe.each(THEMES.map((t) => [t.name, t.vars] as const))('notification colours in %s', (_name, vars) => {
  const ink = hex(vars['--ink']);
  const paper = hex(vars['--paper']);
  const canvas = hex(vars['--canvas']);
  const tray = hex(vars['--tray']);
  const trayText = hex(vars['--tray-text']);
  const muted = hex(vars['--tray-muted']);
  const hover = mix(trayText, 0.08, tray); // --tray-hover is 8% of the tray text over the tray

  it('reads the count in the badge (paper on ink) and sets the badge off from the bar', () => {
    expect(ratio(paper, ink)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(ink, canvas)).toBeGreaterThanOrEqual(3);
  });

  it('shows the mention outline against the bar', () => {
    expect(ratio(hex(vars['--danger']), canvas)).toBeGreaterThanOrEqual(3);
  });

  it('shows the unread dot on the panel and on a hovered row', () => {
    const signal = hex(vars['--signal']);
    expect(ratio(signal, tray)).toBeGreaterThanOrEqual(3);
    expect(ratio(signal, hover)).toBeGreaterThanOrEqual(3);
  });

  it('reads muted text on the panel and on a hovered row, and the count chip', () => {
    expect(ratio(muted, tray)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(muted, hover)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tray, trayText)).toBeGreaterThanOrEqual(4.5);
  });
});
