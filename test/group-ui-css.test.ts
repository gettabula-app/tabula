import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/ui/group-ui.css', import.meta.url), 'utf8');
const render = readFileSync(new URL('../src/render.ts', import.meta.url), 'utf8');

describe('group UI motion and touch targets', () => {
  it('fades the dim over 120 ms and removes the transition for reduced motion', () => {
    expect(css).toMatch(/\.group-dim-wash\s*\{[^}]*transition:\s*opacity 120ms/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?\.group-dim-wash\s*\{[^}]*transition:\s*none/);
  });

  it('gives the touch Done chip and Group actions 44 px targets', () => {
    expect(css).toMatch(/pointer:\s*coarse[\s\S]*?\.group-done\s*\{[^}]*height:\s*28px;[^}]*min-width:\s*44px;/);
    expect(css).toMatch(/pointer:\s*coarse[\s\S]*?\.group-done::after\s*\{[^}]*bottom:\s*0;[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*transform:\s*translate\(-50%,\s*0\);/);
    expect(css).toMatch(/pointer:\s*coarse[\s\S]*?\.icon-btn\.qb-text\.group-action\s*\{[^}]*height:\s*44px;[^}]*min-width:\s*44px;/);
  });

  it('keeps chips over the canvas and promotes pins over the chip row without a bridge', () => {
    expect(css).toMatch(/\.board-surface\s*\{\s*z-index:\s*0;\s*\}/);
    expect(css).toMatch(/\.group-chip,\s*\.group-done\s*\{[^}]*z-index:\s*20;/);
    expect(css).toMatch(/\.group-pin-overlay\s*\{[^}]*z-index:\s*21;[^}]*pointer-events:\s*none;/);
    expect(css).not.toContain('group-chip-bridge');
  });

  it('keeps light tokens at 70% hover and 62% dim, with stronger dark-scheme tokens', () => {
    expect(css).toMatch(/:root\s*\{[^}]*--group-hover:\s*color-mix\(in srgb, var\(--wire\) 70%, transparent\);[^}]*--group-dim:\s*color-mix\(in srgb, var\(--canvas\) 62%, transparent\);/);
    expect(css).toMatch(/:root\[data-scheme='dark'\]\s*\{[^}]*--group-hover:\s*color-mix\(in srgb, var\(--wire\) 85%, transparent\);[^}]*--group-dim:\s*color-mix\(in srgb, var\(--canvas\) 75%, transparent\);/);
  });

  it('uses a 2 px casing that leaves the group line visible', () => {
    expect(render).toContain('const underlay = casing ? `<rect ${rect} stroke="var(--canvas)" stroke-opacity="0.8" stroke-width="${px(2)}"');
  });

  it('extends the Done hit area up and sideways, ending at the button bottom', () => {
    const after = css.match(/\.group-done::after\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(after).toMatch(/left:\s*50%;/);
    expect(after).toMatch(/bottom:\s*0;/);
    expect(after).not.toMatch(/top:/);
    expect(after).toMatch(/transform:\s*translate\(-50%,\s*0\);/);
  });
});
