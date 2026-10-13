import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
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

async function openBoard(): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(base);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.locator('.rail-tool-group').waitFor({ timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

describe.skipIf(!available)('the grouped Text and Connector rail tool', { timeout: 200_000 }, () => {
  it('opens from the chevron and ArrowRight, then remembers the chosen tool', async () => {
    const page = await openBoard();
    const group = page.locator('.rail-tool-group');
    const flyout = page.locator('.rail-tool-pop');

    await page.locator('.rail-group-chevron').click();
    expect(await flyout.isVisible()).toBe(true);
    await page.getByRole('menuitem', { name: 'Connector' }).click();
    expect(await flyout.count()).toBe(0);
    expect(await group.getAttribute('data-tool')).toBe('connector');
    expect(await group.getAttribute('aria-label')).toBe('Connector');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('driftboard:rail-tool-group:text-link'))).toBe('connector');

    await page.locator('.rail [data-tool="pen"]').click();
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('pen');
    await group.click();
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('connector');

    await group.focus();
    await page.keyboard.press('ArrowRight');
    expect(await flyout.isVisible()).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    expect(await flyout.count()).toBe(0);
    expect(await group.getAttribute('data-tool')).toBe('text');
    expect(await group.getAttribute('aria-label')).toBe('Text');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('driftboard:rail-tool-group:text-link'))).toBe('text');

    await page.context().close();
  });

  it('opens a menu with matching popup ARIA state and right-click', async () => {
    const page = await openBoard();
    const group = page.locator('.rail-tool-group');
    const chevron = page.locator('.rail-group-chevron');
    const flyout = page.locator('.rail-tool-pop');

    expect(await group.getAttribute('aria-haspopup')).toBe('menu');
    expect(await group.getAttribute('aria-expanded')).toBe('false');
    expect(await chevron.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(24);

    await group.click({ button: 'right' });
    expect(await flyout.isVisible()).toBe(true);
    expect(await group.getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('Escape');
    expect(await group.getAttribute('aria-expanded')).toBe('false');

    await chevron.click();
    expect(await flyout.getAttribute('role')).toBe('menu');
    expect(await group.getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('Escape');
    expect(await group.getAttribute('aria-expanded')).toBe('false');

    await page.context().close();
  });

  it('activates the remembered tool after a long press and pointer leave', async () => {
    const page = await openBoard();
    const group = page.locator('.rail-tool-group');
    const flyout = page.locator('.rail-tool-pop');

    await page.locator('.rail-group-chevron').click();
    await page.getByRole('menuitem', { name: 'Connector' }).click();
    await page.locator('.rail [data-tool="pen"]').click();
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('pen');

    const box = await group.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(550);
    expect(await flyout.isVisible()).toBe(true);
    await page.mouse.move(8, 8);
    await page.mouse.up();
    await page.waitForTimeout(75);
    await page.mouse.click(x, y);

    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('connector');
    await page.context().close();
  });
});
