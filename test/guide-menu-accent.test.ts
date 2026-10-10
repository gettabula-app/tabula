import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES, contrast } from '../src/themes';

const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('the User guide menu entry accent', () => {
  it('uses the theme accent and a heavier label, nothing else', () => {
    expect(css).toMatch(/\.menu-item\.guide-item \.ico \{ color: var\(--signal\); \}/);
    expect(css).toMatch(/\.menu-item\.guide-item > span:not\(\[class\]\) \{ font-weight: 600; \}/);
  });

  it.each(THEMES.map((t) => [t.id, t.vars]))('the accent is at least 3:1 against the menu in %s', (_id, vars) => {
    const v = vars as Record<string, string>;
    expect(contrast(v['--signal'], v['--tray'])).toBeGreaterThanOrEqual(3);
  });
});
