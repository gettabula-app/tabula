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
      await page.getByRole('button', { name: 'Menu' }).waitFor({ timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

describe.skipIf(!available)('the board menu and its search field', { timeout: 200_000 }, () => {
  it('opens with no list showing, opens Export on hover and ArrowRight, and closes on Esc', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Menu' }).click();
    const menu = page.locator('.board-menu');
    await menu.waitFor();
    expect(await page.locator('.board-export-submenu').isVisible()).toBe(false);
    expect(await page.locator('.board-theme-submenu').isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('board-menu-search-input'))).toBe(true);

    const trigger = menu.locator('.board-menu-sub-trigger').first();
    await trigger.hover();
    await page.locator('.board-export-submenu').waitFor({ state: 'visible' });
    // attached to the menu's edge and level with its row
    const place = await page.evaluate(() => {
      const m = document.querySelector('.board-menu')!.getBoundingClientRect();
      const p = document.querySelector('.board-export-submenu')!.getBoundingClientRect();
      const t = document.querySelector('.board-menu-sub-trigger')!.getBoundingClientRect();
      return { gap: Math.min(Math.abs(p.left - m.right), Math.abs(m.left - p.right)), offset: Math.abs(p.top - t.top) };
    });
    expect(place.gap).toBeLessThanOrEqual(4);
    expect(place.offset).toBeLessThanOrEqual(12);
    // no label or hint is cut
    const cut = await page.evaluate(() => [...document.querySelectorAll('.board-export-submenu :is(.menu-hint, .board-menu-label)')].filter((el) => el.scrollWidth > el.clientWidth + 1).length);
    expect(cut).toBe(0);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Menu' }).click();
    await menu.waitFor();
    await menu.locator('.board-menu-sub-trigger').nth(1).focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('.board-theme-submenu').waitFor({ state: 'visible' });
  });

  it('keeps Export open when a click lands on the row the pointer rested on, and a second click closes it', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Menu' }).click();
    const menu = page.locator('.board-menu');
    await menu.waitFor();
    const trigger = menu.locator('.board-menu-sub-trigger').first();
    await trigger.hover();
    await page.locator('.board-export-submenu').waitFor({ state: 'visible' });
    await trigger.click();
    await page.waitForTimeout(300);
    expect(await page.locator('.board-export-submenu').isVisible()).toBe(true);
    expect(await trigger.getAttribute('aria-expanded')).toBe('true');
    // focus moved into the list, so the keyboard carries on from there
    expect(await page.evaluate(() => !!document.activeElement?.closest('.board-export-submenu'))).toBe(true);
    await trigger.click();
    await page.waitForTimeout(300);
    expect(await page.locator('.board-export-submenu').isVisible()).toBe(false);
  });

  it('closes on the first Esc from an empty search and clears a typed one first', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Menu' }).click();
    const menu = page.locator('.board-menu');
    await menu.waitFor();
    await page.keyboard.type('exp');
    await page.keyboard.press('Escape');
    expect(await page.locator('.board-menu-search-input').inputValue()).toBe('');
    expect(await menu.isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
  });

  it('draws the focus on the search wrapper only, not on the input inside it', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('.board-menu').waitFor();
    const look = await page.evaluate(() => {
      const input = document.querySelector('.board-menu-search-input') as HTMLElement;
      const wrap = input.closest('.board-menu-search') as HTMLElement;
      input.focus();
      const i = getComputedStyle(input);
      const w = getComputedStyle(wrap);
      return { inputOutline: i.outlineStyle, inputShadow: i.boxShadow, wrapShadow: w.boxShadow, wrapOutline: w.outlineStyle, wrapOutlineWidth: w.outlineWidth };
    });
    expect(look.inputOutline).toBe('none');
    expect(look.inputShadow).toBe('none');
    // the ring is the wrapper's 2px outline; the wrapper draws no box-shadow ring of its own
    expect(look.wrapOutline).toBe('solid');
    expect(look.wrapOutlineWidth).toBe('2px');
    expect(look.wrapShadow).toBe('none');
  });
});

describe.skipIf(!available)('the emoji picker search', { timeout: 200_000 }, () => {
  it('lists matches under Emoji, shows an empty state, and keeps the search ring to the field', async () => {
    const page = await openBoard(560);
    await page.keyboard.press('n');
    await page.mouse.click(640, 280);
    await page.getByRole('button', { name: 'Add emoji' }).click();
    const pop = page.locator('.emoji-pop');
    await pop.waitFor();
    const search = page.getByLabel('Search emoji');
    for (const [query, min] of [['smile', 1], ['happy', 1], ['heart', 1], ['thumbs', 1]] as const) {
      await search.fill(query);
      await page.waitForFunction((n) => document.querySelectorAll('.emoji-pop .emoji-cell').length >= n, min);
      expect(await pop.locator('.list-label').allTextContents()).toEqual(['Emoji']);
      // the results are inside the panel, scrollable if it is short
      const inside = await page.evaluate(() => {
        const box = document.querySelector('.emoji-pop')!.getBoundingClientRect();
        const cell = document.querySelector('.emoji-pop .emoji-cell')!.getBoundingClientRect();
        return cell.bottom <= box.bottom + 1 && cell.top >= box.top - 1;
      });
      expect(inside).toBe(true);
    }
    await search.fill('zzzzqq');
    await pop.getByText('No emoji found').waitFor();
    await search.focus();
    const look = await search.evaluate((el) => ({ outline: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth, shadow: getComputedStyle(el).boxShadow }));
    // one ring: the shared field focus is the field's own 2px outline, with no box-shadow ring under it
    expect(look.outline).toBe('solid');
    expect(look.width).toBe('2px');
    expect(look.shadow).toBe('none');
  });
});
