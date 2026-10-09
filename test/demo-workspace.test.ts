import { afterEach, describe, expect, it } from 'vitest';
import { demoWorkspaceItems } from '../src/ui/demo-workspace';
import { installFakeBrowser, type FakeBrowser, textOf } from './fake-dom';

let browser: FakeBrowser | undefined;

afterEach(() => {
  browser?.uninstall();
  browser = undefined;
});

describe('demo workspace menu entries', () => {
  it('shows workspace-only features as disabled', () => {
    browser = installFakeBrowser();
    const root = browser.mount();
    for (const item of demoWorkspaceItems()) root.appendChild(item as unknown as (typeof root.childNodes)[number]);

    const items = root.querySelectorAll('[data-workspace-feature]');
    expect(items.map((item) => item.getAttribute('data-workspace-feature'))).toEqual(['Share', 'Chat', 'AI', 'History', 'Backups']);
    expect(items.every((item) => item.hasAttribute('disabled'))).toBe(true);
    expect(items.every((item) => textOf(item).includes('Available in a workspace'))).toBe(true);
  });
});
