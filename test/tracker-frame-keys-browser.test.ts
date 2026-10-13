import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// A key pressed with focus inside the live tracker on a board belongs to the tracker, not to the board: Backspace or Delete on a
// ticket row must never delete the selected tracker frame, and Space must not start panning the canvas. Runs the visual-mode mock
// (?debug&trackerMock=board): the real frame and tracker UI over a seeded mock tracker.

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

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?debug&trackerMock=board#/b/trk-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board && (window as any).__trackerStore && [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'tracker'), null, { timeout: budget(30_000) });
  return page;
}

const frameId = (page: Page) => page.evaluate(() => [...(window as any).__board.store.cache.values()].find((o: any) => o.type === 'tracker').id as string);
const frameExists = (page: Page, id: string) => page.evaluate((i) => (window as any).__board.store.get(i) !== undefined, id);

async function enterWork(page: Page): Promise<string> {
  const id = await frameId(page);
  await page.evaluate((i) => (window as any).__board.setSelection([i]), id);
  await page.evaluate(() => (document.querySelector('.trk-frame-open') as HTMLButtonElement).click()); // the button only shows on hover or selection; the click is what matters
  await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.trk-frame-wrap.is-work .trk-tab')].find((t) => /All issues/.test(t.textContent ?? ''))?.click());
  await page.locator('.trk-frame-wrap.is-work .trk-list-row').first().waitFor();
  return id;
}

describe.skipIf(!available)('keys inside the live tracker on a board', { timeout: 200_000 }, () => {
  it('Backspace and Delete on a focused ticket row do not delete the selected tracker frame', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.evaluate(() => (document.querySelector('.trk-frame-wrap.is-work .trk-shell') as HTMLElement).focus()); // the shell takes the keys of its rows
    expect(await page.evaluate(() => document.activeElement?.closest('.trk') !== null)).toBe(true);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    expect(await frameExists(page, id)).toBe(true);
    await page.close();
  });

  it('a key typed inside the tracker is not a canvas shortcut (Space does not pan, a tool key does not switch the tool)', async () => {
    const page = await open();
    await enterWork(page);
    await page.evaluate(() => (document.querySelector('.trk-frame-wrap.is-work .trk-shell') as HTMLElement).focus()); // the shell takes the keys of its rows
    await page.keyboard.press('r');
    expect(await page.evaluate(() => (window as any).__board.tool.kind)).toBe('select');
    await page.keyboard.down('Space');
    expect(await page.evaluate(() => document.querySelector('svg.canvas')?.parentElement?.classList.contains('space') ?? false)).toBe(false);
    await page.keyboard.up('Space');
    await page.close();
  });

  it('a board that is read-only for this person shows the live tracker without New issue, and gives it back when the role allows', async () => {
    const page = await open();
    await enterWork(page);
    const newIssue = () => page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('.trk-frame-wrap.is-work .trk-new-trigger');
      return b ? !b.hidden : false;
    });
    expect(await newIssue()).toBe(true);
    await page.evaluate(() => (window as any).__board.store.setReadOnly(true));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.trk-frame-wrap.is-work .trk-new-trigger')?.hidden === true, null, { timeout: budget(10_000) });
    await page.evaluate(() => (window as any).__board.store.setReadOnly(false));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.trk-frame-wrap.is-work .trk-new-trigger')?.hidden === false, null, { timeout: budget(10_000) });
    await page.close();
  });
});
