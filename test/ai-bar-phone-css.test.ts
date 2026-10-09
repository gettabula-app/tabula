import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// TAB-216 and TAB-217: the AI bar at 390 px. The layout is CSS, which a unit test cannot lay out, so this pins the rules the
// fix is made of (the headless shots of scripts/qa-ai-bar.mjs and `npm run visual` show the result): in the phone block,
// Add to board has a row of its own, the prompt has a full-width row, and the disclosure has no separators to wrap.

const css = fs.readFileSync(new URL('../src/ui/ai-bar.css', import.meta.url), 'utf8');
const phone = css.slice(css.indexOf('@media (max-width: 860px) {\n  .aibar,'));
const rule = (selector: string) => {
  const at = phone.indexOf(`${selector} {`);
  return at < 0 ? '' : phone.slice(at, phone.indexOf('}', at));
};

describe('the AI bar on a phone (ai-bar.css, max-width 860px)', () => {
  it('lets the preview buttons wrap and gives Add to board a full row', () => {
    expect(rule(".aibar[data-ui='preview'] .aibar-actions")).toContain('flex-wrap: wrap');
    expect(rule(".aibar[data-ui='preview'] .aibar-actions .btn.primary")).toContain('flex: 1 1 100%');
    // the others share the row above and may shrink below their text
    expect(rule(".aibar[data-ui='preview'] .aibar-actions .btn")).toContain('min-width: 0');
  });

  it('gives the prompt field a full-width row of its own', () => {
    expect(rule('.aibar-field')).toContain('flex: 1 1 100%');
    expect(rule('.aibar-field')).toContain('order: -1');
  });

  it('lets the quick-action chips share the row and wrap, instead of scrolling one out of sight (TAB-220)', () => {
    expect(rule('.aibar-chips')).toContain('flex-wrap: wrap');
    expect(rule('.aibar-chips')).toContain('overflow-x: visible');
    expect(rule('.aibar-chips .chip')).toContain('flex: 1 1 auto');
  });

  it('puts the facts of the disclosure one to a line, with no separator that could start a line', () => {
    expect(rule('.aibar-disclosure > span')).toContain('flex: 1 1 100%');
    expect(rule('.aibar-disclosure .sep::before')).toContain('content: none');
  });
});
