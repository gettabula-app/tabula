import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A toast shown while the Steps list (a wide panel above the session bar) is open used to sit on top of the list's bottom row. Read as text, as
// tray-overlap.test.ts does.
const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

describe('the toast beside a wide panel', () => {
  it('moves to the top of the window, below the top bars, while a wide popover is open', () => {
    expect(css).toMatch(/body:has\(\.popover\.wide\) \.toast \{[^}]*bottom: auto;[^}]*top: calc\(72px \+ var\(--safe-top\)\)/);
    expect(css).toMatch(/body:has\(\.popover\.wide\) \.toast\.show \{[^}]*translate\(-50%, 0\)/);
  });

  it('on a phone sits over the top bars in at most two lines, clear of the list that fills the window', () => {
    expect(css).toMatch(/@media \(max-width: 860px\) \{[\s\S]*?body:has\(\.popover\.wide\) \.toast \{[^}]*top: calc\(8px \+ var\(--safe-top\)\);[^}]*width: max-content;/);
  });
});
