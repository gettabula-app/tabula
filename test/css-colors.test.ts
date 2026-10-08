import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Fixed colours that stay the same in every theme: sticky notes, white avatars and cursor labels,
// the modal scrim, and the white field and dark ink of the class and label editors (the fallback
// when the object has no colours of its own; editor.ts sets those inline).
const ALLOWED: { file: string; selector: string; literals: string[] }[] = [
  { file: 'src/styles.css', selector: '.remote-cursor span', literals: ['#fff'] },
  { file: 'src/styles.css', selector: '.avatar', literals: ['#fff'] },
  { file: 'src/styles.css', selector: "[data-tool='sticky']::after", literals: ['#FFE16B'] },
  { file: 'src/styles.css', selector: '.note::after', literals: ['#fff'] },
  { file: 'src/styles.css', selector: '.text-editor[data-mode', literals: ['#fff', '#18212B'] },
  { file: 'src/styles.css', selector: '.tile.uml svg', literals: ['#fff'] },
  { file: 'src/styles.css', selector: '.icon-tile', literals: ['#fff'] },
  { file: 'src/styles.css', selector: '.modal-back', literals: ['rgba(16, 24, 32, 0.4)'] },
  {
    file: 'src/styles.css',
    selector: '.empty-hint',
    literals: ['#1D1A12', '#FFE16B', '#FFF0B0', '#FFE58A', '#18212B', 'rgba(24, 33, 43, 0.2)', 'rgba(0, 0, 0, 0.12)', 'rgba(29, 26, 18, 0.1)'],
  },
  { file: 'src/ui/comments.css', selector: '.comment-avatar', literals: ['#fff'] },
];

const LITERAL = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|(?<![\w-])rgba?\([^)]*\)|(?<![\w-])(?:white|black)(?![\w-])/gi;

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

// Blanks comments but keeps their newlines, so reported line numbers match the source.
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

function isAllowed(file: string, selector: string, literal: string): boolean {
  return ALLOWED.some((a) => a.file === file && selector.includes(a.selector) && a.literals.some((l) => norm(l) === norm(literal)));
}

function scan(file: string): string[] {
  const css = stripComments(readFileSync(file, 'utf8'));
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const violations: string[] = [];
  for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = block[1].trim();
    if (selector === ':root') continue;
    const bodyStart = (block.index ?? 0) + block[1].length + 1;
    for (const found of block[2].matchAll(LITERAL)) {
      const line = css.slice(0, bodyStart + (found.index ?? 0)).split('\n').length;
      if (!isAllowed(rel, selector, found[0])) violations.push(`${rel}:${line} ${selector} ${found[0]}`);
    }
  }
  return violations;
}

describe('css colours', () => {
  it('uses theme variables instead of literal colours outside the allowlist', () => {
    const files = cssFiles(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap(scan)).toEqual([]);
  });
});
