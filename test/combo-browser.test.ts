import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The option list of a properties combo opens with the current option in the middle, so its neighbours are fully on screen and a pointer click on any of
// them lands in the list. A frame that is A4 portrait has A4 landscape right after it: the list used to open scrolled so that option was clipped at the bottom,
// a click there counted as outside the list, and the size stayed portrait.

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

async function frameWithSizePanel(w: number, h: number): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?debug#/b/combo-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  await page.evaluate(([fw, fh]) => {
    const b = (window as any).__board;
    b.store.transact(() => b.store.create({ id: 'f1', type: 'frame', x: 100, y: 100, w: fw, h: fh, rotation: 0, z: 'a0', name: 'F' }));
    b.setSelection(['f1']);
  }, [w, h]);
  await page.click('[aria-label="More properties"]');
  await page.waitForSelector('[role=combobox][aria-label="Frame size"]');
  return page;
}

const size = (page: Page) => page.evaluate(() => { const o = (window as any).__board.store.get('f1'); return `${o.w}x${o.h}`; });

describe.skipIf(!available)('a properties combo list', { timeout: 120_000 }, () => {
  it('opens with the current option centred, so the option after it can be clicked: A4 portrait -> A4 landscape by pointer', async () => {
    const page = await frameWithSizePanel(794, 1123);
    await page.click('[role=combobox][aria-label="Frame size"]');
    const option = page.getByRole('option', { name: 'A4 landscape' });
    await option.waitFor();
    const visible = await page.evaluate(() => {
      const list = document.querySelector('.combo-list')!.getBoundingClientRect();
      const row = [...document.querySelectorAll('.combo-opt')].find((e) => e.textContent === 'A4 landscape')!.getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom;
    });
    expect(visible).toBe(true);
    const box = (await option.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => { const o = (window as any).__board.store.get('f1'); return o.w === 1123 && o.h === 794; });
    expect(await size(page)).toBe('1123x794');
    await page.close();
  });
});
