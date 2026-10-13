import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The Markdown block in the real app (TAB-140, docs/markdown-blocks.md): it renders as SVG, a task box ticks and a link opens only on a selected block,
// a board-item link jumps, the source is edited in place, the rail tool creates one, and the SVG export draws it as plain SVG (no foreignObject).

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
  await page.goto(`${base}?debug#/b/fr-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  await page.evaluate(() => {
    const app = (window as any).__board;
    app.store.transactAs(() => {
      app.store.create({ id: 'fr1', type: 'frame', x: 200, y: 200, w: 500, h: 300, rotation: 0, z: app.store.topZ(), name: 'Frame 1' });
    }, 'seed');
  });
  await page.waitForFunction(() => [...document.querySelectorAll('svg.canvas text')].some((t) => t.textContent === 'Frame 1'));
  return page;
}

const label = (page: Page) => page.evaluate(() => {
  const t = [...document.querySelectorAll('svg.canvas text')].find((el) => el.textContent === 'Frame 1')!.getBoundingClientRect();
  return { left: t.left, centreY: t.top + t.height / 2, height: t.height };
});

describe.skipIf(!available)('a frame title', { timeout: 200_000 }, () => {
  for (const zoom of [0.5, 1, 2]) {
    it(`is edited where it is drawn at zoom ${zoom}: same left edge, same centre, no band`, async () => {
      const page = await open();
      await page.evaluate((z) => { const app = (window as any).__board; app.zoomTo(z); }, zoom);
      await page.waitForTimeout(250);
      const before = await label(page);
      await page.evaluate(() => (window as any).__board.editor.start('fr1'));
      const ta = page.locator('.text-editor');
      await ta.waitFor({ state: 'visible' });
      const box = await ta.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, centreY: r.top + r.height / 2, background: getComputedStyle(el).backgroundColor };
      });
      expect(Math.abs(box.left - before.left)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(box.centreY - before.centreY)).toBeLessThanOrEqual(1.5);
      expect(box.background).toBe('rgba(0, 0, 0, 0)');
    });
  }

  it('stays empty when it is cleared: no label is drawn, and it survives Enter', async () => {
    const page = await open();
    await page.evaluate(() => (window as any).__board.editor.start('fr1'));
    const ta = page.locator('.text-editor');
    await ta.waitFor({ state: 'visible' });
    await ta.fill('');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as any).__board.store.get('fr1').name === '');
    await page.waitForFunction(() => ![...document.querySelectorAll('svg.canvas text')].some((t) => t.textContent === 'Frame' || t.textContent === 'Frame 1'));
    expect(await page.evaluate(() => (window as any).__board.store.get('fr1').name)).toBe('');
  });
});
