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

  it('keep a visible focus indicator on the stickers search', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.stickers \.input:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--signal\)/);
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
});
