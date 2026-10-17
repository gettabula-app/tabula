import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The option list of a properties combo opens with the current option in the middle, so its neighbours are fully on screen and a pointer click on any of
// them lands in the list. A frame that is A4 has A3 right after it: the list used to open scrolled so that option was clipped at the bottom,
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

async function frameWithSizePanel(w: number, h: number, viewportHeight = 900): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: viewportHeight } });
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
    const option = page.getByRole('option', { name: 'A3', exact: true });
    await option.waitFor();
    const visible = await page.evaluate(() => {
      const list = document.querySelector('.combo-list')!.getBoundingClientRect();
      const row = [...document.querySelectorAll('.combo-opt')].find((e) => e.textContent === 'A3')!.getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom;
    });
    expect(visible).toBe(true);
    const box = (await option.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => { const o = (window as any).__board.store.get('f1'); return o.w === 1123 && o.h === 1587; });
    expect(await size(page)).toBe('1123x1587');
    await page.close();
  });

  // The list stays inside the window and under the top bars, opens downward when there is more room there, and scrolls when it must be shorter
  // than its rows (TAB-394: it used to open upward over the Share cluster, clipped, at 800 px).
  for (const height of [800, 720]) {
    it(`opens inside the window, below the top bars, at ${height} px high; the last row is reachable`, async () => {
      const page = await frameWithSizePanel(794, 1123, height);
      // opened from the keyboard: at 720 px the board's quick bar floats over the combo, and a pointer click would land on the bar
      await page.focus('[role=combobox][aria-label="Frame size"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.combo-list');
      const placed = await page.evaluate(() => {
        const list = document.querySelector('.combo-list')!;
        const r = list.getBoundingClientRect();
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:var(--panel-top);width:0;height:0';
        document.body.appendChild(probe);
        const panelTop = probe.getBoundingClientRect().top;
        probe.remove();
        const combo = document.querySelector('[role=combobox][aria-label="Frame size"]')!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, innerHeight: window.innerHeight, panelTop, comboTop: combo.top, comboBottom: combo.bottom, scrollable: list.scrollHeight > list.clientHeight + 1 };
      });
      expect(placed.top).toBeGreaterThanOrEqual(placed.panelTop);
      expect(placed.bottom).toBeLessThanOrEqual(placed.innerHeight);
      // never overlapping the combo it belongs to
      expect(placed.bottom <= placed.comboTop || placed.top >= placed.comboBottom).toBe(true);
      // every row can be reached: the last one scrolls into view inside the list
      await page.evaluate(() => { const rows = document.querySelectorAll('.combo-opt'); rows[rows.length - 1].scrollIntoView({ block: 'nearest' }); });
      const lastInside = await page.evaluate(() => {
        const list = document.querySelector('.combo-list')!.getBoundingClientRect();
        const rows = document.querySelectorAll('.combo-opt');
        const row = rows[rows.length - 1].getBoundingClientRect();
        return row.bottom <= list.bottom + 1 && row.top >= list.top - 1;
      });
      expect(lastInside).toBe(true);
      await page.close();
    });
  }

  for (const height of [800, 720]) {
    it(`the Frame tool menu stays inside the window and under the top bars at ${height} px high`, async () => {
      const page = await browser!.newPage({ viewport: { width: 1280, height } });
      page.setDefaultTimeout(budget(45_000));
      await page.goto(`${base}?debug#/b/frame-menu-${Math.random().toString(36).slice(2, 8)}`);
      await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
      await page.focus('.rail-tool-group[aria-label*="Frame"]');
      await page.keyboard.press('ArrowRight');
      await page.getByRole('radiogroup', { name: 'Frame orientation' }).waitFor();
      const placed = await page.evaluate(() => {
        const menu = document.querySelector('.frame-presets')!;
        const r = menu.getBoundingClientRect();
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:var(--panel-top);width:0;height:0';
        document.body.appendChild(probe);
        const panelTop = probe.getBoundingClientRect().top;
        probe.remove();
        return { top: r.top, bottom: r.bottom, innerHeight: window.innerHeight, panelTop };
      });
      expect(placed.top).toBeGreaterThanOrEqual(placed.panelTop - 1);
      expect(placed.bottom).toBeLessThanOrEqual(placed.innerHeight);
      await page.close();
    });
  }
});
