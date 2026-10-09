import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TAB-208 and TAB-243: on a phone the Comments and Chat tray, like a drawer, covers the board, so the selection's quick
// bar, properties sheet, session bar and poll card wait (kept in place, hidden) instead of drawing over it. Read as text,
// as css-a11y.test.ts does.

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
  const rule = block.split('\n').find((l) => /\.quickbar, \.props, \.flowbar, \.poll-card\)\s*\{\s*visibility:\s*hidden/.test(l)) ?? '';
  const hides = (opener: string) => new RegExp(`:has\\(>[^{]*${opener}[^{]*\\.show`).test(rule);

  it('are hidden while the Comments and Chat tray is open', () => {
    expect(block).toContain('.quickbar');
    expect(hides('\\.side-tray')).toBe(true);
  });

  it('and a running poll card and facilitator bar wait in place until it closes', () => {
    expect(rule).toMatch(/\.flowbar, \.poll-card/);
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

// TAB-239: the base `.quickbar` rule comes after the phone block and set max-width to the window less 24px, so the bar
// ran past the right edge at 360 px (placed right of the rail it was 76 to 412) and Delete and More properties were off screen.
describe('quick bar width on a phone', () => {
  const block = phoneBlock();
  const capRule = block.split('\n').find((l) => /\.quickbar\s*\{[^}]*max-width:[^}]*--rail-clear/.test(l)) ?? '';

  it('is capped to the room right of the rail by a rule that outranks the base rule', () => {
    expect(capRule).toMatch(/\.chrome\s*>\s*\.quickbar/);
    expect(capRule).toContain('calc(100% - var(--rail-clear) - 12px)');
  });

  it('scrolls sideways and fades the edge with more behind it', () => {
    expect(css).toMatch(/\.quickbar\s*\{[^}]*overflow-x:\s*auto/);
    for (const side of ['right', 'left', 'both']) expect(css).toContain(`.quickbar[data-more='${side}']`);
  });
});
