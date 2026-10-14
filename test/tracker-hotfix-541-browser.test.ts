import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// Regressions found dogfooding v5.4 on the standalone (full-screen) tracker, in real Chromium over the visual-mode mock
// (?debug&trackerMock=1): TAB-355 the description editor lost focus on a live update, TAB-354 board cards could not be dragged,
// TAB-360 the X on the ticket page reopened the ticket.

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

async function open(path = '', width = 1280): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}${path}?debug&trackerMock=1`);
  await page.waitForFunction(() => (window as any).__trackerStore && document.querySelector('.trk-list-row'), null, { timeout: budget(90_000) });
  return page;
}

describe.skipIf(!available)('standalone tracker, v5.4 dogfooding regressions', { timeout: 200_000 }, () => {
  it('TAB-355: a live update while typing in the description keeps the editor, the focus and the caret', async () => {
    const page = await open();
    await page.locator('.trk-list-row').first().click();
    await page.locator('.tk-description-body, .tk-description-placeholder').first().click();
    const input = page.locator('.tk-description-input');
    await input.waitFor();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Alpha');
    // the store tells the open page about a change (a live update from someone else, a refresh, a poll)
    await page.evaluate(async () => {
      const store = (window as any).__trackerStore;
      const href = location.pathname;
      const k = /\/t\/([A-Z]+-\d+)/.exec(href)?.[1] ?? 'TAB-101';
      await store.loadTicket(k, true);
    });
    await page.keyboard.type('Beta');
    await expect.poll(() => input.inputValue()).toMatch(/AlphaBeta$/);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('tk-description-input'))).toBe(true);
    // still editing: the editor is open and nothing was saved behind the person's back
    expect(await page.locator('.tk-description-input').count()).toBe(1);
    await page.close();
  });

  it('TAB-354: a card drags to another lane on the full-screen board', async () => {
    const page = await open();
    await page.locator('.trk-tab').filter({ hasText: 'Board' }).first().click();
    const cards = page.locator('.trk-board-card');
    await cards.first().waitFor();
    const key = (await cards.first().getAttribute('data-key'))!;
    const laneOf = () => page.evaluate((k) => document.querySelector(`.trk-board-card[data-key="${k}"]`)?.closest('.trk-board-lane')?.getAttribute('data-state') ?? '', key);
    const before = await laneOf();
    const box = (await cards.first().boundingBox())!;
    const lanes = await page.locator('.trk-board-lane').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { state: el.getAttribute('data-state'), x: r.x + r.width / 2, y: r.y + 100 };
    }));
    const target = lanes.find((lane) => lane.state !== before)!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    expect(await page.locator('.trk-board-ghost').count()).toBe(1);
    await page.mouse.up();
    await expect.poll(laneOf).toBe(target.state);
    expect(await page.locator('.trk-board-ghost').count()).toBe(0);
    await page.close();
  });

  it('TAB-360: the X on a ticket page closes it, after one ticket and after moving between tickets', async () => {
    const page = await open();
    const openPage = page.locator('.tk-page');
    const closeX = page.getByRole('button', { name: 'Close ticket' });
    await page.locator('.trk-list-row').nth(0).click();
    await openPage.waitFor();
    await closeX.click();
    await expect.poll(() => openPage.count()).toBe(0);
    expect(new URL(page.url()).pathname).not.toMatch(/^\/t\//);

    // moving from one ticket to another and closing must not bring the first one back
    await page.locator('.trk-list-row').nth(0).click();
    await openPage.waitFor();
    const first = new URL(page.url()).pathname;
    await page.locator('.trk-list-row').nth(2).click();
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(first);
    await closeX.click();
    await expect.poll(() => openPage.count()).toBe(0);
    expect(new URL(page.url()).pathname).not.toMatch(/^\/t\//);
    await page.close();
  });
});
