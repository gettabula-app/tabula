import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// The Save version dialog in version history: Enter saves once and closes; it never opens a second, empty dialog (the Enter that closed it
// used to press the Save version button again). Esc and the Cancel button close it without saving. The versions API is answered by the test.

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

async function openHistory(): Promise<{ page: Page; saves: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const saves: string[] = [];
  await page.route('**/api/boards/*/versions', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      saves.push(JSON.parse(request.postData() ?? '{}').label);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'v1', kind: 'named', label: saves[saves.length - 1], at: Date.now(), by: 'Me' }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ versions: [] }) });
    }
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'New board' }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Menu' }).click({ timeout: 25_000 });
  await page.locator('.board-menu .menu-item', { hasText: 'Version history' }).click();
  await page.getByRole('button', { name: 'Save version' }).waitFor();
  await page.waitForFunction(() => !(document.querySelector('.history-btn.primary') as HTMLButtonElement | null)?.disabled);
  return { page, saves };
}

const dialogs = (page: Page) => page.locator('.modal-back:has(input[aria-label="Version name"])').count();

describe.skipIf(!available)('Save version in version history', { timeout: 120_000 }, () => {
  it('saves once on Enter and closes, without opening a second dialog', async () => {
    const { page, saves } = await openHistory();
    await page.getByRole('button', { name: 'Save version' }).click();
    const input = page.getByLabel('Version name');
    await input.fill('Before the workshop');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    expect(saves).toEqual(['Before the workshop']);
    expect(await dialogs(page)).toBe(0);
    await page.context().close();
  });

  it('closes on Esc and on Cancel without saving, and an empty name does not save', async () => {
    const { page, saves } = await openHistory();
    await page.getByRole('button', { name: 'Save version' }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Version name'); // the dialog moves focus a frame after it opens
    await page.keyboard.press('Enter'); // empty: stays open
    expect(await dialogs(page)).toBe(1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    expect(await dialogs(page)).toBe(0);
    await page.getByRole('button', { name: 'Save version' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(400);
    expect(await dialogs(page)).toBe(0);
    expect(saves).toEqual([]);
    await page.context().close();
  });
});
