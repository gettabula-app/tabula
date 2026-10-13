import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../src/ui/code-controls.css', import.meta.url), 'utf8');

/** The body of every `@media (forced-colors: active)` block of a stylesheet. */
function forcedBlocks(css: string): string[] {
  const blocks: string[] = [];
  const marker = '@media (forced-colors: active)';
  let from = 0;
  for (;;) {
    const start = css.indexOf(marker, from);
    if (start < 0) return blocks;
    const open = css.indexOf('{', start + marker.length);
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
      end++;
    }
    blocks.push(css.slice(open + 1, end - 1));
    from = end;
  }
}

const rule = (css: string, selector: string) => forcedBlocks(css).join('\n').match(new RegExp(`${selector.replace(/[.[\]()']/g, '\\$&')}[^{]*\\{([^}]*)\\}`))?.[1] ?? '';

describe('a code block in Windows high contrast', () => {
  it('has a 1px CanvasText edge on a Canvas card, and the code in CanvasText with highlighting off', () => {
    const card = rule(styles, '.code-block .code-card');
    expect(card).toMatch(/fill:\s*Canvas\s*!important/);
    expect(card).toMatch(/stroke:\s*CanvasText\s*!important/);
    expect(card).toMatch(/stroke-width:\s*1px/);
    const text = forcedBlocks(styles).join('\n');
    // the runs of the highlighter (tspan fill attributes) are overridden, bold and italic with them
    expect(text).toMatch(/\.code-block \.code-text tspan[^{]*\{[^}]*fill:\s*CanvasText\s*!important/);
    expect(text).toMatch(/\.code-block \.code-text tspan[^{]*\{[^}]*font-style:\s*normal/);
  });

  it('draws no field ring on the textarea a block is typed in, and keeps system colours on the buttons', () => {
    expect(forcedBlocks(styles).join('\n')).toMatch(/\.text-editor\[data-kind='code'\]:focus[^{]*\{[^}]*outline:\s*none\s*!important/);
    const buttons = forcedBlocks(controls).join('\n');
    expect(buttons).toContain('ButtonText');
    expect(buttons).toContain('Highlight');
  });
});
