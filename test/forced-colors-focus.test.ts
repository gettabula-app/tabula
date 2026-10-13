import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function mediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = [];
  const marker = `@media ${query}`;
  let from = 0;
  while (true) {
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

function rules(css: string): { selectors: string[]; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim()).filter(Boolean),
    body: match[2],
  }));
}

describe('Windows high-contrast keyboard focus', () => {
  it('keeps shared fields and controls outlined with system Highlight', () => {
    const block = mediaBlocks(styles, '(forced-colors: active)')
      .find((candidate) => candidate.includes('.input:focus-visible')) ?? '';
    const focusRules = rules(block);
    const selectors = [
      '.input:focus', '.input:focus-visible',
      'select:focus', 'select:focus-visible',
      'textarea:focus', 'textarea:focus-visible',
      '.combo:focus', '.combo:focus-visible',
      '.aibar-input:focus', '.aibar-input:focus-visible',
      '.chat-input:focus', '.chat-input:focus-visible',
      '.ks-input:focus', '.ks-input:focus-visible',
      '.k-input:focus', '.k-input:focus-visible',
      '.layer-edit:focus', '.layer-edit:focus-visible',
      '.btn:focus-visible', '.segmented button:focus-visible',
      "input[type='checkbox']:focus-visible", "input[type='radio']:focus-visible",
      "input[role='switch']:focus-visible", "[role='checkbox']:focus-visible", "[role='radio']:focus-visible", "[role='switch']:focus-visible",
    ];

    expect(block).not.toBe('');
    for (const selector of selectors) {
      const rule = focusRules.find((candidate) => candidate.selectors.includes(selector));
      expect(rule, `${selector} should retain a focus rule in forced colors`).toBeDefined();
      expect(rule?.body).toMatch(/outline:\s*2px solid Highlight\s*!important\s*;/);
      expect(rule?.body).toMatch(/outline-offset:\s*1px\s*!important\s*;/);
    }
  });
});
