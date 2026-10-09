import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? cssFiles(file) : entry.name.endsWith('.css') ? [file] : [];
  });
}

type Rule = { selector: string; body: string; coarse: boolean };

function rules(css: string, coarse = false): Rule[] {
  const found: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selector = css.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
      end++;
    }
    const body = css.slice(open + 1, end - 1);
    if (selector.startsWith('@media') || selector.startsWith('@supports')) {
      found.push(...rules(body, coarse || /pointer\s*:\s*coarse/.test(selector)));
    } else if (!selector.startsWith('@')) {
      found.push({ selector, body, coarse });
    }
    i = end;
  }
  return found;
}

const FILES = cssFiles(join(ROOT, 'src'));
const ALL_RULES = FILES.flatMap((file) => rules(readFileSync(file, 'utf8')));
const TOUCH_RULES = ALL_RULES.filter((rule) => rule.coarse);

describe('coarse-pointer text sizing', () => {
  it('walks every source stylesheet and gives text fields a 16px minimum', () => {
    expect(FILES.length).toBeGreaterThan(1);
    const minimum = TOUCH_RULES.some((rule) => rule.selector === ':root' && /--touch-min-font-size\s*:\s*16px\s*;/.test(rule.body));
    expect(minimum).toBe(true);

    const covered = TOUCH_RULES.filter((rule) => /font-size\s*:/i.test(rule.body));
    const required = [
      { name: 'text inputs', pattern: /input:not\(\[type=['"]checkbox['"]\]\)/i },
      { name: 'textareas', pattern: /(?:^|[,\s])textarea(?:$|[,\s])/i },
      { name: 'selects', pattern: /(?:^|[,\s])select(?:$|[,\s])/i },
      { name: 'contenteditable elements', pattern: /\[contenteditable\]/i },
    ];
    for (const control of required) {
      const match = covered.find((rule) => control.pattern.test(rule.selector));
      expect(match, `coarse rule missing for ${control.name}`).toBeDefined();
      expect(match!.body).toMatch(/font-size\s*:\s*max\(\s*var\(--touch-min-font-size\),\s*var\(--touch-input-font-size,\s*var\(--touch-min-font-size\)\)\)\s*!important/i);
    }
  });

  it('loads the coarse-pointer rules after the component stylesheets', () => {
    const entry = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    expect(entry.lastIndexOf("import './ui/touch.css'")).toBeGreaterThan(entry.lastIndexOf("import './styles.css'"));
  });
});
