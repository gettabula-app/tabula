import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The 360 px sweep: the session bar and its Steps list stay inside the window on a phone. Read as text, as tray-overlap.test.ts does.

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

/** The body of the first `@media (…)` block that opens with `query`. */
function media(query: string): string {
  const at = css.indexOf(`@media (${query})`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i);
  }
  return '';
}

describe('the session bar on a phone (TAB-240, TAB-241)', () => {
  const phone = media('max-width: 860px');
  const rule = (selector: string) => phone.split('\n').find((l) => l.trim().startsWith(selector)) ?? '';

  it('takes the room between the rail and the edge, not the width of its content', () => {
    expect(rule('.flowbar {')).toMatch(/left: var\(--rail-clear\)[^}]*right: 12px[^}]*width: auto/);
  });

  it('gives the step a row of its own and lets its instruction wrap (write and discuss steps)', () => {
    expect(rule('.flowbar .flow-step')).toMatch(/flex: 1 1 100%[^}]*min-width: 0/);
    expect(rule('.flowbar .step-instr')).toContain('white-space: normal');
  });

  it('puts the poll question and the answered counter on rows of their own (poll steps)', () => {
    expect(rule('.flowbar > .flow-idle, .flowbar > .flow-results, .flowbar > .poll-summary')).toContain('flex-basis: 100%');
    expect(css).toMatch(/\.flowbar > \.flow-idle, \.flowbar > \.flow-results, \.flowbar > \.poll-summary \{[^}]*min-width: 0/);
  });
});
