import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';
import { mountDemoBanner } from '../src/ui/demo-banner';

let browser: FakeBrowser | undefined;

afterEach(() => {
  browser?.uninstall();
  browser = undefined;
});

describe('demo disclosure', () => {
  it('shows the ephemeral notice and a same-frame Get Tabula link', () => {
    browser = installFakeBrowser();
    const root = browser.mount();
    const banner = mountDemoBanner(root as unknown as HTMLElement);
    const link = banner.querySelector('a');
    expect(banner.getAttribute('role')).toBe('note');
    expect(banner.textContent).toContain('Demo: nothing is saved');
    expect(link?.textContent).toBe('Get Tabula');
    expect(link?.href).toBe('https://gettabula.app');
    expect(link?.getAttribute('rel')).toBe('noopener');
    expect(link?.hasAttribute('target')).toBe(false);
  });
});
