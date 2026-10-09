import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
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

  it('falls back to Satoshi for imported __proto__ and constructor font names', async () => {
    const { fonts, nativeFetch } = await setup(true);
    const { Store } = await import('../src/store');
    const { Comments } = await import('../src/comments');
    const { applyImported, exportSvg, readBoardFile } = await import('../src/exporters');
    const json = {
      format: 'driftboard', schemaVersion: 1, exportedAt: '2026-10-09T00:00:00.000Z', meta: {}, flow: {},
      objects: ['__proto__', 'constructor'].map((font, index) => ({
        id: `special-font-${index}`, type: 'text', x: index * 320, y: 0, w: 300, h: 48, rotation: 0,
        z: String(index), createdBy: 'visitor', updatedAt: 1, font, text: 'Fallback text', fontSize: 18,
      })),
    };
    const imported = await readBoardFile(new File([JSON.stringify(json)], 'crafted-board.json'));
    const store = new Store(new (await import('yjs')).Doc());
    const comments = new Comments(new (await import('yjs')).Doc());
    applyImported({ doc: store.doc, store, comments }, imported, 'visitor');

    const slugs = ['special-font-0', 'special-font-1'].map((id) => (store.get(id) as { font: string }).font);
    expect(slugs).toEqual(['__proto__', 'constructor']);
    expect(slugs.map((slug) => fonts.fontFamily(slug))).toEqual([fonts.fontFamily('satoshi'), fonts.fontFamily('satoshi')]);
    const app = {
      store,
      r: { contentBounds: () => ({ x: 0, y: 0, w: 640, h: 100 }), ctx: { get: (id: string) => store.getPlaced(id) } },
    } as unknown as import('../src/app').BoardApp;
    const { svg } = exportSvg(app);
    expect(svg).toContain('&quot;Satoshi&quot;');
    expect(svg).not.toContain('&quot;Constructor&quot;');
    expect(svg).not.toContain('__proto__');
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('does not import or fetch a non-allowlisted font while exporting an SVG', async () => {
    const { nativeFetch } = await setup(true);
    const { Store } = await import('../src/store');
    const { exportSvg } = await import('../src/exporters');
    const store = new Store(new (await import('yjs')).Doc());
    store.create({
      id: 'unlisted-font', type: 'text', x: 0, y: 0, w: 320, h: 48, rotation: 0, z: 'a',
      createdBy: 'visitor', font: 'not-allowlisted', text: 'SVG export', fontSize: 18,
    });
    const app = {
      store,
      r: { contentBounds: () => ({ x: 0, y: 0, w: 320, h: 48 }), ctx: { get: (id: string) => store.getPlaced(id) } },
    } as unknown as import('../src/app').BoardApp;

    const { svg } = exportSvg(app);
    expect(svg).toContain('@import');
    expect(svg).not.toContain('not-allowlisted');
    expect(svg).not.toContain('font-family="Not-allowlisted"');
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('rejects oversized demo board files before reading or inflating them', async () => {
    await setup(true);
    const { readBoardFile } = await import('../src/exporters');
    const oversized = {
      size: 20 * 1024 * 1024 + 1,
      arrayBuffer: vi.fn<() => Promise<ArrayBuffer>>(),
    } as unknown as File;
    await expect(readBoardFile(oversized)).rejects.toThrow(/20 MiB demo import limit/);
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();

    const archive = zipSync({ 'board.json': strToU8('{}') });
    let central = -1;
    for (let i = 0; i < archive.length - 4; i++) {
      if (archive[i] === 0x50 && archive[i + 1] === 0x4b && archive[i + 2] === 0x01 && archive[i + 3] === 0x02) {
        central = i;
        break;
      }
    }
    expect(central).toBeGreaterThanOrEqual(0);
    new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(central + 24, 100 * 1024 * 1024 + 1, true);
    await expect(readBoardFile(new File([archive], 'oversized-expanded.drift'))).rejects.toThrow(/100 MiB demo import limit/);
  });

  it('does not apply the demo file-size cap in a normal build', async () => {
    await setup(false);
    const { readBoardFile } = await import('../src/exporters');
    const json = { format: 'driftboard', schemaVersion: 1, exportedAt: '2026-10-09T00:00:00.000Z', meta: {}, flow: {}, objects: [] };
    const file = {
      name: 'large-metadata.json', size: 20 * 1024 * 1024 + 1,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(json)).buffer,
    } as File;
    await expect(readBoardFile(file)).resolves.toMatchObject({ json });
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
