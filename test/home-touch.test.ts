import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// TAB-17: board row actions have no hover on a touch screen, so they must show without it and be big enough for a finger.
const css = readFileSync(new URL('../src/ui/home.css', import.meta.url), 'utf8');

/** The body of the first `@media (<query>) { ... }` block. */
const media = (query: string) => {
  const start = css.indexOf(`@media (${query})`);
  expect(start).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unbalanced');
};

describe('board row actions on touch screens', () => {
  it('are hidden until hover or focus with a mouse', () => {
    expect(css).toMatch(/\.board-actions \{[^}]*opacity: 0;[^}]*pointer-events: none;/);
    expect(css).toMatch(/\.board-row:hover \.board-actions,\s*\.board-row:focus-within \.board-actions \{ opacity: 1; pointer-events: auto; \}/);
  });

  it('show without hover where the device cannot hover', () => {
    expect(media('hover: none')).toMatch(/\.board-actions \{ opacity: 1; pointer-events: auto; \}/);
  });

  it('are 44px targets for a coarse pointer', () => {
    expect(media('pointer: coarse')).toMatch(/\.board-actions \.icon-btn \{ width: 44px; height: 44px; \}/);
  });
});
