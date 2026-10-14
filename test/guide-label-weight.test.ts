import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The label span of a menu row carries the class board-menu-label (src/ui/board.ts actionItem), so a rule that still targets
// span:not([class]) matches nothing and the guide item silently keeps the regular weight.
describe('guide item label weight', () => {
  const css = readFileSync('src/styles.css', 'utf8');
  const board = readFileSync('src/ui/board.ts', 'utf8');

  it('styles the label by its real class, 600 in a menu and 500 in the footer', () => {
    expect(board).toContain("h('span', { class: 'board-menu-label' }, label)");
    expect(css).toMatch(/\.menu-item\.guide-item > \.board-menu-label \{ font-weight: 600; \}/);
    expect(css).toMatch(/\.board-menu-footer \.guide-item > \.board-menu-label \{ font-weight: 500; \}/);
    expect(css).not.toMatch(/guide-item > span:not\(\[class\]\)/);
  });
});
