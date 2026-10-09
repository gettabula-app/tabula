// Types for shared/svg-safety.mjs. The browser imports it without an extension ('../shared/svg-safety').

export const MAX_SVG_BODY: number;
export function scanSvg(body: unknown, options?: { maxLength?: number; animations?: boolean }): { fatal: string | null; problems: string[]; body: string };
export function svgProblem(body: unknown): string | null;
export function sanitizeSvg(body: string, options?: { maxLength?: number }): string;
