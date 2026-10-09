import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';
import { mountDemoBanner } from '../src/ui/demo-banner';

let browser: FakeBrowser | undefined;

afterEach(() => {
  browser?.uninstall();
  browser = undefined;
});

describe('demo disclosure', () => {
  it('explains reload and export, with one Make it yours link to the top page', () => {
    browser = installFakeBrowser();
    const root = browser.mount();
    const banner = mountDemoBanner(root as unknown as HTMLElement);
    const link = banner.querySelector('a');
    const wideCopy = banner.querySelector('.demo-banner-wide-copy');
    const shortCopy = banner.querySelector('.demo-banner-short-copy');
    expect(banner.getAttribute('role')).toBe('note');
    expect(wideCopy?.textContent).toBe('Demo: nothing is saved unless you export it. Reload and it resets.');
    expect(shortCopy?.textContent).toBe('Demo: nothing is saved unless you export it.');
    expect(banner.querySelectorAll('a')).toHaveLength(1);
    expect(link?.textContent).toBe('Make it yours →');
    expect(link?.getAttribute('href')).toBe('/#pricing');
    expect(link?.getAttribute('target')).toBe('_top'); // the iframe sandbox allows top navigation by user activation
    expect(link?.getAttribute('rel')).toBe('noopener');
    expect(banner.textContent).not.toMatch(/Get Tabula|sign up/i);
  });
});
