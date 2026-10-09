// Colours that are safe to write into SVG, HTML attributes and CSS (TAB-203). A board's colours are stored strings
// that any collaborator, template, import or tool can set, and they end up in markup such as `fill="…"` and
// `style="color:…"`, in exports as well as on the canvas. A string like `red;filter:url(//evil/x)` there would load a
// remote resource; one with a quote would break out of the attribute. So every colour is checked against a closed
// grammar before it is stored or drawn, and anything else becomes the caller's fallback.
//
// Accepted: #rgb, #rrggbb and #rrggbbaa (returned as upper-case #RRGGBB or #RRGGBBAA), the keywords `none` and
// `transparent`, and a theme variable with a hex fallback, exactly `var(--name, #rrggbb)`, as the canvas ink uses.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const THEME_VAR = /^var\(--[a-z][a-z0-9-]{0,40}, #[0-9a-f]{6}\)$/i;
const KEYWORDS = new Set(['none', 'transparent']);

/** The colour in its canonical form, or null when it is not one this grammar accepts. */
export function cleanColor(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const v = value.trim();
  if (HEX.test(v)) {
    const hex = v.slice(1).toUpperCase();
    return '#' + (hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex);
  }
  const lower = v.toLowerCase();
  if (KEYWORDS.has(lower)) return lower;
  if (THEME_VAR.test(v)) return v.replace(/#[0-9a-f]{6}\)$/i, (m) => m.toUpperCase());
  return null;
}

/** True when `value` is a colour this grammar accepts. */
export const isSafeColor = (value) => cleanColor(value) !== null;

/**
 * A colour safe for markup and CSS: the value in canonical form, or `fallback` when the value is anything else. The
 * fallback is the caller's own constant and must itself be safe; a fallback that is not is refused loudly, so a typo
 * cannot reopen the hole.
 */
export function safeColor(value, fallback) {
  const clean = cleanColor(value);
  if (clean !== null) return clean;
  if (fallback === null || fallback === undefined) return fallback ?? null;
  const safeFallback = cleanColor(fallback);
  if (safeFallback === null) throw new TypeError(`safeColor: the fallback ${JSON.stringify(fallback)} is not a safe colour`);
  return safeFallback;
}
