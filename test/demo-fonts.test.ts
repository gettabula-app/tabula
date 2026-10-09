import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';

let browser: FakeBrowser | undefined;
let release: (() => void) | undefined;
let nativeFetch: ReturnType<typeof vi.fn>;

afterEach(() => {
  release?.();
  release = undefined;
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function setup(demo: boolean) {
  browser = installFakeBrowser();
  const head = browser.document.createElement('head');
  browser.document.documentElement.insertBefore(head, browser.document.body);
  Object.assign(browser.document, { head });
  Object.assign(browser.location, { href: 'https://demo.test/demo/', origin: 'https://demo.test', pathname: '/demo/' });
  vi.stubEnv('VITE_DEMO', demo ? '1' : '0');
  vi.stubEnv('BASE_URL', '/demo/');
  nativeFetch = vi.fn<() => Promise<Response>>(async () => new Response('{}'));
  vi.stubGlobal('fetch', nativeFetch);

  const fonts = await import('../src/fonts');
  const demoModule = await import('../src/demo');
  if (demo) release = demoModule.installDemoGuards();
  return { fonts, demoModule, head, nativeFetch };
}

describe('demo Fontshare allowlist', () => {
  it('imports hostile font slugs without requesting them and renders the Satoshi fallback', async () => {
    const { fonts, head, nativeFetch } = await setup(true);
    const { Store } = await import('../src/store');
    const { Comments } = await import('../src/comments');
    const { applyImported, readBoardFile } = await import('../src/exporters');
    const slugs = ['evil-slug', 'x/../../y', 'evil?f[]=satoshi&f[]=cabinet-grotesk'];
    const json = {
      format: 'driftboard', schemaVersion: 1, exportedAt: '2026-10-09T00:00:00.000Z', meta: {}, flow: {},
      objects: slugs.map((font, index) => ({
        id: `attack-${index}`, type: 'text', x: 0, y: index * 60, w: 320, h: 48, rotation: 0,
        z: String(index), createdBy: 'visitor', updatedAt: 1, font, text: 'Private board text', fontSize: 18,
      })),
    };
    const imported = await readBoardFile(new File([JSON.stringify(json)], 'crafted-board.json'));
    const store = new Store(new (await import('yjs')).Doc());
    const comments = new Comments(new (await import('yjs')).Doc());
    applyImported({ doc: store.doc, store, comments }, imported, 'visitor');

    const importedSlugs = slugs.map((_, index) => (store.get(`attack-${index}`) as { font: string }).font);
    expect(importedSlugs).toEqual(slugs);
    for (const slug of importedSlugs) {
      void fonts.ensureFont(slug);
      expect(fonts.fontFamily(slug)).toBe(fonts.fontFamily('satoshi'));
    }
    expect(fonts.cssUrl('evil-slug', [400])).toBeNull();
    expect(head.children).toHaveLength(0);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('uses the static picker catalogue and loads an allowlisted family through a guarded stylesheet URL', async () => {
    const { fonts, demoModule, head, nativeFetch } = await setup(true);
    const catalogue = await fonts.loadCatalogue();
    expect(catalogue.map((font) => font.slug)).toEqual([
      'satoshi', 'general-sans', 'cabinet-grotesk', 'switzer', 'clash-display', 'gambetta', 'boska', 'tabular', 'comico',
    ]);
    expect(nativeFetch).not.toHaveBeenCalled();

    void fonts.ensureFont('cabinet-grotesk', [700]);
    const link = head.querySelector('link');
    expect(link?.href).toBe('https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700&display=swap');
    await fetch(link!.href);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(demoModule.demoGuardReport()).toEqual({ blocked: 0, attempts: [] });
  });

  it('keeps unrestricted Fontshare URL building when DEMO is false', async () => {
    const { fonts, head } = await setup(false);
    void fonts.ensureFont('evil-slug', [400]);
    expect(fonts.cssUrl('evil-slug', [400])).toBe('https://api.fontshare.com/v2/css?f[]=evil-slug@400&display=swap');
    expect(head.querySelector('link')?.href).toBe('https://api.fontshare.com/v2/css?f[]=evil-slug@400&display=swap');
    expect(fonts.fontFamily('evil-slug')).not.toBe(fonts.fontFamily('satoshi'));
  });
});
