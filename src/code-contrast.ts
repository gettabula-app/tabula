// The contrast clamp for code colours (docs/code-blocks.md): a Shiki theme's token colours are checked against the block's surface (the app's `--paper`)
// and any under 4.5:1 (WCAG AA for text) is lifted toward the app's `--ink` by linear mixing in small steps until it passes. Pure functions, no DOM,
// so the worker, the main thread and the tests all run the same code.

export const MIN_CODE_CONTRAST = 4.5;
const STEP = 0.04;

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

/**
 * The colour to draw `colour` with on `surface`: the same string when it already reaches `min`, else the colour mixed toward `ink` (4% steps, checked on
 * the rounded hex) until it does, or `ink` itself. Not a hex colour (named, rgb(), var()) gives null, the block's plain ink.
 */
export function clampCodeColour(colour: string | null | undefined, surface: string, ink: string, min = MIN_CODE_CONTRAST): string | null {
  if (!colour) return null;
  const bg = parseHexColour(surface);
  const fg = parseHexColour(ink);
  if (!bg || !fg) return null;
  const rgb = parseHexColour(colour, bg);
  if (!rgb) return null;
  if (contrastRgb(rgb, bg) >= min) return colour;
  for (let t = STEP; t < 1; t += STEP) {
    const mixed = rgb.map((c, i) => Math.round(c * (1 - t) + fg[i] * t)) as Rgb;
    if (contrastRgb(mixed, bg) >= min) return toHex(mixed);
  }
  return toHex(fg);
}

/** Largest per-channel difference, 0 to 255. */
export function rgbDistance(a: string, b: string): number {
  const x = parseHexColour(a);
  const y = parseHexColour(b);
  if (!x || !y) return 255;
  return Math.max(...x.map((c, i) => Math.abs(c - y[i])));
}
