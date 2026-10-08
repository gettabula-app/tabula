// Board colour palettes and per-type style defaults.

export const INK = '#18212B';
export const GRAPHITE = '#5B6672';
export const RULE = '#C9D1DA';
export const PAPER = '#FFFFFF';
export const WIRE = '#2F6FED';
export const SIGNAL = '#FFD23F';
/** Ink for anything drawn on the canvas: follows runtime themes, falls back to INK. */
export const CANVAS_INK = 'var(--canvas-ink, #18212B)';

export const STICKY_COLORS = [
  { name: 'Yellow', fill: '#FFE16B' },
  { name: 'Orange', fill: '#FFB979' },
  { name: 'Pink', fill: '#FFA3C4' },
  { name: 'Violet', fill: '#CDB8FF' },
  { name: 'Blue', fill: '#A3D2FF' },
  { name: 'Teal', fill: '#8FE3CA' },
  { name: 'Green', fill: '#BCE88C' },
  { name: 'Grey', fill: '#E2E6EB' },
];

export const FILLS = [
  { name: 'White', value: '#FFFFFF' },
  { name: 'Mist', value: '#EEF1F4' },
  { name: 'Sky', value: '#DCEBFF' },
  { name: 'Mint', value: '#DDF5E8' },
  { name: 'Butter', value: '#FFF2C2' },
  { name: 'Peach', value: '#FFE2D6' },
  { name: 'Lilac', value: '#ECE4FF' },
  { name: 'Ink', value: INK },
  { name: 'None', value: 'none' },
];

export const STROKES = [
  { name: 'Ink', value: INK },
  { name: 'Graphite', value: GRAPHITE },
  { name: 'Blue', value: '#2F6FED' },
  { name: 'Green', value: '#1E9A6A' },
  { name: 'Amber', value: '#C98A00' },
  { name: 'Red', value: '#D64545' },
  { name: 'Violet', value: '#7A5AF8' },
  { name: 'None', value: 'none' },
];

export const TEXT_COLORS = [INK, GRAPHITE, '#FFFFFF', '#2F6FED', '#1E9A6A', '#C98A00', '#D64545', '#7A5AF8'];

export const USER_COLORS = ['#2F6FED', '#D64545', '#1E9A6A', '#C98A00', '#7A5AF8', '#E0559B', '#0E9AA7', '#E06D2B'];

// ---------------------------------------------------------------- colour maths

/** `#RGB` or `#RRGGBB` to [r, g, b] (0–255), or null for anything else. */
export function parseHex(c: string | undefined): [number, number, number] | null {
  if (!c) return null;
  const m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export const toHex = (rgb: [number, number, number]) =>
  '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

export const normalizeHex = (c: string) => {
  const rgb = parseHex(c);
  return rgb ? toHex(rgb) : c;
};

/** Mix two colours; t = 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a), y = parseHex(b);
  if (!x || !y) return a;
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as [number, number, number]);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(c: string): number {
  const rgb = parseHex(c);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const STICKY_INK = '#1D1A12';

/** Dark ink on light notes, white on dark ones, whichever reads better. */
export function inkOn(fill: string): string {
  const L = luminance(fill);
  const onWhite = 1.05 / (L + 0.05);
  const onInk = (L + 0.05) / (luminance(STICKY_INK) + 0.05);
  return onWhite > onInk ? '#FFFFFF' : STICKY_INK;
}
