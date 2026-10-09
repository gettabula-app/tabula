import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/ui/group-ui.css', import.meta.url), 'utf8');

describe('group UI motion and touch targets', () => {
  it('fades the dim over 120 ms and removes the transition for reduced motion', () => {
    expect(css).toMatch(/\.group-dim-wash\s*\{[^}]*transition:\s*opacity 120ms/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?\.group-dim-wash\s*\{[^}]*transition:\s*none/);
  });

  it('gives the touch Done chip and Group actions 44 px targets', () => {
    expect(css).toMatch(/pointer:\s*coarse[\s\S]*?\.group-done\s*\{[^}]*height:\s*44px;[^}]*min-width:\s*44px;/);
    expect(css).toMatch(/pointer:\s*coarse[\s\S]*?\.icon-btn\.qb-text\.group-action\s*\{[^}]*height:\s*44px;[^}]*min-width:\s*44px;/);
  });
});
