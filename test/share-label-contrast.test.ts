import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('top bar Share button', () => {
  it('draws its label in the button colour, not the muted dialog label colour', () => {
    const css = readFileSync(new URL('../src/ui/share.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.share-btn \.share-label \{ color: inherit; \}/);
  });
});
