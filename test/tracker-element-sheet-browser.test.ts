import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// Slice 3 of the tracker element, in a real browser. (A) the Views menu lists the saved views, a chosen view shows its own tickets in
// the list, a deleted view falls back to All with nothing broken, and no views hide the button. (B) at 900 board units a ticket opens
// as a side panel beside the list: Escape or its close button closes it and returns focus to its row; at 600 it opens in place.

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (!available) return;
  server = await createServer({ configFile: false, root: process.cwd(), mode: 'visual', logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
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

/** A page with the app's styles and `__mount(width, { views, initialViewId })`: the element starts on All with the seeded tickets. */
async function openElementPage(viewportWidth = 1100): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: viewportWidth, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?element-look`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import { mountTrackerShell } from '/src/tracker/ui/shell.ts';
      import { createTrackerStore } from '/src/tracker-data.ts';
      import { createMockTrackerApi } from '/src/tracker-mock.ts';
      import { createTrackerVisualSeed } from '/src/tracker/ui/visual-seed.ts';
      window.__mount = async (width, options = {}) => {
        window.__shell?.destroy();
        document.querySelector('#element-host')?.remove();
        for (const child of [...document.body.children]) if (child.id !== 'element-host') child.style.display = 'none';
        const host = document.createElement('div');
        host.id = 'element-host';
        host.style.cssText = 'position:fixed;left:20px;top:20px;';
        document.body.appendChild(host);
        const api = window.__api ?? createMockTrackerApi(createTrackerVisualSeed());
        window.__api = api;
        const store = createTrackerStore(api, { isVisible: () => false });
        window.__store = store;
        for (const view of options.views ?? []) await api.createView(view);
        const card = document.createElement('div');
        card.style.cssText = 'position:relative;';
        host.appendChild(card);
        window.__shell = mountTrackerShell(card, {
          store, api, viewerId: 'element-sheet', trackerId: 'tracker-demo', windowId: 'element-sheet-1', element: true,
          initialTab: 'all', layoutWidth: width, boardName: 'Tracker', initialViewId: options.initialViewId,
        });
        window.__shell.el.style.width = width + 'px';
        window.__shell.el.style.height = '480px';
        await store.loadMeta();
      };
    `,
  });
  await page.waitForFunction(() => typeof (window as any).__mount === 'function', null, { timeout: budget(60_000) });
  return page;
}

/** Mounts the element. Views are created on the mock first (the seed has none). */
async function mount(page: Page, width: number, options: { views?: Array<{ name: string; filter: string[] }>; initialViewId?: string } = {}): Promise<void> {
  await page.evaluate(([w, o]) => (window as any).__mount(w, o), [width, options] as const);
  await page.locator('.trk-element-header').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.trk-element .trk-list-row').length > 0, null, { timeout: budget(15_000) });
}

const rowCount = (page: Page) => page.evaluate(() => document.querySelectorAll('.trk-element .trk-list-row').length);
const subText = (page: Page) => page.locator('.trk-element .trk-element-sub').textContent();

describe.skipIf(!available)('tracker element: saved views and the side panel in a real browser', { timeout: 300_000 }, () => {
  it('(A) the Views menu lists the saved views; a chosen view shows its tickets; a view that is gone falls back to All', async () => {
    const page = await openElementPage();
    try {
      await mount(page, 900, { views: [{ name: 'Todo only', filter: ['state:todo'] }] });
      const all = await rowCount(page);
      expect(all).toBeGreaterThan(3);
      await page.waitForFunction(() => !(document.querySelector('.trk-element-views') as HTMLElement).hidden, null, { timeout: budget(15_000) });

      await page.click('.trk-element .trk-element-views');
      const names = await page.locator('.trk-element-menu-panel [role="menuitemradio"]').allTextContents();
      expect(names).toEqual(['All', 'Todo only']);
      await page.click('.trk-element-menu-panel [role="menuitemradio"]:has-text("Todo only")');
      await page.waitForFunction(() => document.querySelectorAll('.trk-element .trk-list-row').length === 3, null, { timeout: budget(15_000) });
      expect(await subText(page)).toBe('Todo only');
      expect(await page.locator('.trk-element .trk-element-switch').isHidden()).toBe(true);

      await page.click('.trk-element .trk-element-views');
      await page.click('.trk-element-menu-panel [role="menuitemradio"]:has-text("All")');
      await page.waitForFunction((n) => document.querySelectorAll('.trk-element .trk-list-row').length === n, all, { timeout: budget(15_000) });
      expect(await page.locator('.trk-element .trk-element-switch .segmented button.on').textContent()).toBe('All');

      // the shell keeps the chosen viewId; the frame writes it to the object (frame.ts persistView), which this board-less harness does not run
      await page.click('.trk-element .trk-element-views');
      await page.click('.trk-element-menu-panel [role="menuitemradio"]:has-text("Todo only")');
      await page.waitForFunction(() => document.querySelectorAll('.trk-element .trk-list-row').length === 3, null, { timeout: budget(15_000) });
      const viewId = await page.evaluate(() => (window as any).__shell.state.viewId as string);
      expect(viewId).toMatch(/^view/);

      // the view is deleted while it is open: the next mount falls back to All, and no error shows
      await page.evaluate((id) => (window as any).__api.deleteView(id), viewId);
      await mount(page, 900, { initialViewId: viewId });
      await page.waitForFunction((n) => document.querySelectorAll('.trk-element .trk-list-row').length === n, all, { timeout: budget(15_000) });
      expect(await page.locator('.trk-element .trk-element-switch .segmented button.on').textContent()).toBe('All');
      expect(await page.locator('.trk-element .trk-error-banner').isHidden()).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('(A) with no saved views the Views button is hidden', async () => {
    const page = await openElementPage();
    try {
      await mount(page, 900);
      await page.waitForTimeout(300);
      expect(await page.locator('.trk-element .trk-element-views').isHidden()).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('(B) at 900 a ticket opens beside the list: Escape closes it and focus returns to its row', async () => {
    const page = await openElementPage();
    try {
      await mount(page, 900);
      const key = await page.locator('.trk-element .trk-list-row').first().getAttribute('data-key');
      await page.click(`.trk-element .trk-list-row[data-key="${key}"] .trk-title-link`);
      await page.locator('.trk-element .trk-peek-panel .tk-page--peek, .trk-element .trk-peek-panel main').first().waitFor();
      const widths = await page.evaluate(() => {
        const element = document.querySelector('.trk-element')!.getBoundingClientRect();
        const list = document.querySelector('.trk-element .trk-peek-list')!.getBoundingClientRect();
        const panel = document.querySelector('.trk-element .trk-peek-panel')!.getBoundingClientRect();
        return { element: element.width, list: list.width, panel: panel.width, panelLeft: panel.left - element.left, listLeft: list.left - element.left };
      });
      expect(widths.listLeft).toBeLessThan(widths.panelLeft);
      expect(widths.panel / widths.element).toBeGreaterThan(0.48);
      expect(widths.panel / widths.element).toBeLessThan(0.56);
      expect(await page.locator('.trk-element .trk-element-back').isHidden()).toBe(true);
      expect(await rowCount(page)).toBeGreaterThan(3);

      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelectorAll('.trk-element .trk-peek-panel').length === 0, null, { timeout: budget(10_000) });
      const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? null);
      expect(focused).toBe(key);
    } finally {
      await page.context().close();
    }
  });

  it('(B) the close button closes the side panel and focus returns to the row', async () => {
    const page = await openElementPage();
    try {
      await mount(page, 900);
      const key = await page.locator('.trk-element .trk-list-row').nth(1).getAttribute('data-key');
      await page.click(`.trk-element .trk-list-row[data-key="${key}"] .trk-title-link`);
      await page.locator('.trk-element .trk-peek-panel').waitFor();
      await page.click('.trk-element .trk-peek-panel [aria-label="Close ticket"]');
      await page.waitForFunction(() => document.querySelectorAll('.trk-element .trk-peek-panel').length === 0, null, { timeout: budget(10_000) });
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? null)).toBe(key);
    } finally {
      await page.context().close();
    }
  });

  it('(B) at 600 the ticket opens in place, with Back and no side panel', async () => {
    const page = await openElementPage();
    try {
      await mount(page, 600);
      const key = await page.locator('.trk-element .trk-list-row').first().getAttribute('data-key');
      await page.click(`.trk-element .trk-list-row[data-key="${key}"] .trk-title-link`);
      await page.locator('.trk-element .trk-element-back').waitFor();
      expect(await page.locator('.trk-element .trk-peek-panel').count()).toBe(0);
      expect(await page.locator('.trk-element .trk-element-back').isHidden()).toBe(false);
    } finally {
      await page.context().close();
    }
  });
});
