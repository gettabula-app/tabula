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

// ---------------------------------------------------------------- the picture family
// The real picture of a board (src/template-thumb.ts) and the schematic tile in the tint style (src/ui/board-preview.ts) draw from
// the numbers and colour rules here, so a board's card looks like one family whichever picture it shows.

/** The theme's paper and ink, with our fallbacks: a theme that does not set them still draws. */
export const PAPER_VAR = 'var(--paper, #FFFFFF)';
export const INK_VAR = 'var(--ink, #18212B)';

/** The Grey sticky colour: what a sticky or a shape with no usable colour is drawn in. */
export const STICKY_GREY = '#E2E6EB';

/**
 * The numbers of the picture family. A frame's tint is a fixed lightness and a capped saturation per hue, not a percentage of its colour
 * over paper: a pale template tint (#E6F7EF) at 16% over white is almost white, and a pale colour's HSL saturation is near 100%, so
 * without the cap a lilac frame comes out violet. Every coloured frame is brought to the same soft tint and its edge to the same
 * darker one. The hue is kept, so a mint frame still reads as mint.
 */
export const PICTURE = {
  /** A frame, lane or container in its own colour: its hue at this lightness (0 to 1) and at most this saturation. */
  tintLightness: 0.93,
  tintSaturation: 0.55,
  /** Its 1px edge: the same hue, darker, and a little less saturated so it reads as an edge and not a stroke of colour. */
  edgeLightness: 0.64,
  edgeSaturation: 0.45,
  /** Grey bars that stand in for text: ink strength in percent; height as a fraction of the picture's unit, at most this fraction of the box. */
  barInkPct: 38,
  barUnit: 0.01,
  barMaxH: 0.08,
  /** The corner radius of every box, as a fraction of the picture's unit (its larger side). */
  radiusUnit: 0.008,
} as const;

/** The corner radius of a box in a picture whose unit is `unit`. */
export const radiusOf = (unit: number): number => unit * PICTURE.radiusUnit;

const inkAt = (pct: number) => `color-mix(in srgb, ${INK_VAR} ${pct}%, transparent)`;
/** The grey of a grey bar: ink at a strength over nothing. */
export const BAR_INK = inkAt(PICTURE.barInkPct);
/** The 1px outline of a card or a shape, and the edge of a frame with no colour. */
export const OUTLINE_INK = inkAt(28);

/** Rows of grey bars: [top, width] as fractions of the box's height and width, and the left inset as a fraction of its width. */
export interface BarSpec { rows: readonly (readonly [number, number])[]; inset: number }
/** The bars each kind of box shows when it has text (or always, for a sticky, a card or a markdown block). */
export const BARS: Record<'sticky' | 'text' | 'card' | 'block' | 'shape', BarSpec> = {
  sticky: { rows: [[0.38, 0.64], [0.56, 0.44]], inset: 0.18 },
  text: { rows: [[0.2, 0.8], [0.4, 0.6]], inset: 0.04 },
  card: { rows: [[0.2, 0.8], [0.4, 0.6]], inset: 0.1 },
  block: { rows: [[0.12, 0.9], [0.32, 0.8], [0.52, 0.86], [0.72, 0.55]], inset: 0.06 },
  shape: { rows: [[0.42, 0.6]], inset: 0.2 },
};

/** The bars of one box, as rects: the same rows, weight and rounding in both pictures. Nothing when a bar would not show. */
export function barRects(x: number, y: number, w: number, h: number, unit: number, spec: BarSpec): { x: number; y: number; w: number; h: number; rx: number }[] {
  const bh = Math.min(unit * PICTURE.barUnit, h * PICTURE.barMaxH);
  if (!(bh > 0)) return [];
  return spec.rows.map(([top, width]) => ({ x: x + w * spec.inset, y: y + h * top, w: w * width, h: bh, rx: bh / 2 }));
}

const HEX6 = /^#[0-9a-fA-F]{6}$/u;

/**
 * A colour a board carries, as the picture may draw it: a plain #RRGGBB (as it is) or a sticky colour name (`blue`, as kanban lanes
 * store it) as that palette colour. Anything else is undefined. Only our own constants or a checked hex come back, never the input.
 */
export function resolveColour(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (HEX6.test(raw)) return raw;
  const want = raw.trim().toLowerCase();
  return STICKY_COLORS.find((c) => c.name.toLowerCase() === want)?.fill;
}

/** #RRGGBB to [hue in degrees, saturation 0 to 1, lightness 0 to 1]. */
export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hue * 60 + 360) % 360, s, l];
}

/** Hue in degrees, saturation and lightness (0 to 1) to #RRGGBB. */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector: [number, number, number] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex(sector.map((v) => (v + m) * 255) as [number, number, number]);
}

const NEUTRAL_FILL = `color-mix(in srgb, ${INK_VAR} 6%, ${PAPER_VAR})`;

/**
 * A frame, lane or container's fill and edge. Its own colour (see resolveColour) is a soft tint of its hue, with a darker edge of the same
 * hue. No colour, white, or anything we do not know is neutral: ink in paper, with the outline ink for the edge.
 */
export function frameColours(raw: unknown): { fill: string; edge: string } {
  const hex = resolveColour(raw);
  if (hex === undefined || hex.toUpperCase() === '#FFFFFF') return { fill: NEUTRAL_FILL, edge: OUTLINE_INK };
  const [h, s] = hexToHsl(hex);
  return {
    fill: hslToHex(h, Math.min(s, PICTURE.tintSaturation), PICTURE.tintLightness),
    edge: hslToHex(h, Math.min(s, PICTURE.edgeSaturation), PICTURE.edgeLightness),
  };
}

/** The fill of a box that is neither a frame nor a sticky (an image, or a kind we do not draw): the neutral tint. */
export const QUIET_FILL = NEUTRAL_FILL;
