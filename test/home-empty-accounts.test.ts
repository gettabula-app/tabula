import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountPage } from '../src/ui/home';
import { FakeElement, hasControl, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

// Slice 4 P3: a signed-in person with no boards still sees the Boards toolbar, so Import file (and New team) stay reachable, and the
// empty state still offers a template.
let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('Element', FakeElement);
});
afterEach(() => {
  vi.unstubAllGlobals();
  browser.uninstall();
});

const nav = { open: () => undefined } as never;
const view = (role: string) => ({ nav, me: { user: { id: 'u1', name: 'Ana', role }, teams: [] }, down: false, refresh: () => undefined, query: { value: '' } }) as never;
const empty = { teams: [], boards: [], unreachable: false } as never;

describe('the Boards page of an account with no boards', () => {
  it('keeps the toolbar visible with Search, New board, Import file and New team', () => {
    const page = accountPage(view('member'), empty) as unknown as FakeElement;
    const toolbar = need(page, '.home-toolbar');
    expect(toolbar.hidden).toBeFalsy();
    expect(page.querySelector('.home-search')).not.toBeNull();
    for (const label of ['New board', 'Import file', 'New team']) expect(hasControl(toolbar, label)).toBe(true);
  });

  it('does not use the empty layout class that hides the heading, and still offers a template', () => {
    const page = accountPage(view('member'), empty) as unknown as FakeElement;
    expect(need(page, 'main').classList.contains('empty')).toBe(false);
    expect(textOf(need(page, '.home-empty-state h2'))).toBe('No boards yet');
    expect(hasControl(need(page, '.home-empty-state'), 'Start from a template')).toBe(true);
  });
});
