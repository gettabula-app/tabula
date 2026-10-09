import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TAB-208: on a phone the Comments and Chat tray, like a drawer, covers the board, so the selection's quick bar and the
// properties sheet wait (kept in place, hidden) instead of drawing over it. Read as text, as css-a11y.test.ts does.

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

/** The body of the `@media (max-width: 860px)` block that holds the quick bar rules. */
function phoneBlock(): string {
  const at = css.indexOf('@media (max-width: 860px)');
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i);
  }
  return '';
}

describe('quick bar and properties sheet beside an open tray (phone width)', () => {
  const block = phoneBlock();
  const rule = block.split('\n').find((l) => /\.quickbar, \.props\)\s*\{\s*visibility:\s*hidden/.test(l)) ?? '';
  const hides = (opener: string) => new RegExp(`:has\\(>[^{]*${opener}[^{]*\\.show`).test(rule);

  it('are hidden while the Comments and Chat tray is open', () => {
    expect(block).toContain('.quickbar');
    expect(hides('\\.side-tray')).toBe(true);
  });

  it('still wait for an open drawer', () => {
    expect(hides('\\.drawer')).toBe(true);
  });

  it('are not hidden by the tray outside phone width', () => {
    const wide = css.slice(0, css.indexOf('@media (max-width: 860px)')) + css.slice(css.indexOf('@media (max-width: 860px)') + block.length);
    expect(wide).not.toMatch(/side-tray[^{]*\{[^}]*visibility:\s*hidden/);
  });
});
