// What the highlighter hands to the drawing code of a code block (docs/code-blocks.md): the code split into lines, each line into coloured runs.
// The runs of a line, put end to end, are exactly that line's text (tabs already expanded), so a stale or missing highlight can always be replaced
// by one plain run per line without changing the geometry.

/** One run of text with one colour. `c` is a CSS colour already lifted to the contrast the block needs, or null for the block's plain ink. */
export interface CodeToken {
  t: string;
  c: string | null;
  /** Bold / italic as set by the theme (drawn as font-weight / font-style). */
  b?: 1;
  i?: 1;
}

/** Tokens for a whole block: one array of runs per line. */
export type CodeLines = CodeToken[][];

/** The theme a block is drawn with: the id of a Shiki theme shipped with Tabula and the surface (the app's `--paper`) its colours were checked against. */
export interface CodeThemeKey {
  shiki: string;
  surface: string;
}

/** The plain version of a text: one run per line, tabs expanded to `tab` spaces, no colour. */
export function plainCodeLines(text: string, tab = 2): CodeLines {
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => [{ t: expandTabs(line, tab), c: null }]);
}

/** Tabs to the next multiple of `tab` columns, counting code points. */
export function expandTabs(line: string, tab = 2): string {
  if (!line.includes('\t')) return line;
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const n = tab - (col % tab);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}
