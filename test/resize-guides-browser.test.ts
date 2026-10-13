import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// Guides while resizing and while drawing (docs/guides.md): the edge being dragged snaps to another object's edge at zoom 0.5, 1 and 2, the guide shows while
// dragging, the size readout follows, and the drop lands exactly where the last frame showed (no jump on commit).

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
  await page.goto(`${base}?debug#/b/rzg-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  await page.waitForFunction(() => document.querySelector('.rail-btn[aria-label="Sticky note"]'));
  return page;
}

/** Two stickies at a zoom: `ref` (the target, left edge at x = 400) and `a` (the one resized or drawn next to it), the camera centred on both. */
const seed = (page: Page, zoom: number) => page.evaluate(async (z) => {
  const app = (window as any).__board;
  const mk = (id: string, x: number, y: number, w: number, h: number) => app.store.transactAs(() => app.store.create({ id, type: 'sticky', x, y, w, h, rotation: 0, z: app.store.topZ(), text: '', fill: '#FFE16B' }), 'seed');
  mk('ref', 400, 100, 200, 160);
  mk('a', 100, 100, 160, 160);
  app.setSelection(['a']);
  app.zoomTo(z);
  app.r.setCamera({ x: 350 - app.r.viewport().w / 2, y: 180 - app.r.viewport().h / 2, zoom: z });
  await new Promise((r) => setTimeout(r, 400));
}, zoom);
const screenOf = (page: Page, x: number, y: number) => page.evaluate(({ x, y }) => {
  const app = (window as any).__board;
  const p = app.r.toScreen({ x, y });
  const r = app.r.root.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, { x, y });
const obj = (page: Page, id: string) => page.evaluate((i) => { const o = (window as any).__board.store.get(i); return o && { x: o.x, y: o.y, w: o.w, h: o.h }; }, id);
const guideCount = (page: Page) => page.evaluate(() => (window as any).__board.r.overlay.guides.length as number);
const pill = (page: Page) => page.evaluate(() => document.querySelector('.drag-pill')?.textContent ?? null);

describe.skipIf(!available)('guides while resizing and drawing', () => {
  for (const zoom of [0.5, 1, 2]) {
    it(`snaps a resized edge to another object's edge at zoom ${zoom}, with a readout and no jump on drop`, async () => {
      const page = await open();
      await seed(page, zoom);
      const handle = await screenOf(page, 260, 180); // the east handle of 'a'
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      const near = await screenOf(page, 397, 180); // 3 world units short of ref's left edge: well inside the 6 screen px reach at every zoom here
      await page.mouse.move(near.x, near.y, { steps: 8 });
      await page.waitForFunction(() => (window as any).__board.r.overlay.guides.length > 0);
      const mid = await obj(page, 'a');
      expect(mid!.x + mid!.w).toBeCloseTo(400, 3); // snapped
      expect(await pill(page)).toBe(`${Math.round(mid!.w)} × ${Math.round(mid!.h)}`);
      await page.mouse.up();
      expect(await obj(page, 'a')).toEqual(mid); // the drop is where the last frame was
      await page.waitForFunction(() => !document.querySelector('.drag-pill'));
      await page.close();
    });
  }

  it('Alt turns the resize guides off', async () => {
    const page = await open();
    await seed(page, 1);
    const handle = await screenOf(page, 260, 180);
    await page.mouse.move(handle.x, handle.y);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    const near = await screenOf(page, 397, 180);
    await page.mouse.move(near.x, near.y, { steps: 8 });
    expect(await guideCount(page)).toBe(0);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.close();
  });

  for (const zoom of [0.5, 1, 2]) {
    it(`snaps the corner of a new sticky drawn next to another at zoom ${zoom}`, async () => {
      const page = await open();
      await seed(page, zoom);
      await page.evaluate(() => (window as any).__board.setSelection([]));
      await page.click('.rail-btn[aria-label="Sticky note"]');
      const from = await screenOf(page, 100, 300);
      const to = await screenOf(page, 397, 460);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.waitForFunction(() => (window as any).__board.r.overlay.guides.length > 0);
      expect(await pill(page)).toMatch(/^\d+ × \d+$/);
      await page.mouse.up();
      const made = await page.evaluate(() => [...(window as any).__board.store.cache.values()].find((o: any) => o.id !== 'ref' && o.id !== 'a' && o.type === 'sticky'));
      expect(made.x + made.w).toBeCloseTo(400, 3);
      await page.close();
    });
  }
});
