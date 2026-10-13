import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The axis lock in the real app (docs/guides.md): Cmd (Ctrl off a Mac) held while dragging keeps the movement on one axis, shows a dashed axis line and a pill,
// and releasing the key mid-drag unlocks it.

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
  await page.goto(`${base}?debug#/b/axl-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  await page.waitForFunction(() => document.querySelector('.rail-btn[aria-label="Sticky note"]'));
  return page;
}

const seed = (page: Page) => page.evaluate(() => {
  const app = (window as any).__board;
  app.store.transactAs(() => app.store.create({ id: 's1', type: 'sticky', x: 100, y: 100, w: 160, h: 160, rotation: 0, z: app.store.topZ(), text: 'hi', fill: '#FFE16B' }), 'seed');
  app.setZoom?.(1);
});
const centre = (page: Page) => page.evaluate(() => {
  const app = (window as any).__board;
  const o = app.store.get('s1');
  const p = app.r.toScreen({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
  const r = app.r.root.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
});
const pos = (page: Page) => page.evaluate(() => { const o = (window as any).__board.store.get('s1'); return { x: o.x, y: o.y }; });
const lockKey = (page: Page) => page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');

describe.skipIf(!available)('the axis lock', () => {
  it('keeps a drag on one axis with the key held, shows the line and the pill, and unlocks on release', async () => {
    const page = await open();
    await seed(page);
    const key = await lockKey(page);
    const c = await centre(page);
    const start = await pos(page);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down(key);
    await page.mouse.down();
    await page.mouse.move(c.x + 20, c.y + 3, { steps: 4 });
    await page.mouse.move(c.x + 90, c.y + 60, { steps: 6 }); // drifts down while mostly going right
    await page.waitForFunction(() => document.querySelector('.axis-lock-line') && document.querySelector('.drag-pill')?.textContent === 'Locked horizontal');
    const locked = await pos(page);
    expect(locked.y).toBe(start.y);
    expect(locked.x).toBeGreaterThan(start.x + 50);
    await page.keyboard.up(key);
    await page.mouse.move(c.x + 90, c.y + 61, { steps: 2 });
    await page.waitForFunction(() => !document.querySelector('.axis-lock-line') && !document.querySelector('.drag-pill'));
    expect((await pos(page)).y).toBeGreaterThan(start.y + 30); // free again: follows the pointer down
    await page.mouse.up();
    await page.close();
  });

  it('locks vertically when the first movement is up or down, and leaves nothing behind after the drop', async () => {
    const page = await open();
    await seed(page);
    const key = await lockKey(page);
    const c = await centre(page);
    const start = await pos(page);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down(key);
    await page.mouse.down();
    await page.mouse.move(c.x + 2, c.y + 40, { steps: 5 });
    await page.mouse.move(c.x + 80, c.y + 90, { steps: 5 });
    await page.waitForFunction(() => document.querySelector('.drag-pill')?.textContent === 'Locked vertical');
    expect((await pos(page)).x).toBe(start.x);
    await page.mouse.up();
    await page.keyboard.up(key);
    await page.waitForFunction(() => !document.querySelector('.axis-lock-line') && !document.querySelector('.drag-pill'));
    await page.close();
  });

  it('a plain drag does not lock', async () => {
    const page = await open();
    await seed(page);
    const c = await centre(page);
    const start = await pos(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 70, c.y + 60, { steps: 8 });
    await page.mouse.up();
    const end = await pos(page);
    expect(end.x).toBeGreaterThan(start.x + 40);
    expect(end.y).toBeGreaterThan(start.y + 40);
    await page.close();
  });
});
