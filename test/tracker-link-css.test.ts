import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cssFiles = [
  readFileSync(new URL('../src/tracker/ui/link-dialog.css', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/tracker/ui/unlink-confirm.css', import.meta.url), 'utf8'),
];
const sharedModalCss = readFileSync(new URL('../src/tracker/ui/tracker.css', import.meta.url), 'utf8');

describe('tracker linking dialog styles', () => {
  it('uses scoped selectors and theme variables only', () => {
    expect(cssFiles[0]).toContain('var(--radius-md');
    expect(cssFiles[0]).toMatch(/\.trk \.trk-link-suggested \{ color:\s*var\(--trk-text\); \}/);
    expect(cssFiles[0]).toMatch(/\.trk \.trk-link-check-this \{[^}]*color:\s*var\(--trk-text\)/);
    expect(cssFiles[0]).toMatch(/\.trk \.trk-link-not-linked \{ color:\s*var\(--trk-text\); \}/);
    expect(cssFiles[0]).toMatch(/\.trk \.trk-link-warning-glyph \{[^}]*color:\s*var\(--trk-text\)/);
    for (const css of cssFiles) {
      expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
      const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const selectors = [...source.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(([, selector]) => selector.trim()).filter((selector) => !selector.startsWith('@'));
      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) for (const part of selector.split(',')) expect(part.trim()).toContain('.trk');
    }
    expect(sharedModalCss).toContain('border-radius: 12px');
    expect(sharedModalCss).toContain('width: min(540px, calc(100vw - 32px))');
    expect(sharedModalCss).toContain('.trk-unlink-back .modal { width: min(440px');
    expect(sharedModalCss).toContain('outline: 1px solid var(--trk-focus)');
    expect(sharedModalCss).toContain('outline-offset: 2px');
    expect(cssFiles[0]).toContain('prefers-reduced-motion: reduce');
    expect(cssFiles[0]).toContain('forced-colors: active');
  });
});
