// Types for shared/colors.mjs. The browser imports it without an extension ('../shared/colors'); the server imports
// 'colors.mjs' directly.

/** The colour in canonical form (#RRGGBB, #RRGGBBAA, none, transparent, var(--x, #RRGGBB)), or null. */
export function cleanColor(value: unknown): string | null;
export function isSafeColor(value: unknown): boolean;
/** The colour in canonical form, or the (safe) fallback. Throws when the fallback itself is not a safe colour. */
export function safeColor(value: unknown, fallback: string): string;
export function safeColor(value: unknown, fallback?: null): string | null;
