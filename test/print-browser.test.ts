import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// Print / Save as PDF in the real app (TAB-146, docs/print.md): the print root holds one page per frame, the rest of the app is hidden in print media,
// the browser's own PDF has one sheet per page, the text stays text, and the root is gone after printing.

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (!available) return;
  server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port');
  base = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => { window.print = () => { (window as any).__printed = ((window as any).__printed ?? 0) + 1; }; });
  await page.goto(`${base}?debug#/b/pr-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: 20_000 });
  await page.evaluate(() => {
    const app = (window as any).__board;
    app.store.transactAs(() => {
      let z = 1;
      const add = (o: object) => app.store.create({ rotation: 0, z: z++, ...o });
      add({ id: 'f2', type: 'frame', x: 700, y: 0, w: 500, h: 300, name: 'Second frame' });
      add({ id: 'f1', type: 'frame', x: 0, y: 0, w: 500, h: 300, name: 'First frame' });
      add({ id: 'f3', type: 'frame', x: 0, y: 500, w: 500, h: 300, name: 'Third frame' });
      add({ id: 's1', type: 'sticky', x: 40, y: 60, w: 192, h: 192, text: 'Hello printer', fill: '#FFE16B', parent: 'f1' });
      add({ id: 's2', type: 'sticky', x: 740, y: 60, w: 192, h: 192, text: 'Second note', fill: '#FFE16B', parent: 'f2' });
    }, 'seed');
  });
  await page.waitForFunction(() => [...document.querySelectorAll('svg.canvas text')].some((t) => t.textContent === 'Hello printer'));
  return page;
}

const options = (scope: string, extra: object = {}) => ({ scope, paper: 'a4', orientation: 'auto', titles: true, ...extra });
const print = (page: Page, opts: object) => page.evaluate(`(async () => {
  const mod = await import('/src/ui/print.ts');
  return mod.printBoard(window.__board, ${JSON.stringify(opts)});
})()`) as Promise<boolean>;
const sheets = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

describe.skipIf(!available)('print and save as PDF', () => {
  it('each frame is a page in reading order, titled, with its own content; the print dialog is asked for once', async () => {
    const page = await open();
    expect(await print(page, options('frames'))).toBe(true);
    const info = await page.evaluate(() => ({
      printed: (window as any).__printed,
      titles: [...document.querySelectorAll('#print-root .print-title')].map((t) => t.textContent),
      pages: [...document.querySelectorAll('#print-root .print-page')].map((p) => [...p.querySelectorAll('text')].map((t) => t.textContent).join(' ')),
      rule: document.getElementById('print-page-rule')?.textContent,
    }));
    expect(info.printed).toBe(1);
    expect(info.titles).toEqual(['First frame', 'Second frame', 'Third frame']);
    expect(info.pages[0]).toContain('Hello printer');
    expect(info.pages[1]).toContain('Second note');
    expect(info.pages[1]).not.toContain('Hello printer');
    expect(info.rule).toMatch(/^@page \{ size: A4 landscape; margin: 12mm; \}$/);
    await page.close();
  });

  it('prints one sheet per page and hides the app; the root is on no screen and goes away after printing', async () => {
    const page = await open();
    await print(page, options('frames'));
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('print-root')!).display)).toBe('none');
    await page.emulateMedia({ media: 'print' });
    const visible = await page.evaluate(() => [...document.body.children].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id));
    expect(visible).toEqual(['print-root']);
    const pdf = await page.pdf({ preferCSSPageSize: true });
    expect(sheets(pdf)).toBe(3);
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    expect(await page.evaluate(() => [document.getElementById('print-root'), document.getElementById('print-page-rule')])).toEqual([null, null]);
    await page.close();
  });

  it('the whole board is one sheet; a selection prints only what is selected; paper and orientation are honoured', async () => {
    const page = await open();
    await print(page, options('board', { paper: 'letter', orientation: 'portrait', titles: false }));
    expect(await page.evaluate(() => [document.querySelectorAll('#print-root .print-page').length, document.querySelectorAll('#print-root .print-title').length, document.getElementById('print-page-rule')!.textContent]))
      .toEqual([1, 0, '@page { size: letter portrait; margin: 12mm; }']);
    await page.emulateMedia({ media: 'print' });
    expect(sheets(await page.pdf({ preferCSSPageSize: true }))).toBe(1);
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.evaluate(() => (window as any).__board.setSelection(['s2']));
    await print(page, options('selection'));
    const texts = await page.evaluate(() => [...document.querySelectorAll('#print-root text')].map((t) => t.textContent));
    expect(texts).toContain('Second note');
    expect(texts).not.toContain('Hello printer');
    await page.close();
  });

  // The PDF check reads Chromium's font embedding, which differs per platform (macOS Chromium writes no /FontFile object), so it runs on Linux only,
  // where CI runs it (the Linux Node 24 leg; scripts/check-browser-tests.mjs fails that leg if this file skips anything it should not).
  it.skipIf(process.platform !== 'linux')('keeps the text as text in the PDF, not a picture of it', async () => {
    const page = await open();
    await print(page, options('frames'));
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ preferCSSPageSize: true });
    expect(pdf.toString('latin1')).toContain('/FontFile'); // an embedded font program: glyphs, not an image
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
    await page.close();
  });

  it('says so, and prints nothing, when there is nothing to print', async () => {
    const page = await open();
    expect(await print(page, options('selection'))).toBe(false);
    expect(await page.evaluate(() => [(window as any).__printed ?? 0, document.getElementById('print-root')])).toEqual([0, null]);
    await page.close();
  });
});

describe('print shadows', () => {
  it('leaves the blurred note shadows out of a print and keeps everything else', async () => {
    const { withoutShadows } = await import('../src/ui/print');
    const svg = '<g><path d="M0 0" fill="#fff" filter="url(#sticky-shadow)"/><path d="M1 1" fill="#000" fill-opacity="0.2" filter="url(#sticky-curl-shadow)"/><text>x</text></g>';
    expect(withoutShadows(svg)).toBe('<g><path d="M0 0" fill="#fff"/><text>x</text></g>');
  });
});
