// Which Shiki theme a code block uses on each app theme, and the surface and ink its colours are checked against (docs/code-blocks.md).
// The surface is the app's `--paper`, never Shiki's own background; the ink is the app's `--ink`, the colour too-dim token colours are lifted toward.
import { THEMES } from './themes';
import type { CodeThemeKey } from './code-tokens';

export interface CodeTheme extends CodeThemeKey {
  /** App theme id. */
  id: string;
  /** The app's `--ink` on this theme. */
  ink: string;
}

const SHIKI_FOR_APP: Readonly<Record<string, string>> = {
  default: 'github-light',
  evergreen: 'github-light',
  ayu: 'ayu-dark',
  kanagawa: 'kanagawa-wave',
  matrix: 'vitesse-black',
};

/** The shipped Shiki theme ids (each one chunk). */
export const SHIKI_THEME_IDS: readonly string[] = [...new Set(Object.values(SHIKI_FOR_APP))];

export const CODE_THEMES: readonly CodeTheme[] = THEMES.map((t) => ({
  id: t.id,
  shiki: SHIKI_FOR_APP[t.id] ?? 'github-light',
  surface: t.vars['--paper'],
  ink: t.vars['--ink'],
}));

/** The code theme for an app theme id (unknown ids get the default). */
export function codeThemeFor(appThemeId: string | null | undefined): CodeTheme {
  return CODE_THEMES.find((t) => t.id === appThemeId) ?? CODE_THEMES[0];
}

/** Every colour a Shiki theme can put on a token: its foreground and each rule's foreground. */
export function themeTokenColours(theme: {
  fg?: string;
  colors?: Record<string, string>;
  settings?: Array<{ settings?: { foreground?: string } }>;
  tokenColors?: Array<{ settings?: { foreground?: string } }>;
}): string[] {
  const out = new Set<string>();
  if (theme.fg) out.add(theme.fg);
  const editor = theme.colors?.['editor.foreground'];
  if (editor) out.add(editor);
  for (const rule of [...(theme.settings ?? []), ...(theme.tokenColors ?? [])]) {
    const fg = rule.settings?.foreground;
    if (fg) out.add(fg);
  }
  return [...out];
}
