import { describe, expect, it, vi } from 'vitest';
import { onceForLocation } from '../src/nav-dedupe';

describe('one route per navigation', () => {
  it('lets hashchange and popstate for the same location through once', () => {
    let href = 'https://x/#/signin/verify?token=a';
    const go = vi.fn<() => void>();
    const nav = onceForLocation(go, () => href);
    nav.handle(); // first boot route
    nav.handle(); // hashchange
    nav.handle(); // popstate for the same move
    expect(go).toHaveBeenCalledTimes(1);
    href = 'https://x/#/';
    nav.handle();
    nav.handle();
    expect(go).toHaveBeenCalledTimes(2);
  });

  it('routes the same location again after again()', () => {
    const go = vi.fn<() => void>();
    const nav = onceForLocation(go, () => 'https://x/#/b/1');
    nav.handle();
    nav.again();
    nav.handle();
    expect(go).toHaveBeenCalledTimes(2);
  });
});
