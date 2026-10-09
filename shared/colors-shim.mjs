// TEMPORARY stand-in for shared/colors.mjs (safeColor, being added separately). Same signature; it only lets through
// palette keys and #rgb, #rrggbb or #rrggbbaa. shared/containers.mjs re-exports it, so swapping in the real module is the
// one import line there; then this file and its .d.ts go.

/** The palette keys: the eight sticky swatches, which are also the label and lane colours (docs/kanban.md). */
export const PALETTE_KEYS = Object.freeze(['yellow', 'orange', 'pink', 'violet', 'blue', 'teal', 'green', 'grey']);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * `value` when it is a palette key (any case, returned in lower case) or a hex colour (`#rgb`, `#rrggbb`, `#rrggbbaa`,
 * any case, returned as given); otherwise `fallback` (null by default). Nothing else, not even a valid CSS colour name or
 * function, is let through, so the result can go into a style attribute as it is.
 */
export function safeColor(value, ...rest) {
  // an explicit `undefined` is a fallback too
  const fallback = rest.length ? rest[0] : null;
  if (typeof value !== 'string') return fallback;
  const key = value.toLowerCase();
  if (PALETTE_KEYS.includes(key)) return key;
  return HEX.test(value) ? value : fallback;
}
