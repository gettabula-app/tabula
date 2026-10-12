import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The tracker's phone list: Select, state, key, title and priority in their own columns with the title as wide as they allow,
// and the filter's suggestion sheet above the keyboard with the floating + out of its way.

const css = readFileSync(new URL('../src/tracker/ui/tracker.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../src/tracker/ui/shell.ts', import.meta.url), 'utf8');

describe('tracker phone rows', () => {
  it('gives the key its own grid item beside Select, and a title column as wide as the others allow', () => {
    expect(css).toMatch(/\.trk-col-key \{ display: contents; \}/);
    expect(css).toMatch(/\.trk-col-key > \.trk-key-chip \{[^}]*grid-area: key[^}]*margin-left: -3px/);
    expect(css).toMatch(/grid-template-columns: 44px 36px 50px minmax\(0, 1fr\) 44px !important/);
    expect(css).toMatch(/\.trk-col-state \.trk-state-value \{ margin-inline: -4px; \}/);
  });

  it('keeps the suggestion sheet above the soft keyboard and hides the floating + while it is open', () => {
    expect(css).toMatch(/\.trk-filter-suggestions \{ position: fixed;[^}]*bottom: max\(calc\(64px \+ env\(safe-area-inset-bottom\)\), calc\(var\(--trk-kb, 0px\) \+ 8px\)\)/);
    expect(css).toMatch(/\.trk:has\(\.trk-filter-suggestions:not\(\[hidden\]\)\) \.trk-new-trigger \{ display: none; \}/);
    expect(shell).toMatch(/--trk-kb/);
    expect(shell).toMatch(/visualViewport\?\.removeEventListener\('resize', publishKeyboard\)/);
  });
});
