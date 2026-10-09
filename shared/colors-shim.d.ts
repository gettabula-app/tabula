// Types for shared/colors-shim.mjs, a temporary stand-in for shared/colors.mjs.

export const PALETTE_KEYS: readonly ['yellow', 'orange', 'pink', 'violet', 'blue', 'teal', 'green', 'grey'];

/** A palette key (lower case) or a #rgb, #rrggbb or #rrggbbaa colour, else `fallback` (null by default). */
export function safeColor(value: unknown): string | null;
export function safeColor<F>(value: unknown, fallback: F): string | F;
