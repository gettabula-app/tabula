import { describe, expect, it } from 'vitest';
import { THEMES, THEME_VARS, applyTheme, contrast, themeById, type ThemeRoot, type ThemeVar } from '../src/themes';

const TEXT_PAIRS: [ThemeVar, ThemeVar][] = [
  ['--ink', '--canvas'],
  ['--canvas-ink', '--canvas'],
  ['--graphite', '--canvas'],
  ['--on-signal', '--signal'],
  ['--tray-text', '--tray'],
  ['--tray-muted', '--tray'],
  ['--ink', '--paper'],
  ['--graphite', '--paper'],
  ['--danger', '--paper'],
  ['--danger', '--canvas'],
  // Armed (confirm) buttons: danger text at rest, paper text on a danger fill when hovered.
  ['--paper', '--danger'],
];

function srgbMix(a: string, pct: number, b: string): string {
  const [pa, pb] = [pct / 100, 1 - pct / 100];
  const channels = [1, 3, 5].map((i) => {
    const [ca, cb] = [a, b].map((hex) => parseInt(hex.slice(i, i + 2), 16));
    return Math.round(ca * pa + cb * pb).toString(16).padStart(2, '0');
  });
  return `#${channels.join('').toUpperCase()}`;
}

function fakeRoot() {
  const values = new Map<string, string>();
  const removed: string[] = [];
  const root: ThemeRoot = {
    style: {
      setProperty: (k, v) => {
        values.set(k, v);
      },
      removeProperty: (k) => {
        removed.push(k);
        values.delete(k);
        return '';
      },
    },
    dataset: {},
  };
  return { root, values, removed };
}

describe('theme catalogue', () => {
  it('lists the five themes in order', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['default', 'ayu', 'kanagawa', 'matrix', 'evergreen']);
  });

  it('gives every theme a unique id', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defines every variable in every theme', () => {
    const missing = THEMES.flatMap((t) => THEME_VARS.filter((v) => typeof t.vars[v] !== 'string').map((v) => `${t.id} ${v}`));
    expect(missing).toEqual([]);
  });

  it('falls back to the default theme for unknown ids', () => {
    expect(themeById('nope').id).toBe('default');
  });
});

describe('contrast', () => {
  it('computes WCAG 2 contrast ratios', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1);
  });

  it('keeps text pairs at 4.5:1 or better in every theme', () => {
    const failing = THEMES.flatMap((t) =>
      TEXT_PAIRS.map(([fg, bg]) => ({ label: `${t.id} ${fg} on ${bg}`, ratio: contrast(t.vars[fg], t.vars[bg]) })),
    )
      .filter(({ ratio }) => !(ratio >= 4.5))
      .map(({ label, ratio }) => `${label} ${ratio.toFixed(2)}`);
    expect(failing).toEqual([]);
  });

  it('keeps the guide colour at 3:1 or better against the canvas and the paper in every theme', () => {
    const failing = THEMES.flatMap((t) =>
      (['--canvas', '--paper'] as const).map((bg) => ({ label: `${t.id} --guide on ${bg}`, ratio: contrast(t.vars['--guide'], t.vars[bg]) })),
    )
      .filter(({ ratio }) => !(ratio >= 3))
      .map(({ label, ratio }) => `${label} ${ratio.toFixed(2)}`);
    expect(failing).toEqual([]);
  });

  it('keeps paper text on ink at 4.5:1 or better in every theme', () => {
    const failing = THEMES.filter((t) => !(contrast(t.vars['--paper'], t.vars['--ink']) >= 4.5)).map((t) => t.id);
    expect(failing).toEqual([]);
  });

  it('keeps danger text on trays at 4.5:1 or better in every theme', () => {
    const failing = THEMES.flatMap((t) =>
      (['--tray', '--tray-2'] as const).map((bg) => ({
        label: `${t.id} danger mix on ${bg}`,
        ratio: contrast(srgbMix(t.vars['--danger'], 54, t.vars['--tray-text']), t.vars[bg]),
      })),
    )
      .filter(({ ratio }) => !(ratio >= 4.5))
      .map(({ label, ratio }) => `${label} ${ratio.toFixed(2)}`);
    expect(failing).toEqual([]);
  });
});

describe('applyTheme', () => {
  it('sets every variable, the theme id and the colour scheme for a dark theme', () => {
    const { root, values } = fakeRoot();
    applyTheme('matrix', root);
    const matrix = themeById('matrix');
    const mismatched = THEME_VARS.filter((v) => values.get(v) !== matrix.vars[v]);
    expect(mismatched).toEqual([]);
    expect(root.dataset.theme).toBe('matrix');
    expect(values.get('color-scheme')).toBe('dark');
  });

  it('removes every inline override when returning to the default theme', () => {
    const { root, removed } = fakeRoot();
    applyTheme('matrix', root);
    applyTheme('default', root);
    const notRemoved = THEME_VARS.filter((v) => !removed.includes(v));
    expect(notRemoved).toEqual([]);
    expect(root.dataset.theme).toBe('default');
  });
});
