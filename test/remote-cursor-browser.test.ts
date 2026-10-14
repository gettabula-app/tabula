import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// A remote cursor is held in board coordinates and follows the camera in the very frame that draws it: right after a pan or a zoom step its screen
// position is the projection of its board position, with no transition, and it does not move ahead of the canvas.

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

describe.skipIf(!available)('remote cursors', () => {
  it('stay locked to their board position through a pan and a zoom, in the frame of the canvas', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(budget(45_000));
    await page.goto(`${base}?debug#/b/rc-${Math.random().toString(36).slice(2, 8)}`);
    await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
    await page.waitForFunction(() => document.querySelector('.rail-btn[aria-label="Sticky note"]'));
    // a second person on the board, as the awareness of the room says
    await page.evaluate(() => {
      const app = (window as any).__board;
      const aw = app.conn.awareness;
      aw.states.set(4242, { user: { id: 'bo', name: 'Bo', color: '#CE2C7D' }, cursor: { x: 300, y: 200 } });
      aw.emit('change', [{ added: [4242], updated: [], removed: [] }, 'test']);
    });
    await page.waitForSelector('.remote-cursor');
    const read = () => page.evaluate(() => {
      const app = (window as any).__board;
      const el = document.querySelector('.remote-cursor') as HTMLElement;
      const m = new DOMMatrix(getComputedStyle(el).transform);
      const want = app.r.toScreen({ x: 300, y: 200 });
      const world = document.querySelector('svg.canvas g[transform]')?.getAttribute('transform') ?? '';
      return { x: m.m41, y: m.m42, wantX: want.x, wantY: want.y, transition: getComputedStyle(el).transitionDuration, world };
    });
    const settled = await read();
    expect(settled.x).toBeCloseTo(settled.wantX, 1);
    // the camera is set: neither the canvas nor the cursor has moved yet (both take it in the next frame)
    const during = await page.evaluate(() => {
      const app = (window as any).__board;
      const el = document.querySelector('.remote-cursor') as HTMLElement;
      const before = el.style.transform;
      const worldBefore = document.querySelector('svg.canvas g[transform]')!.getAttribute('transform');
      app.r.setCamera({ x: app.r.cam.x + 120, y: app.r.cam.y + 40 });
      return { cursorSame: el.style.transform === before, canvasSame: document.querySelector('svg.canvas g[transform]')!.getAttribute('transform') === worldBefore };
    });
    expect(during).toEqual({ cursorSame: true, canvasSame: true });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const panned = await read();
    expect(panned.x).toBeCloseTo(panned.wantX, 1);
    expect(panned.y).toBeCloseTo(panned.wantY, 1);
    expect(panned.x).toBeCloseTo(settled.x - 120 * (await page.evaluate(() => (window as any).__board.r.cam.zoom)), 1);
    expect(panned.transition).toBe('0s');
    await page.evaluate(() => { const app = (window as any).__board; app.r.setCamera({ zoom: app.r.cam.zoom * 1.5 }); });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const zoomed = await read();
    expect(zoomed.x).toBeCloseTo(zoomed.wantX, 1);
    expect(zoomed.y).toBeCloseTo(zoomed.wantY, 1);
    expect(zoomed.transition).toBe('0s');
    // only a cursor that really moved glides
    await page.evaluate(() => {
      const aw = (window as any).__board.conn.awareness;
      aw.states.set(4242, { ...aw.states.get(4242), cursor: { x: 340, y: 210 } });
      aw.emit('change', [{ added: [], updated: [4242], removed: [] }, 'test']);
    });
    expect((await read()).transition).toBe('0.09s');
    await page.close();
  });
});
