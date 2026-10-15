import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// The tool rail in a short window, in a real browser on a local board: it compresses on a mouse, it says out loud that it
// scrolls (chevron and track), every tool is reachable by keyboard, and a tall window shows none of it.

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

async function openBoard(height: number, hasTouch = false): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport: { width: 1280, height }, hasTouch, isMobile: false });
    const page = await context.newPage();
    try {
      await page.goto(base);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('menuitem', { name: 'Blank board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.locator('.rail').waitFor({ timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

const inView = (page: Page, label: string) => page.evaluate((name) => {
  const tools = document.querySelector('.rail-tools') as HTMLElement;
  const button = [...tools.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)!;
  const t = tools.getBoundingClientRect();
  const b = button.getBoundingClientRect();
  return b.top >= t.top - 1 && b.bottom <= t.bottom + 1;
}, label);

describe.skipIf(!available)('the tool rail in a short window', { timeout: 200_000 }, () => {
  it('shows no chevron or track when everything fits', async () => {
    const page = await openBoard(1100);
    expect(await page.locator('.rail-more').isHidden()).toBe(true);
    expect(await page.locator('.rail-track').isHidden()).toBe(true);
    await page.context().close();
  });

  it('compresses on a mouse at 720 px high: 28 px tools, 18 px icons, and does not scroll', async () => {
    const page = await openBoard(720);
    const box = (await page.locator('.rail-tools .rail-btn').first().boundingBox())!;
    expect(Math.round(box.width)).toBe(28);
    expect(Math.round(box.height)).toBe(28);
    expect(await page.locator('.rail-more').isHidden()).toBe(true);
    expect(await page.evaluate(() => { const t = document.querySelector('.rail-tools') as HTMLElement; return t.scrollHeight - t.clientHeight; })).toBeLessThanOrEqual(1);
    const icon = (await page.locator('.rail-tools .rail-btn svg').first().boundingBox())!;
    expect(Math.round(icon.width)).toBe(18);
    await page.context().close();
  });

  it('keeps the larger targets on touch', async () => {
    const page = await openBoard(560, true);
    expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(false);
    const box = (await page.locator('.rail-tools .rail-btn').first().boundingBox())!;
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(34);
    await page.context().close();
  });

  it('at 560 px high shows the chevron and track, scrolls by a page, and flips at the end', async () => {
    const page = await openBoard(560);
    const chevron = page.locator('.rail-more');
    expect(await chevron.isVisible()).toBe(true);
    expect(await chevron.getAttribute('aria-label')).toBe('Scroll tools down');
    const box = (await chevron.boundingBox())!;
    expect(Math.round(box.height)).toBe(28);
    const track = (await page.locator('.rail-track').boundingBox())!;
    expect(Math.round(track.width)).toBe(2);
    // pinned between the tools and Undo/Redo
    const tools = (await page.locator('.rail-tools').boundingBox())!;
    const undo = (await page.getByRole('button', { name: 'Undo', exact: true }).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(tools.y + tools.height - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(undo.y + 1);

    const before = await page.evaluate(() => (document.querySelector('.rail-tools') as HTMLElement).scrollTop);
    await chevron.click();
    await page.waitForFunction((from) => (document.querySelector('.rail-tools') as HTMLElement).scrollTop > from + 20, before);
    for (let i = 0; i < 6 && (await chevron.getAttribute('data-dir')) === 'down'; i++) {
      await chevron.click();
      await page.waitForTimeout(450);
    }
    expect(await chevron.getAttribute('aria-label')).toBe('Scroll tools up');
    expect(await inView(page, 'Start a quick poll')).toBe(true);
    await chevron.click();
    await page.waitForFunction(() => (document.querySelector('.rail-more') as HTMLElement).dataset.dir === 'down' || (document.querySelector('.rail-tools') as HTMLElement).scrollTop < 5);
    await page.context().close();
  });

  it('scrolls to Layers (and Vote and Poll) when Tab moves through the rail at 560 px high', async () => {
    const page = await openBoard(560);
    await page.locator('.rail-tools button').first().focus();
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const label = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
      seen.push(label);
      if (label === 'Start a quick poll') break;
    }
    expect(seen).toContain('Layers');
    expect(seen).toContain('Start a dot vote');
    expect(seen).toContain('Start a quick poll');
    await page.waitForFunction(() => {
      const tools = document.querySelector('.rail-tools') as HTMLElement;
      const poll = tools.querySelector('[aria-label="Start a quick poll"]') as HTMLElement;
      return poll.getBoundingClientRect().bottom <= tools.getBoundingClientRect().bottom + 1; // the scroll to a focused tool is smooth
    });
    await page.context().close();
  });
});
