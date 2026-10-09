import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('service worker', () => {
  it('leaves the user guide to the network', () => {
    const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    expect(sw).toContain("url.pathname === '/docs' || url.pathname.startsWith('/docs/')");
    // The skip must come before the navigate handler that caches the app shell.
    expect(sw.indexOf("'/docs'")).toBeLessThan(sw.indexOf("req.mode === 'navigate'"));
  });

  it('leaves the landing-page demo to the network', () => {
    const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    expect(sw).toContain("url.pathname.startsWith('/demo/')");
    // The skip must come before the navigate handler that caches the app shell.
    expect(sw.indexOf("url.pathname.startsWith('/demo/')")).toBeLessThan(sw.indexOf("req.mode === 'navigate'"));
  });
});
