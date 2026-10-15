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

async function openBoard(height = 900): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport: { width: 1280, height } });
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

const SCAN = () => [...document.querySelectorAll('.segmented')].map((group) => {
  const g = getComputedStyle(group);
  const buttons = [...group.querySelectorAll('button')].map((b) => {
    const c = getComputedStyle(b);
    return { border: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth].join(' '), radius: c.borderTopLeftRadius, transform: c.textTransform };
  });
  return { padding: parseFloat(g.paddingTop), radius: parseFloat(g.borderTopLeftRadius), border: g.borderTopWidth, buttons };
});

describe.skipIf(!available)('every segmented control has one anatomy', { timeout: 200_000 }, () => {
  it('has a container with no border of its own, borderless buttons with one radius, and no upper-casing', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Stickers' }).click();
    await page.locator('.sticker-sets .segmented').first().waitFor();
    const groups = await page.evaluate(SCAN);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.border).toBe('0px');
      for (const button of group.buttons) {
        expect(button.border).toBe('0px 0px 0px 0px');
        expect(button.transform).toBe('none');
      }
      expect(new Set(group.buttons.map((button) => button.radius)).size).toBe(1);
      // concentric: the container's radius is the thumb's plus a little, never smaller
      expect(group.radius).toBeGreaterThanOrEqual(parseFloat(group.buttons[0].radius));
    }
  });
});
