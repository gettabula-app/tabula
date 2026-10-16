import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// TAB-407, in a real browser on a local board: Space presses the focused rail button (the Frame tool, for one) and Enter presses it too,
// while Space still pans the board when focus is on the canvas or on the page, and types a space in a text field.

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

async function openBoard(): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(`${base}?debug`);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: budget(attempt >= 2 ? 90_000 : 25_000) });
      await page.getByRole('menuitem', { name: 'Blank board' }).click({ timeout: budget(attempt >= 2 ? 90_000 : 25_000) });
      await page.waitForFunction(() => (window as unknown as { __board?: unknown }).__board, undefined, { timeout: budget(25_000) });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

/** Whether the board is panning: the surface carries the `space` class while Space is held. */
const panning = (page: Page) => page.evaluate(() => document.querySelector('.board-surface')?.classList.contains('space') ?? false);

const tool = (page: Page) => page.evaluate(() => (window as any).__board.tool.kind);

/** One sticky note, selected, so that Enter has an object to edit. */
async function selectOneSticky(page: Page) {
  await page.evaluate(() => {
    const app = (window as any).__board;
    app.store.transact(() => {
      app.store.create({ id: 'n-space', type: 'sticky', x: 0, y: 0, w: 160, h: 160, z: 'n-space', rotation: 0, text: 'Alpha', fill: '#FFE16B', updatedAt: 1 });
    });
    app.setSelection(['n-space']);
  });
  await page.waitForFunction(() => (window as any).__board.selection.length === 1, undefined, { timeout: budget(10_000) });
}

describe.skipIf(!available)('Space and Enter for the focused control', { timeout: 240_000 }, () => {
  it('Space presses the focused Frame button: the tool is picked on the release, and the board does not pan', async () => {
    const page = await openBoard();
    await page.locator('.rail-btn[aria-label="Frame"]').focus();
    await page.keyboard.down('Space');
    expect(await panning(page)).toBe(false);
    await page.keyboard.up('Space');
    await page.waitForFunction(() => (window as any).__board.tool.kind === 'frame', undefined, { timeout: budget(10_000) });
    expect(await tool(page)).toBe('frame');
    await page.context().close();
  });

  it('Space on the canvas, and with nothing focused, still pans the board while it is held', async () => {
    const page = await openBoard();
    await page.locator('.canvas-focus').focus();
    await page.keyboard.down('Space');
    expect(await panning(page)).toBe(true);
    await page.keyboard.up('Space');
    expect(await panning(page)).toBe(false);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down('Space');
    expect(await panning(page)).toBe(true);
    await page.keyboard.up('Space');
    expect(await panning(page)).toBe(false);
    await page.context().close();
  });

  it('Space in a text field types a space and does not pan', async () => {
    const page = await openBoard();
    const name = page.locator('input[aria-label="Board name"]');
    await name.fill('Plan');
    await name.focus();
    await page.keyboard.press('End');
    await page.keyboard.down('Space');
    expect(await panning(page)).toBe(false);
    await page.keyboard.up('Space');
    await page.keyboard.type('two');
    expect(await name.inputValue()).toBe('Plan two');
    await page.context().close();
  });

  it('Enter presses the focused Frame button, and does not start editing the selected object', async () => {
    const page = await openBoard();
    await selectOneSticky(page);
    await page.locator('.rail-btn[aria-label="Frame"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as any).__board.tool.kind === 'frame', undefined, { timeout: budget(10_000) });
    expect(await tool(page)).toBe('frame');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
    await page.context().close();
  });

  it('Enter on the canvas, with an object selected, still starts editing it', async () => {
    const page = await openBoard();
    await selectOneSticky(page);
    await page.locator('.canvas-focus').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, { timeout: budget(10_000) });
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
    await page.context().close();
  });
});
