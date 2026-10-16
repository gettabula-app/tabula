import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Keep the compact phone top chrome in one row with room for the tool rail. Read CSS as text, as toast-steps.test.ts does.
const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

describe('phone top chrome', () => {
  it('uses one compact row with 44px controls and measures panels below it', () => {
    expect(css).toMatch(/\.top-right \{[^}]*display: flex; flex-wrap: nowrap;/);
    expect(css).toContain(':root { --panel-top: calc(72px + var(--safe-top)); }');
    expect(css).toMatch(/\.top-left \{[^}]*flex: 0 1 auto; min-width: 0;/);
    expect(css).toMatch(/\.top-left \.board-name \{[^}]*flex: 0 1 auto; min-width: 0;[^}]*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.top-left \.board-name \{[^}]*width: var\(--name-w, 14ch\);/);
    expect(css).toMatch(/\.top-right \{\s+top: calc\(12px \+ var\(--safe-top\)\); gap: 0; padding: 4px 2px;/);
    expect(css).toMatch(/\.top-right > button \{[^}]*width: 44px; min-width: 44px; height: 44px;/);
    expect(css).toMatch(/\.top-right > \.phone-people \{ width: 52px; min-width: 52px; flex-basis: 52px; \}/);
    expect(css).toContain('.phone-people { display: none; }');
    expect(css).toMatch(/\.people \{ display: none; \}[\s\S]*?\.phone-people \{\s+display: inline-flex/);
    expect(css).toMatch(/\.share-btn \{ background: transparent !important; color: var\(--tray-text\) !important; \}/);
    expect(css).toMatch(/\.top-right \.comment-count \{ top: 0; right: 0; \}/);
    expect(css).toContain('.demo-board > .chrome .top-left { top: calc(100px + var(--safe-top)); }');
    expect(css).toContain('.demo-board > .chrome .top-right { top: calc(100px + var(--safe-top)); }');
    expect(css).toContain('.chrome > .rail { top: max(var(--panel-top), calc(72px + var(--safe-top))); max-height: calc(100% - max(var(--panel-top), calc(72px + var(--safe-top))) - 24px - var(--safe-bottom)); }');
    expect(css).toContain('.demo-board > .chrome .rail { top: var(--panel-top); max-height: calc(100% - var(--panel-top) - 24px - var(--safe-bottom)); }');
  });
});
