import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (!available) return;
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.cache/dialog-controls-browser', logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port');
  base = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync('.cache/dialog-controls-browser', { recursive: true, force: true });
});

async function openBoard(theme: 'default' | 'evergreen'): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript((id) => localStorage.setItem('driftboard:theme', id), theme);
  await page.goto(base);
  await page.getByRole('button', { name: 'New board' }).click({ timeout: 60_000 });
  await page.getByRole('menuitem', { name: 'Blank board' }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Menu' }).waitFor({ timeout: 30_000 });
  return page;
}

async function controlLook(input: Locator) {
  return input.evaluate((element) => {
    const style = getComputedStyle(element);
    return { appearance: style.appearance, width: style.width, height: style.height, fill: style.backgroundColor };
  });
}

async function contrastOnPage(page: Page, foregroundSelector: string, backgroundSelector: string): Promise<number> {
  return page.evaluate(({ foregroundSelector, backgroundSelector }) => {
    const foreground = getComputedStyle(document.querySelector(foregroundSelector)!).backgroundColor;
    const background = getComputedStyle(document.querySelector(backgroundSelector)!).backgroundColor;
    const pixel = (color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => value / 255);
    };
    const luminance = (color: string) => pixel(color).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  }, { foregroundSelector, backgroundSelector });
}

describe.skipIf(!available)('dialog control styles in Chromium', { timeout: 240_000 }, () => {
  it.each(['default', 'evergreen'] as const)('%s: quick poll and Print use the shared checkbox and field styles', async (theme) => {
    const page = await openBoard(theme);
    try {
      await page.getByRole('button', { name: 'Start a quick poll' }).click();
      const quick = page.locator('.poll-pop');
      await quick.waitFor();
      const multi = page.getByRole('checkbox', { name: 'More than one answer' });
      await multi.check();
      expect(await multi.isChecked()).toBe(true);
      const checked = await controlLook(multi);
      expect(checked.appearance).toBe('none');
      expect(checked.width).toBe('16px');
      expect(checked.height).toBe('16px');
      expect(checked.fill).not.toBe('rgba(0, 0, 0, 0)');

      const fieldHeights = await page.evaluate(() => [
        getComputedStyle(document.querySelector('.poll-pop input[aria-label="Question"]')!).height,
        getComputedStyle(document.querySelector('.poll-pop .poll-compose-options .input')!).height,
      ]);
      expect(fieldHeights).toEqual(['34px', '34px']);
      expect(await contrastOnPage(page, '.poll-pop .btn.primary', '.poll-pop')).toBeGreaterThanOrEqual(3);

      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await page.getByRole('button', { name: /Print or save as PDF/ }).click();
      const print = page.getByRole('dialog', { name: 'Print or save as PDF' });
      await print.waitFor();
      const printControl = await controlLook(page.locator('.modal input[type="checkbox"]').first());
      expect(printControl.appearance).toBe('none');
      expect(printControl.width).toBe('16px');
      expect(printControl.height).toBe('16px');
      expect(printControl.fill).not.toBe('rgba(0, 0, 0, 0)');
    } finally {
      await page.context().close();
    }
  });
});

describe.skipIf(!available)('switch targets', { timeout: 120_000 }, () => {
  it.each([[false, 24], [true, 44]])('a switch button is at least 24px (44px on touch): touch %s -> %s', async (touch, minimum) => {
    const context = await browser!.newContext({ viewport: { width: 700, height: 400 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><div id="app"></div>' }));
    await page.goto(`${base}__blank`);
    await page.addScriptTag({
      type: 'module',
      content: `
        import '/src/styles.css'; import '/src/ui/link-previews-admin.css';
        document.getElementById('app').innerHTML = '<button class="lp-switch" role="switch" aria-checked="true" aria-label="Link previews"></button><label class="check"><input type="checkbox" role="switch" checked><span>Notify me</span></label>';
        window.__ready = true;
      `,
    });
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 60_000 });
    const button = await page.locator('.lp-switch').boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(minimum);
    expect(button!.width).toBeGreaterThanOrEqual(touch ? 44 : 28);
    // a switch input is reached through its label row, which is the target
    const row = await page.locator('label.check').boundingBox();
    expect(row!.height).toBeGreaterThanOrEqual(touch ? 44 : 24);
    await context.close();
  });
});
