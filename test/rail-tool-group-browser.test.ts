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
      await page.locator('.rail-text-group').waitFor({ timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

describe.skipIf(!available)('the grouped Text, Table, Markdown block and Link rail choices', { timeout: 200_000 }, () => {
  it('opens from the chevron and ArrowRight, then remembers the chosen tool', async () => {
    const page = await openBoard();
    const group = page.locator('.rail-text-group');
    const flyout = page.locator('.rail-tool-pop');

    await page.locator('.rail-text-group .rail-group-chevron').click();
    expect(await flyout.isVisible()).toBe(true);
    expect(await page.getByRole('menuitem', { name: 'Text' }).getAttribute('aria-keyshortcuts')).toBe('T');
    expect(await page.getByRole('menuitem', { name: 'Markdown block' }).getAttribute('aria-keyshortcuts')).toBeNull();
    await page.getByRole('menuitem', { name: 'Markdown block' }).click();
    expect(await flyout.count()).toBe(0);
    expect(await group.getAttribute('data-tool')).toBe('markdown');
    expect(await group.getAttribute('aria-label')).toBe('Markdown block');
    expect(await group.getAttribute('aria-pressed')).toBe('true');
    expect(await group.getAttribute('class')).toContain(' on');
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('markdown');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('driftboard:rail-tool-group:text-markdown-link'))).toBe('markdown');

    await page.locator('.rail [data-tool="pen"]').click();
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('pen');
    await group.click();
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('markdown');
    expect(await group.getAttribute('aria-pressed')).toBe('true');

    await group.focus();
    await page.keyboard.press('ArrowRight');
    expect(await flyout.isVisible()).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    expect(await flyout.count()).toBe(0);
    expect(await group.getAttribute('data-tool')).toBe('text');
    expect(await group.getAttribute('aria-label')).toBe('Text');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('driftboard:rail-tool-group:text-markdown-link'))).toBe('text');

    await page.context().close();
  });

  it('puts the Table tool (key G) in the group: choosing it arms the table tool and the keycap shows', async () => {
    const page = await openBoard();
    await page.locator('.rail-text-group .rail-group-chevron').click();
    expect(await page.getByRole('menuitem', { name: 'Table' }).getAttribute('aria-keyshortcuts')).toBe('G');
    await page.getByRole('menuitem', { name: 'Table' }).click();
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('table');
    expect(await page.locator('.rail-text-group').getAttribute('aria-label')).toBe('Table');
    await page.close();
  });

  it('opens a menu with matching popup ARIA state and right-click', async () => {
    const page = await openBoard();
    const group = page.locator('.rail-text-group');
    const chevron = page.locator('.rail-text-group .rail-group-chevron');
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
    const group = page.locator('.rail-text-group');
    const flyout = page.locator('.rail-tool-pop');

    await page.locator('.rail-text-group .rail-group-chevron').click();
    await page.getByRole('menuitem', { name: 'Markdown block' }).click();
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

    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('markdown');
    await page.context().close();
  });

  it('opens Link from the flyout and keeps Connector as its own rail tool', async () => {
    const page = await openBoard();
    const group = page.locator('.rail-text-group');
    // Connector is the first choice of the Connectors and lines group (its own flyout and key: see the line tool test)
    const connector = page.locator('.rail-connector-group');

    expect(await connector.getAttribute('aria-label')).toBe('Connector');
    expect(await connector.getAttribute('aria-keyshortcuts')).toBe('L');
    await connector.click();
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('connector');

    await page.locator('.rail-text-group .rail-group-chevron').click();
    expect(await page.getByRole('menuitem', { name: 'Link' }).getAttribute('aria-keyshortcuts')).toBeNull();
    await page.getByRole('menuitem', { name: 'Link' }).click();
    const popover = page.locator('.link-popover');
    expect(await popover.isVisible()).toBe(true);
    const groupBox = (await group.boundingBox())!;
    const popoverBox = (await popover.boundingBox())!;
    expect(popoverBox.x).toBeGreaterThanOrEqual(groupBox.x + groupBox.width - 1);
    expect(await group.getAttribute('aria-label')).toBe('Link');
    expect(await group.getAttribute('data-tool')).toBeNull();
    expect(await group.getAttribute('aria-pressed')).toBe('false');
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('connector');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('driftboard:rail-tool-group:text-markdown-link'))).toBe('link');

    await popover.getByRole('button', { name: 'Cancel' }).click();
    expect(await group.getAttribute('class')).not.toContain(' on');
    await page.context().close();
  });

  it('disables the whole group on a read-only board, so Link cannot be added and no flyout opens', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}?debug#/b/rail-ro-${Math.random().toString(36).slice(2, 8)}`);
    await page.waitForFunction(() => (window as any).__board, null, { timeout: 25_000 });
    const group = page.locator('.rail-text-group');
    await group.waitFor({ timeout: 25_000 });
    await page.evaluate(() => { (window as any).__board.store.setReadOnly(true); });
    await expect.poll(() => group.isDisabled()).toBe(true);
    await group.focus().catch(() => undefined);
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('.rail-tool-pop').count()).toBe(0);
    expect(await page.locator('.link-popover').count()).toBe(0);
    await context.close();
  });

  it('fits all visible tools without rail scrolling at 720 and 820 px', async () => {
    const measurements = [];
    for (const [height, expectedButtonSize] of [[720, 28], [820, 36]] as const) {
      const page = await openBoard(height);
      const measure = await page.evaluate(() => {
        const rail = document.querySelector('.rail') as HTMLElement;
        const tools = document.querySelector('.rail-tools') as HTMLElement;
        const railBounds = rail.getBoundingClientRect();
        const bounds = tools.getBoundingClientRect();
        const buttons = [...tools.querySelectorAll<HTMLButtonElement>('button:not([hidden])')];
        return {
          finePointer: matchMedia('(pointer: fine)').matches,
          railHeight: railBounds.height,
          scrollHeight: tools.scrollHeight,
          clientHeight: tools.clientHeight,
          buttonHeight: buttons[0]?.getBoundingClientRect().height,
          buttonCount: buttons.length,
          buttonsInView: buttons.every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
          }),
        };
      });
      measurements.push({ height, expectedButtonSize, ...measure });
      await page.context().close();
    }
    expect(measurements.find((measure) => measure.height === 720)?.finePointer).toBe(true);
    for (const measure of measurements) {
      expect(measure.buttonHeight).toBe(measure.expectedButtonSize);
      expect(measure.scrollHeight - measure.clientHeight).toBeLessThanOrEqual(1);
      expect(measure.buttonsInView).toBe(true);
    }
  });
});
