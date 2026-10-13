import { describe, expect, it } from 'vitest';
import { THEMES, type ThemeVar } from '../src/themes';

type Rgb = [number, number, number];

const hex = (value: string): Rgb => {
  const normalized = value.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as Rgb;
};

const luminance = ([r, g, b]: Rgb): number => {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const ratio = (foreground: string, background: string): number => {
  const [lighter, darker] = [luminance(hex(foreground)), luminance(hex(background))].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

describe('M default theme', () => {
  const theme = THEMES.find(({ id }) => id === 'default')!;

  // Johan's M ruling (13 Oct 2026) defines the new default paper palette and its contrast pairs.
  it('uses the specified M tokens without changing the light scheme', () => {
    const expected: Partial<Record<ThemeVar, string>> = {
      '--canvas': '#F7F6F3', '--paper': '#FFFFFF', '--ink': '#111111', '--graphite': '#65635F',
      '--rule': '#EAEAEA', '--signal': '#111111', '--on-signal': '#FFFFFF', '--wire': '#2A64D6',
      '--selection-handle-fill': '#FFFFFF', '--selection-handle-stroke': '#2A64D6', '--danger': '#D41E24',
      '--tray': '#FFFFFF', '--tray-2': '#F7F6F3', '--tray-line': 'rgba(17, 17, 17, 0.08)',
      '--tray-text': '#111111', '--tray-muted': '#65635F', '--tray-hover': 'rgba(17, 17, 17, 0.05)',
      '--grid-dot': '#D4D2CC', '--grid-line': '#ECEBE7', '--grid-major': '#DDDBD5',
      '--canvas-ink': '#111111', '--canvas-rule': '#D9D8D4', '--guide': '#D6247F', '--shade': '#000000',
    };

    expect(theme.scheme).toBe('light');
    expect(theme.vars).toMatchObject(expected);
  });

  it.each([
    ['--ink', '--canvas', 17.47],
    ['--ink', '--paper', 18.88],
    ['--graphite', '--canvas', 5.55],
    ['--graphite', '--paper', 5.99],
    ['--tray-muted', '--tray', 5.99],
    ['--danger', '--canvas', 4.85],
    ['--danger', '--paper', 5.24],
    ['--wire', '--canvas', 4.99],
    ['--wire', '--paper', 5.40],
    ['--on-signal', '--signal', 18.88],
  ] as const)('keeps %s on %s at the specified contrast', (foreground, background, expected) => {
    expect(ratio(theme.vars[foreground], theme.vars[background])).toBeCloseTo(expected, 1);
  });
});
