import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BoardApp } from '../src/app';
import { addCard, newKanban } from '../src/containers';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';

type FetchResponder = (url: string) => Promise<Response>;

let browser: FakeBrowser | undefined;
let release: (() => void) | undefined;

afterEach(() => {
  release?.();
  release = undefined;
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function setup(respond: FetchResponder) {
  browser = installFakeBrowser();
  const head = browser.document.createElement('head');
  browser.document.documentElement.insertBefore(head, browser.document.body);
  Object.assign(browser.document, { head });
  Object.assign(browser.location, { href: 'https://demo.test/demo/', origin: 'https://demo.test', pathname: '/demo/' });
  vi.stubEnv('VITE_DEMO', '1');
  vi.stubEnv('BASE_URL', '/demo/');
  const nativeFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) => respond(String(input)));
  vi.stubGlobal('fetch', nativeFetch);

  const demo = await import('../src/demo');
  release = demo.installDemoGuards();
  const exporters = await import('../src/exporters');
  return { demo, exporters, nativeFetch };
}

function appWithFonts(fonts: { slug: string; weight: number }[]): BoardApp {
  const store = new Store(new Y.Doc());
  fonts.forEach(({ slug, weight }, index) => store.create({
    id: `font-${index}`, type: 'text', x: index * 320, y: 0, w: 300, h: 48, rotation: 0, z: String(index),
    createdBy: 'visitor', font: slug, fontWeight: weight, text: 'Offline export', fontSize: 18,
  }));
  return {
    store,
    r: { contentBounds: () => ({ x: 0, y: 0, w: 640, h: 100 }), ctx: { get: (id: string) => store.getPlaced(id) } },
  } as unknown as BoardApp;
}

function face(slug: string, family: string, weight: number) {
  const path = `https://cdn.fontshare.com/fonts/${slug}-${weight}.woff2`;
  return `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; src: url('${path}') format('woff2'); }`;
}

const smallFont = () => new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'content-type': 'font/woff2' } });

describe('SVG font export', () => {
  it('embeds data-URI faces for used weights and makes no Fontshare import', async () => {
    const css = [face('satoshi', 'Satoshi', 400), face('satoshi', 'Satoshi', 500), face('satoshi', 'Satoshi', 700)].join('\n');
    const { demo, exporters, nativeFetch } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(css);
      if (url.startsWith('https://cdn.fontshare.com/')) return smallFont();
      throw new Error(`Unexpected request: ${url}`);
    });

    const svg = await exporters.exportSvgFile(appWithFonts([{ slug: 'satoshi', weight: 400 }]));
    const urls = nativeFetch.mock.calls.map(([input]) => String(input));
    expect(svg).toContain('@font-face');
    expect(svg).toContain('src: url("data:font/woff2;base64,');
    expect(svg).not.toMatch(/@import\s+url\(https:\/\//i);
    expect(urls.filter((url) => url.includes('cdn.fontshare.com'))).toEqual([
      'https://cdn.fontshare.com/fonts/satoshi-400.woff2',
      'https://cdn.fontshare.com/fonts/satoshi-500.woff2',
    ]);
    expect(demo.demoGuardReport()).toEqual({ blocked: 0, attempts: [] });
  });

  it('exports a valid SVG without a font when the font request fails', async () => {
    const { exporters, nativeFetch } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(face('satoshi', 'Satoshi', 500));
      throw new Error('offline');
    });

    const svg = await exporters.exportSvgFile(appWithFonts([{ slug: 'satoshi', weight: 500 }]));
    expect(svg).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
    expect(svg).not.toContain('@font-face');
    expect(svg).not.toMatch(/@import\s+url\(https:\/\//i);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('stops embedding at the combined 1.5 MB raw font cap', async () => {
    const css = [face('satoshi', 'Satoshi', 500), face('general-sans', 'General Sans', 500)].join('\n');
    const bytes = new Uint8Array(800_000);
    const { exporters, nativeFetch } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(css);
      if (url.startsWith('https://cdn.fontshare.com/')) {
        return new Response(bytes, { headers: { 'content-type': 'font/woff2', 'content-length': String(bytes.byteLength) } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const svg = await exporters.exportSvgFile(appWithFonts([{ slug: 'general-sans', weight: 500 }]));
    expect(svg.match(/data:font\/woff2;base64,/g)).toHaveLength(1);
    expect(svg).not.toMatch(/@import\s+url\(https:\/\//i);
    expect(nativeFetch.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('cdn.fontshare.com'))).toEqual([
      'https://cdn.fontshare.com/fonts/satoshi-500.woff2',
      'https://cdn.fontshare.com/fonts/general-sans-500.woff2',
    ]);
  });

  it('returns without waiting for a font server that never responds', async () => {
    vi.useFakeTimers();
    const { exporters } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(face('satoshi', 'Satoshi', 500));
      return new Promise<Response>(() => undefined);
    });

    const result = exporters.exportSvgFile(appWithFonts([{ slug: 'satoshi', weight: 500 }]));
    await vi.advanceTimersByTimeAsync(8001);
    const svg = await result;
    expect(svg).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
    expect(svg).not.toContain('@font-face');
  });
});

describe('PNG card links', () => {
  it('rasterizes the visible link icon and returns no clickable SVG anchor', async () => {
    const css = face('satoshi', 'Satoshi', 500);
    const { exporters } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(css);
      if (url.startsWith('https://cdn.fontshare.com/')) return smallFont();
      throw new Error(`Unexpected request: ${url}`);
    });
    const store = new Store(new Y.Doc());
    const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'visitor', bodyFont: 'satoshi', headingFont: 'satoshi' });
    store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
    const id = addCard(store, lanes[0].id, 'Open design', { createdBy: 'visitor', font: 'satoshi' })!;
    store.transact(() => store.update(id, { link: 'https://example.com/design' }));
    const app = {
      store,
      r: {
        contentBounds: () => ({ x: 0, y: 0, w: 1000, h: 500 }),
        ctx: { get: (objectId: string) => store.getPlaced(objectId), containerLayout: (objectId: string) => store.containerLayout(objectId), label: (labelId: string) => store.labels.get(labelId) },
      },
    } as unknown as BoardApp;

    let sourceBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { sourceBlob = blob as Blob; return 'blob:kanban-svg'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    class ImageStub {
      decoding = '';
      onload?: () => void;
      onerror?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', ImageStub);
    const drawImage = vi.fn<CanvasRenderingContext2D['drawImage']>();
    const canvasContext = { drawImage, measureText: (text: string) => ({ width: text.length * 7 }), font: '' };
    const canvas = {
      width: 0, height: 0,
      getContext: () => canvasContext,
      toBlob: (callback: BlobCallback | null, type?: string) => callback?.(new Blob(['raster pixels'], { type })),
    };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => tag === 'canvas' ? canvas as unknown as HTMLCanvasElement : createElement(tag));

    const png = await exporters.exportPng(app, [container.id], 1);
    expect(png.type).toBe('image/png');
    expect(await png.text()).not.toContain('<a');
    expect(drawImage).toHaveBeenCalledOnce();
    expect(sourceBlob?.type).toBe('image/svg+xml');
    const intermediateSvg = await sourceBlob!.text();
    expect(intermediateSvg).toContain('data-card-link="true"');
    expect(intermediateSvg).toContain('href="https://example.com/design"');
    expect(intermediateSvg).toContain('M10 13.5l4-4M8.5 15.5l-1 1a3 3 0 01-4.2-4.2l3-3a3 3 0 014.2 0');
  });
});
