import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// Line height in the real app: the properties panel's Line height control writes the object's lineHeight and the text object's stored height follows;
// choosing the default 1.3 deletes the key; a value that is not a preset shows "Custom 1.25" and selects nothing.

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
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?debug#/b/lh-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  await page.waitForFunction(() => document.querySelector('.rail-btn[aria-label="Sticky note"]'));
  return page;
}

const seedText = (page: Page) => page.evaluate(`(async () => {
  const app = window.__board;
  const { textHeight } = await import('/src/markup.ts');
  const o = { id: 't1', type: 'text', x: 100, y: 100, w: 160, h: 0, rotation: 0, z: app.store.topZ(), text: 'one two three four five six seven eight nine ten', fontSize: 20 };
  o.h = textHeight(o);
  app.store.transactAs(() => app.store.create(o), 'seed');
  app.setSelection(['t1']);
})()`);
const obj = (page: Page) => page.evaluate(() => { const o = (window as any).__board.store.get('t1'); return { h: o.h, lineHeight: o.lineHeight }; });
// The webfont arrives after the page opens and changes how the text wraps, so a height measured at seed time can be stale (CI saw 104 -> 78).
// Compare the stored height with a fresh measurement of the same object, taken at the same moment.
const measured = (page: Page, lineHeight?: number) => page.evaluate(`(async () => {
  const { textHeight } = await import('/src/markup.ts');
  const o = { ...window.__board.store.get('t1') };
  if (${JSON.stringify(lineHeight ?? null)} === null) delete o.lineHeight; else o.lineHeight = ${JSON.stringify(lineHeight ?? null)};
  return textHeight(o);
})()`) as Promise<number>;
const openProps = async (page: Page) => {
  await page.click('[aria-label="More properties"]');
  await page.waitForSelector('[aria-label="Line height 2"]');
};

describe.skipIf(!available)('line height', () => {
  it('the properties control sets lineHeight and the text object height follows; the default deletes the key', async () => {
    const page = await open();
    await seedText(page);
    const start = await obj(page);
    expect(start.lineHeight).toBeUndefined();
    await openProps(page);
    await page.click('[aria-label="Line height 2"]');
    await page.waitForFunction(() => (window as any).__board.store.get('t1').lineHeight === 2);
    await expect.poll(async () => (await obj(page)).h - (await measured(page, 2))).toBeCloseTo(0, 3);
    expect((await obj(page)).h).toBeGreaterThan((await measured(page)) * 1.4); // 2 / 1.3 more per line
    await page.click('[aria-label="Line height 1.3"]');
    await page.waitForFunction(() => (window as any).__board.store.get('t1').lineHeight === undefined);
    await expect.poll(async () => (await obj(page)).h - (await measured(page))).toBeCloseTo(0, 3);
    await page.close();
  });

  it('shows a value that is not a preset as Custom, with nothing selected', async () => {
    const page = await open();
    await seedText(page);
    await page.evaluate(() => (window as any).__board.store.transactAs(() => (window as any).__board.store.update('t1', { lineHeight: 1.25 }), 'seed'));
    await openProps(page);
    await page.waitForSelector('.line-height-custom');
    expect(await page.textContent('.line-height-custom')).toBe('Custom 1.25');
    expect(await page.locator('[aria-label^="Line height "][aria-pressed="true"], [aria-label^="Line height "][aria-checked="true"]').count()).toBe(0);
    await page.close();
  });
});
