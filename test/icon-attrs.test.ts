import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WebKit rejects `var()` in an SVG presentation attribute (rx="var(--radius-xs)") and logs an error for every icon that has one.
// The same value in a style attribute is fine in every engine.
describe('icon markup', () => {
  it('puts no CSS variable in an SVG attribute', () => {
    const source = readFileSync(new URL('../src/ui/dom.ts', import.meta.url), 'utf8');
    const bad = [...source.matchAll(/\s([a-z-]+)="var\(/g)].map((m) => m[1]);
    expect(bad).toEqual([]);
    expect(source).toContain('style="rx:var(--radius-xs)"');
  });
});
