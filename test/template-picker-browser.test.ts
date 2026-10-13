import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { budget } from './wait-budget';
import { createServer, type ViteDevServer } from 'vite';

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
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openBoard(width = 1280, height = 900, coarsePointer = false): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport: { width, height }, hasTouch: coarsePointer, isMobile: coarsePointer });
    const page = await context.newPage();
    try {
      await page.goto(`${base}?debug`);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.locator('.rail-tool-group').waitFor({ timeout: 25_000 });
      await page.locator('.empty-hint').waitFor();
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

const closePage = (page: Page) => page.context().close();
const picker = (page: Page) => page.locator('.template-picker');
const objectCount = (page: Page) => page.evaluate(() => (window as any).__board.store.cache.size as number);

describe.skipIf(!available)('the board template picker dialog', { timeout: 200_000 }, () => {
  it('opens from the rail button with dialog popup semantics', async () => {
    const page = await openBoard();
    const opener = page.getByRole('button', { name: 'Templates and team exercises' });
    await opener.click();
    await picker(page).waitFor();
    expect(await opener.getAttribute('aria-haspopup')).toBe('dialog');
    expect(await opener.getAttribute('aria-expanded')).toBe('true');
    expect(await page.getByRole('dialog', { name: 'Start from a template' }).isVisible()).toBe(true);
    await closePage(page);
  });

  it('draws thumbnails only for cards near the visible area, and the rest as they are scrolled to', async () => {
    const page = await openBoard(1280, 520);
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await picker(page).waitFor();
    const counts = () => page.evaluate(() => ({
      cards: document.querySelectorAll('.template-picker-card').length,
      drawn: document.querySelectorAll('.template-picker-preview svg').length,
    }));
    await page.waitForFunction(() => document.querySelectorAll('.template-picker-preview svg').length > 0);
    const first = await counts();
    expect(first.cards).toBeGreaterThan(first.drawn);
    // a card far below is still empty; scrolling it into view draws it
    const drawn = (index: number) => page.evaluate((i) => document.querySelectorAll('.template-picker-preview')[i].querySelector('svg') !== null, index);
    const far = first.cards - 5;
    expect(await drawn(far)).toBe(false);
    await page.evaluate((i) => document.querySelectorAll('.template-picker-card')[i].scrollIntoView({ block: 'center' }), far);
    await page.waitForFunction((i) => document.querySelectorAll('.template-picker-preview')[i].querySelector('svg') !== null, far, { timeout: budget(20_000) });
    await closePage(page);
  });

  it('opens directly from the empty-board hint', async () => {
    const page = await openBoard();
    const opener = page.getByRole('button', { name: 'Start from a template', exact: true });
    await opener.click();
    await picker(page).waitFor();
    expect(await opener.getAttribute('aria-expanded')).toBe('true');
    await closePage(page);
  });

  it('filters by name, description and category so a retro search shows retrospective cards', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await picker(page).waitFor();
    await page.getByRole('combobox', { name: 'Search templates' }).fill('retro');
    const cards = page.locator('.template-picker-card');
    await cards.first().waitFor();
    expect(await cards.count()).toBeGreaterThan(0);
    for (const category of await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-category')))) {
      expect(category).toBe('Retrospective');
    }
    await closePage(page);
  });

  it('moves the selection with ArrowDown and inserts it with Enter', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await picker(page).waitFor();
    const before = await objectCount(page);
    const search = page.getByRole('combobox', { name: 'Search templates' });
    await search.press('ArrowDown');
    await search.press('Enter');
    await picker(page).waitFor({ state: 'detached' });
    await expect.poll(() => objectCount(page)).toBeGreaterThan(before);
    await closePage(page);
  });

  it('closes from Start from blank without inserting objects', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await picker(page).waitFor();
    const before = await objectCount(page);
    await page.getByRole('button', { name: 'Start from blank' }).click();
    await picker(page).waitFor({ state: 'detached' });
    expect(await objectCount(page)).toBe(before);
    await closePage(page);
  });

  it('closes on Escape and returns focus to the rail opener', async () => {
    const page = await openBoard();
    const opener = page.locator('.rail [data-drawer="templates"]');
    await opener.click();
    await picker(page).waitFor();
    await page.keyboard.press('Escape');
    await picker(page).waitFor({ state: 'detached' });
    expect(await opener.getAttribute('aria-expanded')).toBe('false');
    expect(await opener.evaluate((el) => document.activeElement === el)).toBe(true);
    await closePage(page);
  });

  it('uses a bottom sheet with a horizontally scrolling category row at 390 pixels', async () => {
    const page = await openBoard(390, 844, true);
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await picker(page).waitFor();
    await page.locator('.template-picker-dialog').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });
    const result = await page.evaluate(() => {
      const box = document.querySelector('.template-picker-dialog')!.getBoundingClientRect();
      const categories = document.querySelector('.template-picker-categories') as HTMLElement;
      const grid = document.querySelector('.template-picker-grid') as HTMLElement;
      return {
        bottom: box.bottom,
        height: box.height,
        viewportHeight: innerHeight,
        pillRowOverflows: categories.scrollWidth > categories.clientWidth,
        rowScroll: getComputedStyle(categories).overflowX,
        columns: getComputedStyle(grid).gridTemplateColumns,
        coarsePointer: matchMedia('(pointer: coarse)').matches,
        touchTargets: [...document.querySelectorAll<HTMLElement>('.template-picker-dialog .modal-head .icon-btn, .template-picker-search, .template-picker-category, .template-picker-actions button')]
          .map((element) => element.getBoundingClientRect().height),
      };
    });
    expect(result.bottom).toBeGreaterThanOrEqual(result.viewportHeight - 1);
    expect(result.bottom).toBeLessThanOrEqual(result.viewportHeight + 1);
    expect(result.height).toBeGreaterThan(500);
    expect(result.pillRowOverflows).toBe(true);
    expect(result.rowScroll).toBe('auto');
    expect(result.columns.trim().split(/\s+/u)).toHaveLength(1);
    expect(result.coarsePointer).toBe(true);
    expect(result.touchTargets.every((height) => height >= 44)).toBe(true);
    await closePage(page);
  });
});
