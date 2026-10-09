import { cleanColor } from '../shared/colors';

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

/**
 * The eight person colours (cursors, avatars, comment pins, remote selections, AI run outlines). Each is dark enough
 * for white text (>= 4.5:1) and light enough to read as a 3:1 outline on every theme's canvas (test/person-colors.test.ts).
 * That leaves a narrow band of luminance (about 0.155 to 0.18), so the hues carry the difference, not the lightness.
 */
export const USER_COLORS = ['#326DD3', '#D3332D', '#1B8151', '#A06A00', '#7B58DB', '#CE2C7D', '#1C7C85', '#B9501C'];

/** Text on a person colour: always white. */
export const PERSON_INK = '#FFFFFF';

/** The person colours before TAB-197, in the same order as USER_COLORS. Stored profiles and comments still carry them. */
const LEGACY_USER_COLORS = ['#2F6FED', '#D64545', '#1E9A6A', '#C98A00', '#7A5AF8', '#E0559B', '#0E9AA7', '#E06D2B'];

/**
 * The person colour to draw for a stored or remote one. A current colour is kept, an old one maps to its replacement, and
 * any other hex (an API client, an older build) takes the nearest of the eight. Not a colour at all gives the first.
 * Every place that draws a person colour goes through this, so nobody keeps a colour that fails contrast.
 */
export function personColor(c: unknown): string {
  // a remote person's colour arrives in awareness state, which the other client controls: it may not even be a string
  const rgb = parseHex(typeof c === 'string' ? c : undefined);
  if (!rgb) return USER_COLORS[0];
  const hex = toHex(rgb);
  if (USER_COLORS.includes(hex)) return hex;
  const legacy = LEGACY_USER_COLORS.indexOf(hex);
  if (legacy >= 0) return USER_COLORS[legacy];
  let best = USER_COLORS[0], bd = Infinity;
  for (const u of USER_COLORS) {
    const v = parseHex(u)!;
    const d = (v[0] - rgb[0]) ** 2 + (v[1] - rgb[1]) ** 2 + (v[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = u; }
  }
  return best;
}

/** The board's custom sticky colours that are plain #RRGGBB, canonical and without repeats. */
export function customStickyColors(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    const c = cleanColor(v);
    if (c && /^#[0-9A-F]{6}$/.test(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- colour maths

/** `#RGB` or `#RRGGBB` to [r, g, b] (0–255), or null for anything else. */
export function parseHex(c: string | undefined): [number, number, number] | null {
  if (!c || typeof c !== 'string') return null;
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

/**
 * A plain-language name for a colour, for the accessible name of a swatch ("Blue", "Dark grey") where the swatch has no
 * name of its own. Sticky note and board colours use their own names; everything else is named by hue, saturation and lightness.
 */
export function colorName(value: string): string {
  if (value === CANVAS_INK) return 'Ink';
  const rgb = parseHex(value);
  if (!rgb) return value;
  const hex = normalizeHex(value);
  const sticky = STICKY_COLORS.find((c) => normalizeHex(c.fill) === hex);
  if (sticky) return sticky.name;
  if (hex === normalizeHex(INK)) return 'Ink';
  if (hex === normalizeHex(GRAPHITE)) return 'Graphite';
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l > 0.96) return 'White';
  if (l < 0.1) return 'Black';
  if (s < 0.14) return l < 0.35 ? 'Dark grey' : l > 0.75 ? 'Light grey' : 'Grey';
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const hue = h < 15 || h >= 345 ? 'Red' : h < 40 ? (h >= 35 && l < 0.45 ? 'Amber' : 'Orange') : h < 65 ? (l < 0.45 ? 'Amber' : 'Yellow') : h < 165 ? 'Green' : h < 200 ? 'Teal' : h < 245 ? 'Blue' : h < 290 ? 'Violet' : 'Pink';
  return l < 0.3 ? `Dark ${hue.toLowerCase()}` : l > 0.75 ? `Light ${hue.toLowerCase()}` : hue;
}
