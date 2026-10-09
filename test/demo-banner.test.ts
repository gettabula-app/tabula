import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';
import { mountDemoBanner } from '../src/ui/demo-banner';

let browser: FakeBrowser | undefined;

afterEach(() => {
  browser?.uninstall();
  browser = undefined;
});

describe('demo disclosure', () => {
  it('shows the ephemeral notice and a Get Tabula link that goes to the top page', () => {
    browser = installFakeBrowser();
    const root = browser.mount();
    const banner = mountDemoBanner(root as unknown as HTMLElement);
    const link = banner.querySelector('a');
    expect(banner.getAttribute('role')).toBe('note');
    expect(banner.textContent).toContain('Demo: nothing is saved');
    expect(link?.textContent).toBe('Get Tabula');
    expect(link?.href).toBe('https://gettabula.app');
    expect(link?.getAttribute('target')).toBe('_top'); // the iframe sandbox allows top navigation by user activation
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.getAttribute('rel')).toBe('noopener');
  });
});
