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

async function openBoard(height = 844): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport: { width: 390, height } });
    const page = await context.newPage();
    try {
      await page.goto(base);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('menuitem', { name: 'Blank board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('button', { name: 'Menu' }).waitFor({ timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}


describe.skipIf(!available)('phone bottom sheets sit beside the tool rail, not under it', { timeout: 200_000 }, () => {
  it('starts the comments sheet to the right of the rail at 390 px', async () => {
    const page = await openBoard();
    await page.locator('.chrome > .rail').waitFor();
    await page.getByRole('button', { name: /comments/i }).first().click();
    await page.locator('.chrome > .side-tray').waitFor({ state: 'visible' });
    const { rail, sheet } = await page.evaluate(() => ({
      rail: document.querySelector('.chrome > .rail')!.getBoundingClientRect().right,
      sheet: document.querySelector('.chrome > .side-tray')!.getBoundingClientRect().left,
    }));
    expect(sheet).toBeGreaterThanOrEqual(rail);
  });
});
