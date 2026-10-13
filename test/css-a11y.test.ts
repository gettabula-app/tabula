import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// docs/accessibility-audit.md, slice 5: rules about the stylesheets themselves, read as text.

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? cssFiles(p) : e.name.endsWith('.css') ? [p] : [];
  });
}
const FILES = cssFiles(join(ROOT, 'src'));

/** Splits a stylesheet into [prelude, body] pairs, descending into @media blocks; `reduce` marks the reduced-motion ones. */
function rules(css: string, reduce = false): { selector: string; body: string; reduce: boolean }[] {
  const out: { selector: string; body: string; reduce: boolean }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@media') || prelude.startsWith('@supports')) out.push(...rules(body, reduce || /prefers-reduced-motion:\s*reduce/.test(prelude)));
    else if (!prelude.startsWith('@')) out.push({ selector: prelude, body, reduce });
    i = j;
  }
  return out;
}

describe('stylesheets', () => {
  it('turn off every transition and animation under prefers-reduced-motion', () => {
    const missing: string[] = [];
    for (const file of FILES) {
      const all = rules(readFileSync(file, 'utf8'));
      const calmed = all.filter((r) => r.reduce).map((r) => r.selector).join(',');
      for (const r of all) {
        if (r.reduce || !/(^|[;\s])(transition|animation)\s*:/.test(r.body)) continue;
        if (/(^|[;\s])(transition|animation)\s*:\s*(none|0s)\b/.test(r.body)) continue;
        // each selector of the rule must be named by a reduced-motion rule of the same file (same base, any state)
        for (const sel of r.selector.split(',').map((s) => s.trim())) {
          const base = sel.replace(/::?[\w-]+(\([^)]*\))?/g, '').split(/\s+/).pop() ?? sel;
          if (!base || !calmed.includes(base)) missing.push(`${relative(ROOT, file)}: ${sel}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('let the hidden attribute win over a class that sets display', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\n\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('keep a visible focus indicator on the stickers search: the shared field focus (an edge in the text colour and a soft ring)', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    // the shared field focus draws an inset 1px edge in the text colour plus a ring, which is the indicator in a popover or drawer
    expect(css).toMatch(/\.input:focus,[^{]*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--tray-text\),\s*0 0 0 3px/);
    // the stickers search is a plain .input and nothing of the stickers rules takes that focus away
    expect(readFileSync(join(ROOT, 'src/ui/stickers.ts'), 'utf8')).toMatch(/h\('input', \{ type: 'search', class: 'input'/);
    const stickerRules = [...css.matchAll(/(\.stickers \.input[^{]*)\{([^}]*)\}/g)].map(([, selectors, body]) => ({ selectors, body }));
    for (const rule of stickerRules) expect(rule.body, rule.selectors).not.toMatch(/outline:\s*(?:0|none)|box-shadow:\s*none/);
  });

  it('give every field inside a popover, menu or drawer the shared focus, because the popover outline rule leaves inputs out', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.popover :focus-visible:not\(input\):not\(textarea\):not\(select\)/);
    const sources = ['stickers', 'emoji-picker', 'controls', 'board'].map((name) => readFileSync(join(ROOT, `src/ui/${name}.ts`), 'utf8')).join('\n');
    // every search or number field made for them carries the .input class (the board menu's own wrapper search is styled on its wrapper)
    for (const m of sources.matchAll(/h\('input', \{\s*(?:class: '([^']*)')?[^}]*type: '(?:search|text)'/g)) {
      if (m[1] !== undefined) expect(m[1]).toMatch(/\binput\b/);
    }
  });

  it('keep swatch colours and mark selected things with an outline in forced colours', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    const block = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(block).toMatch(/\.swatch[^{]*\{[^}]*forced-color-adjust:\s*none/);
    expect(block).toMatch(/\.swatch\.on[^{]*\{[^}]*outline:[^}]*Highlight/);
  });

  it('leave pinch zoom to the browser everywhere except on the canvas', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    expect(css).not.toMatch(/\.board-root\s*\{[^}]*touch-action/);
    expect(css).toMatch(/\.board-surface,\s*\.canvas\s*\{\s*touch-action:\s*none/);
  });

  it('defines safe-area insets and applies them to the board chrome', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    const root = rules(css).find((r) => r.selector === ':root')?.body ?? '';
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(root).toMatch(new RegExp(`--safe-${edge}:\\s*env\\(safe-area-inset-${edge},\\s*0px\\)`));
    }

    const rule = (selector: string) => rules(css).find((r) => r.selector === selector)?.body ?? '';
    expect(rule('.top-left')).toMatch(/var\(--safe-top\)/);
    expect(rule('.top-left')).toMatch(/var\(--safe-left\)/);
    expect(rule('.top-right')).toMatch(/var\(--safe-top\)/);
    expect(rule('.top-right')).toMatch(/var\(--safe-right\)/);
    expect(rule('.rail')).toMatch(/var\(--safe-top\)/);
    expect(rule('.rail')).toMatch(/var\(--safe-left\)/);
    expect(rule('.rail')).toMatch(/var\(--safe-bottom\)/);
    expect(rule('.flowbar')).toMatch(/var\(--safe-bottom\)/);
    expect(rule('.zoom-tray')).toMatch(/var\(--safe-bottom\)/);
    expect(rule('.zoom-tray')).toMatch(/var\(--safe-right\)/);

    const topbar = readFileSync(join(ROOT, 'src/ui/home.css'), 'utf8');
    for (const edge of ['top', 'right', 'left']) expect(topbar).toMatch(new RegExp(`--safe-${edge}`));
    expect(topbar).toMatch(/\.topbar\s*\{[^}]*calc\(8px \+ var\(--safe-top\)\)[^}]*calc\(16px \+ var\(--safe-right\)\)[^}]*calc\(16px \+ var\(--safe-left\)\)/);
  });
});
