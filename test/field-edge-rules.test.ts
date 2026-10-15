import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (path: string) => readFileSync(path, 'utf8');
const styles = css('src/styles.css');

// TAB-374 and TAB-386: no edge or bar is cut by a rounded corner. A field's rule is a straight line that stops at the radius, and a chosen
// row's bar is a straight 3px bar that stops short of the row's top and bottom.
describe('straight field rules and selected-row bars', () => {
  it('defines the shared rule and bar tokens', () => {
    expect(styles).toMatch(/--rule-inset:\s*var\(--radius-sm\);/);
    expect(styles).toMatch(/--rule-image:\s*linear-gradient\(var\(--rule-colour\), var\(--rule-colour\)\) center bottom \/ calc\(100% - 2 \* var\(--rule-inset\)\) 1px no-repeat;/);
    expect(styles).toMatch(/--bar-inset:\s*9px;/);
    expect(styles).toMatch(/--bar-width:\s*3px;/);
  });

  it('draws no field edge as a shadow along the foot, in any stylesheet', () => {
    for (const path of ['src/styles.css', 'src/ui/controls.css', 'src/ui/layers.css', 'src/ui/ai-bar.css', 'src/ui/chat.css', 'src/ui/signin.css', 'src/ui/kanban.css',
      'src/ui/container-sheet.css', 'src/ui/template-picker.css', 'src/ui/admin.css', 'src/tracker/ui/tracker.css', 'src/tracker/ui/ticket-page.css']) {
      expect(css(path)).not.toMatch(/inset 0 -1px 0 var\(--field-rule\)/);
    }
  });

  it('gives a focused field one 2px ring, and an icon-prefixed field carries it on the wrapper, not the input inside', () => {
    expect(styles).toMatch(/\.board-menu-search:focus-within \{ outline: 2px solid var\(--tray-text\)/);
    expect(css('src/ui/template-picker.css')).toMatch(/\.template-picker-search:focus-within \{\s*outline: 2px solid var\(--tray-text\)/);
    expect(css('src/ui/template-picker.css')).toMatch(/\.template-picker-search-input\.input:focus-visible \{[^}]*outline: 0;[^}]*box-shadow: none;/);
  });

  it('marks a chosen row with a straight bar that stops short of the corners, not an inset shadow or a left border', () => {
    expect(styles).not.toMatch(/\.font-row\.on \{[^}]*inset 4px 0 0/);
    expect(styles).toMatch(/\.popover \.font-row\.on::before \{[^}]*top: var\(--bar-inset\); bottom: var\(--bar-inset\); width: var\(--bar-width\)/);
    expect(css('src/ui/controls.css')).toMatch(/\.combo-opt\[aria-selected='true'\]::before \{[^}]*top: var\(--bar-inset\); bottom: var\(--bar-inset\)/);
    expect(css('src/ui/chat.css')).toMatch(/\.chat-option\.on::before \{[^}]*top: var\(--bar-inset\); bottom: var\(--bar-inset\)/);
    expect(css('src/ui/comments.css')).toMatch(/\.comment-option\.on::before \{[^}]*top: var\(--bar-inset\); bottom: var\(--bar-inset\)/);
    expect(css('src/ui/chat.css')).not.toMatch(/\.chat-option\.on \{[^}]*border-left-color/);
  });

  it('keeps the notice bars of the focus and mention cards straight and inset from the rounded corners', () => {
    expect(css('src/ui/focus.css')).not.toMatch(/\.focus-card, \.focus-chip \{[^}]*border-left/);
    expect(css('src/ui/mention-notice.css')).not.toMatch(/\.mention-card \{[^}]*border-left/);
    expect(css('src/ui/focus.css')).toMatch(/\.focus-card::before, \.focus-chip::before \{[^}]*top: var\(--radius-md\); bottom: var\(--radius-md\)/);
    expect(css('src/ui/mention-notice.css')).toMatch(/\.mention-card::before \{[^}]*top: var\(--radius-md\); bottom: var\(--radius-md\)/);
  });
});
