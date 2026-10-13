// The contrast clamp for code colours (docs/code-blocks.md): a Shiki theme's token colours are checked against the block's surface (the app's `--paper`)
// and any under 4.5:1 (WCAG AA for text) is lifted until it passes by changing only its OKLCH lightness (up on a dark surface, down on a light one), so
// each token keeps its hue and as much chroma as fits sRGB (mixing toward the ink turned every Matrix token green, mixing toward white turned them grey). Pure functions, no DOM,
// so the worker, the main thread and the tests all run the same code.

export const MIN_CODE_CONTRAST = 4.5;
/** What a colour falls back to on a dark surface when even full lightness does not reach the ratio. */
export const NEUTRAL_LIGHT = '#F2F2F2';

type Rgb = [number, number, number];

/** #rgb, #rgba, #rrggbb or #rrggbbaa to RGB (alpha composited over `over`), or null when it is not a hex colour. */
export function parseHexColour(value: string, over?: Rgb): Rgb | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  const rgb: Rgb = [n(0), n(2), n(4)];
  if (h.length === 8 && over) {
    const a = n(6) / 255;
    return rgb.map((c, i) => Math.round(c * a + over[i] * (1 - a))) as Rgb;
  }
  return rgb;
}

export const toHex = (rgb: Rgb): string => `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRgb(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const unlin = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB (0-255) to OKLab [L, a, b]. */
export function rgbToOklab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab to linear sRGB (may leave 0..1). */
function oklabToLinear(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** OKLCH [L, C, h in degrees] of a hex colour (alpha composited over `over`), or null. */
export function hexToOklch(hex: string, over?: Rgb): [number, number, number] | null {
  const rgb = parseHexColour(hex, over);
  if (!rgb) return null;
  const [L, a, b] = rgbToOklab(rgb);
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/** Euclidean distance of two hex colours in OKLab (0 = identical, about 1 = black to white). */
export function oklabDistance(a: string, b: string): number {
  const x = parseHexColour(a);
  const y = parseHexColour(b);
  if (!x || !y) return 1;
  const p = rgbToOklab(x), q = rgbToOklab(y);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** The colour with this lightness and hue and the most chroma up to `c` that fits sRGB (chroma is reduced just enough), as rounded RGB. */
function fitOklch(L: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180;
  const inGamut = (k: number) => oklabToLinear(L, k * Math.cos(rad), k * Math.sin(rad)).every((v) => v >= -0.0005 && v <= 1.0005);
  let k = c;
  if (!inGamut(k)) {
    let lo = 0, hi = c;
    for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (inGamut(mid)) lo = mid; else hi = mid; }
    k = lo;
  }
  return oklabToLinear(L, k * Math.cos(rad), k * Math.sin(rad)).map((v) => unlin(Math.max(0, Math.min(1, v)))) as Rgb;
}

/**
 * The colour to draw `colour` with on `surface`: the same string when it already reaches `min`, else the same colour with only its OKLCH lightness moved
 * (up on a dark surface, down on a light one) in small steps, checked on the rounded hex, until it does. Hue and chroma are kept; chroma is reduced only when
 * the colour would leave sRGB at that lightness. If even white (or black) does not reach `min` the result is the `ink` (light surfaces) or a near-white
 * (dark ones). Not a hex colour (named, rgb(), var()) gives null, the block's plain ink.
 */
export function clampCodeColour(colour: string | null | undefined, surface: string, ink: string, min = MIN_CODE_CONTRAST): string | null {
  if (!colour) return null;
  const bg = parseHexColour(surface);
  const fallback = parseHexColour(ink);
  if (!bg || !fallback) return null;
  const rgb = parseHexColour(colour, bg);
  if (!rgb) return null;
  if (contrastRgb(rgb, bg) >= min) return colour;
  const dark = luminance(bg) < 0.18;
  const [L0, a, b] = rgbToOklab(rgb);
  const c = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  for (let t = 1; t <= 100; t++) {
    const L = dark ? L0 + (1 - L0) * (t / 100) : L0 * (1 - t / 100);
    const out = fitOklch(L, c, h).map(Math.round) as Rgb;
    if (contrastRgb(out, bg) >= min) return toHex(out);
  }
  return toHex(dark ? parseHexColour(NEUTRAL_LIGHT)! : fallback);
}

/** Largest per-channel difference, 0 to 255. */
export function rgbDistance(a: string, b: string): number {
  const x = parseHexColour(a);
  const y = parseHexColour(b);
  if (!x || !y) return 255;
  return Math.max(...x.map((c, i) => Math.abs(c - y[i])));
}
