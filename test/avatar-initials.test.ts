import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Initials in a circle: capitals centred by cap height, line height 1, and a letter size that leaves even room for two letters.
const CIRCLES = ['avatar', 'phone-avatar', 'phone-person-avatar', 'comment-avatar', 'chat-avatar', 'chat-here-avatar', 'here-sq'];

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

const rules = cssFiles('src').flatMap((file) =>
  [...readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ file, selectors: selectors.trim(), body })),
);

describe('initials circles', () => {
  it('share one centring rule that trims to the cap height', () => {
    const shared = rules.find((rule) => rule.selectors.startsWith(':is(.avatar'));
    expect(shared).toBeDefined();
    for (const name of ['avatar', 'phone-avatar', 'phone-person-avatar', 'comment-avatar', 'chat-avatar', 'here-sq', 'notif-sq']) expect(shared!.selectors).toContain(`.${name}`);
    expect(shared!.body).toMatch(/text-box:\s*trim-both cap alphabetic/);
    expect(shared!.body).toMatch(/line-height:\s*1\b/);
  });

  it('keeps the letters between 36% and 50% of the circle where a rule sets both sizes', () => {
    const checked: string[] = [];
    for (const rule of rules) {
      if (rule.selectors.includes(',') || rule.selectors.includes(':is(')) continue;
      const last = rule.selectors.split(/\s+/).pop() ?? '';
      if (!CIRCLES.some((name) => last === `.${name}`)) continue;
      const width = /(?:^|;|\s)width:\s*(\d+)px/.exec(rule.body)?.[1];
      const size = /font(?:-size)?:\s*(?:\d+\s+)?(\d+)px/.exec(rule.body)?.[1];
      if (!width || !size) continue;
      const ratio = Number(size) / Number(width);
      checked.push(`${rule.selectors} ${size}/${width}`);
      expect(ratio, `${rule.selectors}: ${size}px in ${width}px`).toBeGreaterThanOrEqual(0.36);
      expect(ratio, `${rule.selectors}: ${size}px in ${width}px`).toBeLessThanOrEqual(0.5);
    }
    expect(checked.length).toBeGreaterThanOrEqual(4);
  });
});
