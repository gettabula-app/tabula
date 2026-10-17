import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountPage } from '../src/ui/home';
import { FakeDOMParser, FakeElement, flush, hasControl, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

// Slice 4 P3: a signed-in person with no boards still sees the Boards toolbar, so the New board menu and New team stay reachable,
// and the templates as cards under the empty state still offer a start (TAB-375: the welcome cards replace the template strip).
let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('DOMParser', FakeDOMParser);
});
afterEach(async () => {
  // a popover arms its outside-click listener on a timer (src/ui/common.ts): let that run while the fake window is still here
  (await import('../src/ui/common')).closePopover();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
  browser.uninstall();
});

const nav = { open: () => undefined } as never;
const view = (role: string) => ({ nav, me: { user: { id: 'u1', name: 'Ana', role }, teams: [] }, down: false, refresh: () => undefined, query: { value: '' } }) as never;
const empty = { teams: [], boards: [], unreachable: false } as never;

describe('the Boards page of an account with no boards', () => {
  it('keeps the toolbar visible with Search, the New board menu and New team', () => {
    const page = accountPage(view('member'), empty) as unknown as FakeElement;
    const toolbar = need(page, '.home-toolbar');
    expect(toolbar.hidden).toBeFalsy();
    expect(page.querySelector('.home-search')).not.toBeNull();
    for (const label of ['New board', 'New team']) expect(hasControl(toolbar, label)).toBe(true);
    expect(hasControl(toolbar, 'Import file')).toBe(false);
  });

  it('does not use the empty layout class that hides the heading, and its empty state has New board only', () => {
    const page = accountPage(view('member'), empty) as unknown as FakeElement;
    expect(need(page, 'main').classList.contains('empty')).toBe(false);
    expect(textOf(need(page, '.home-empty-state h2'))).toBe('No boards yet');
    // the template strip right below carries the templates, so the empty state does not repeat them
    expect(need(page, '.home-empty-state').querySelectorAll('button, a').map(textOf)).toEqual(['New board']);
    expect(need(page, '.bc-welcome').hidden).toBeFalsy();
    // both sit in the .home grid (the welcome in its own wrapper), so its one section gap separates them
    expect((need(page, '.bc-welcome').parentNode as FakeElement).parentNode).toBe(need(page, '.home-groups').parentNode);
  });

  it('keeps Import file in the empty-state New board menu', async () => {
    const page = accountPage(view('member'), empty) as unknown as FakeElement;
    need(page, '.home-empty-state .home-empty-actions .btn.primary').click();
    const menu = browser.document.body.querySelector('.popover[role="menu"]') as FakeElement;
    expect(menu.querySelectorAll('[role="menuitem"]').map(textOf)).toEqual(['Blank board', 'From a template…', 'Import a file…']);
    (await import('../src/ui/common')).closePopover();
    await flush();
  });
});
