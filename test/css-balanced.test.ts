import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** Braces outside comments and quoted strings: a missing `}` turns the rest of a file into the body of its last @media. */
function braceDepth(css: string): number {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) return depth;
  }
  return depth;
}

describe('stylesheets', () => {
  it('have balanced braces, so no rule ends up inside a media query by accident', () => {
    const unbalanced = stylesheets(join(ROOT, 'src'))
      .filter((file) => braceDepth(readFileSync(file, 'utf8')) !== 0)
      .map((file) => relative(ROOT, file));
    expect(unbalanced).toEqual([]);
  });

  it('counts a missing closing brace', () => {
    expect(braceDepth('@media (max-width: 500px) { .a { color: red; }')).toBe(1);
    expect(braceDepth('.a { content: "}"; } /* { */')).toBe(0);
  });
});
