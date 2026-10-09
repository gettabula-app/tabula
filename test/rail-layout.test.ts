import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const styles = read('../src/styles.css');
const board = read('../src/ui/board.ts');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return styles.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('tool rail scroll layout', () => {
  it('keeps the rail as a flex column', () => {
    expect(rule('.rail')).toMatch(/display:\s*flex/);
    expect(rule('.rail')).toMatch(/flex-direction:\s*column/);
  });

  it('scrolls the tools in a min-height-zero region before the pinned controls', () => {
    expect(rule('.rail-tools')).toMatch(/flex:\s*1\s*1\s*auto/);
    expect(rule('.rail-tools')).toMatch(/min-height:\s*0/);
    expect(rule('.rail-tools')).toMatch(/overflow-y:\s*auto/);
    expect(board).toMatch(/class: 'rail-tools'[\s\S]*?pollBtn,[\s\S]*?class: 'rail-end'/);
  });

  it('keeps Undo and Redo below the scroller without sticky positioning or margin overlap', () => {
    expect(rule('.rail-end')).toMatch(/flex:\s*none/);
    expect(rule('.rail-end')).not.toMatch(/position:\s*sticky/);
    expect(rule('.rail-end')).not.toMatch(/margin-bottom:\s*-/);
    expect(board).toMatch(/class: 'rail-end'[\s\S]*?'aria-label': 'Undo'[\s\S]*?'aria-label': 'Redo'/);
  });

  it('keeps the split active on short wide screens and flattens it on tall desktop screens', () => {
    expect(styles).toContain('@media (min-width: 861px) and (min-height: 981px)');
    expect(styles).toMatch(/\.rail-tools, \.rail-end \{ display: contents; \}/);
  });
});
