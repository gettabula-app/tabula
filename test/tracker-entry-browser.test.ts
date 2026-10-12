import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// The full-screen tracker strip and its "..." menu, in a real browser: the back label by mode, the menu's contents by role,
// the theme switch (applies at once and is remembered), Esc and focus, and one row at 390 px.

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
  await warmUp();
}, 300_000);

/**
 * Makes vite compile and pre-bundle everything these tests import before any test starts. On a cold cache vite optimises
 * dependencies on the first request and reloads the page, which used to eat a test's whole time budget on a loaded machine; here
 * the cost is paid once, in the hook, and a reload only means asking again.
 */
/** A page with nothing in it: these tests mount one screen themselves, so they need not load the whole app (slow on a loaded machine). */
async function blankPage(options: Parameters<Browser['newPage']>[0] = {}): Promise<Page> {
  const page = await browser!.newPage(options);
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="app"></div>' }));
  await page.goto(`${base}__blank`);
  return page;
}

async function warmUp() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const page = await blankPage();
    try {
      await page.addScriptTag({
        type: 'module',
        content: `
          await Promise.all([
            import('/src/tracker/ui/shell.ts'), import('/src/tracker-data.ts'), import('/src/tracker-mock.ts'),
            import('/src/tracker/ui/visual-seed.ts'), import('/src/ui/topbar.ts'), import('/src/ui/home.css'),
          ]);
          window.__warm = true;
        `,
      });
      await page.waitForFunction(() => (window as unknown as { __warm?: boolean }).__warm === true, undefined, { timeout: 120_000 });
      await page.close();
      return;
    } catch {
      await page.close().catch(() => undefined);
    }
  }
  throw new Error('vite could not compile the tracker modules');
}

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type Mode = { routeMode?: boolean; role?: 'owner' | 'admin' | 'member'; mcp?: boolean; account?: boolean; width?: number };

async function openShell(mode: Mode = {}): Promise<Page> {
  // A page that reloads under the injected script (vite optimising a dependency late) is asked for again.
  for (let attempt = 0; ; attempt++) {
    try {
      return await tryOpenShell(mode, 60_000);
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

async function tryOpenShell({ routeMode = true, role = 'member', mcp = false, account = true, width = 1280 }: Mode, timeout: number): Promise<Page> {
  const page = await blankPage({ viewport: { width, height: 800 } });
  await page.evaluate(() => localStorage.clear());
  await page.addScriptTag({
    type: 'module',
    content: `
      import { mountTrackerShell } from '/src/tracker/ui/shell.ts';
      import { createTrackerStore } from '/src/tracker-data.ts';
      import { createMockTrackerApi } from '/src/tracker-mock.ts';
      import { createTrackerVisualSeed } from '/src/tracker/ui/visual-seed.ts';
      const api = createMockTrackerApi(createTrackerVisualSeed());
      const store = createTrackerStore(api, { isVisible: () => false });
      window.__boards = 0;
      const me = { user: { id: 'u1', name: 'Johan Saldes', email: 'johan@example.test', role: ${JSON.stringify(role)} }, teams: [], mcp: ${mcp}, mcpOauth: false, tracker: true };
      window.__trackerShell = mountTrackerShell(document.querySelector('#app'), {
        store, api, viewerId: 'entry', trackerId: 'tracker-demo', initialTab: 'all', fullScreen: true,
        routeMode: ${routeMode}, boardName: 'Tracker', account: ${account ? 'me' : 'null'}, layoutWidth: window.innerWidth,
        onBoards: () => { window.__boards++; },
      });
      await store.loadMeta();
    `,
  });
  try {
    await page.locator('.trk-fullscreen-strip').waitFor({ timeout });
  } catch (error) {
    await page.close();
    throw error;
  }
  return page;
}

const items = (page: Page) => page.locator('.trk-account-menu .menu-item, .trk-account-menu .trk-menu-name').allTextContents();

describe.skipIf(!available)('the tracker strip and menu in a browser', { timeout: 200_000 }, () => {
  it('route mode leads to Boards; opened from a tracker frame it keeps Back to board', async () => {
    const route = await openShell({ routeMode: true });
    expect(await route.locator('.trk-fullscreen-strip button').first().innerText()).toBe('‹ Boards');
    await route.locator('.trk-back-boards').click();
    expect(await route.evaluate(() => (window as unknown as { __boards: number }).__boards)).toBe(1);
    await route.close();

    const frame = await openShell({ routeMode: false });
    expect(await frame.locator('.trk-fullscreen-strip button').first().innerText()).toBe('Back to board');
    expect(await frame.locator('.trk-back-boards').count()).toBe(0);
    await frame.close();
  });

  it('has one 44 px Menu button with the menu attributes, and none without an account', async () => {
    const page = await openShell();
    const button = page.getByRole('button', { name: 'Menu', exact: true });
    expect(await button.getAttribute('aria-haspopup')).toBe('menu');
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    const box = (await button.boundingBox())!;
    expect(Math.round(box.width)).toBe(44);
    expect(Math.round(box.height)).toBe(44);
    // the same dots icon as the board menu, not text
    expect(await button.locator('svg').count()).toBe(1);
    expect((await button.textContent())?.trim()).toBe('');
    await page.close();

    const bare = await openShell({ account: false });
    expect(await bare.locator('.trk-menu-button').isHidden()).toBe(true);
    await bare.close();
  });

  it.each([
    ['member', false, ['Boards', 'Help', 'Sign out']],
    ['admin', false, ['Boards', 'Admin', 'Help', 'Sign out']],
    ['owner', true, ['Boards', 'Admin', 'AI tool access', 'Help', 'Sign out']],
  ] as const)('lists the right items for a %s', async (role, mcp, expected) => {
    const page = await openShell({ role, mcp });
    await page.locator('.trk-menu-button').click();
    const all = await items(page);
    const rows = all.filter((text) => !['Default', 'Ayu', 'Kanagawa', 'Matrix', 'Evergreen'].includes(text.trim()));
    expect(rows.map((t) => t.trim())).toEqual([...expected.slice(0, -1), 'Johan Saldes', 'Sign out']);
    expect(await page.locator('.trk-account-menu [role="radio"]').count()).toBe(5);
    await page.close();
  });

  it('Boards in the menu goes to the boards page', async () => {
    const page = await openShell();
    await page.locator('.trk-menu-button').click();
    await page.locator('.trk-account-menu .menu-item', { hasText: /^Boards$/ }).click();
    expect(await page.evaluate(() => (window as unknown as { __boards: number }).__boards)).toBe(1);
    await page.close();
  });

  it('changes the theme at once and remembers it', async () => {
    const page = await openShell();
    await page.locator('.trk-menu-button').click();
    await page.locator('.trk-account-menu [role="radio"]', { hasText: 'Kanagawa' }).click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('kanagawa');
    expect(await page.evaluate(() => localStorage.getItem('driftboard:theme'))).toBe('kanagawa');
    expect(await page.locator('.trk-account-menu [role="radio"][aria-checked="true"]').innerText()).toContain('Kanagawa');
    await page.close();
  });

  it('Escape closes the menu and returns focus to the button', async () => {
    const page = await openShell();
    const button = page.locator('.trk-menu-button');
    await button.focus();
    await page.keyboard.press('Enter');
    expect(await button.getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('.trk-account-menu').count()).toBe(1);
    await page.keyboard.press('Escape');
    expect(await page.locator('.trk-account-menu').count()).toBe(0);
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('trk-menu-button'))).toBe(true);
    await page.close();
  });

  it('keeps the strip on one row and the menu inside the window at 390 px', async () => {
    const page = await openShell({ width: 390 });
    const strip = (await page.locator('.trk-fullscreen-strip').boundingBox())!;
    expect(strip.height).toBeLessThan(60);
    const centres = await page.locator('.trk-fullscreen-strip > :not(.trk-strip-spacer)').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; }));
    expect(centres).toHaveLength(3);
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(4); // ‹ Boards, Tracker and the menu button share one row
    await page.locator('.trk-menu-button').click();
    const menu = (await page.locator('.trk-account-pop').boundingBox())!;
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(390);
    expect(menu.y + menu.height).toBeLessThanOrEqual(800);
    await page.close();
  });
});

describe.skipIf(!available)('the account menu of the Boards top bar in a browser', { timeout: 200_000 }, () => {
  async function openBar(mcp: boolean): Promise<Page> {
    for (let attempt = 0; ; attempt++) {
      const page = await blankPage({ viewport: { width: 1280, height: 800 } });
      await page.addScriptTag({
        type: 'module',
        content: `
          import '/src/ui/home.css'; // the top bar's own styles come with the home page, which this blank page does not load
          import { createTopbar } from '/src/ui/topbar.ts';
          const me = { user: { id: 'u1', name: 'Johan Saldes', email: 'johan@example.test', role: 'member' }, teams: [], mcp: ${mcp}, mcpOauth: false };
          const host = document.createElement('div'); host.id = 'entry-bar'; document.body.append(host); host.append(createTopbar('boards', me));
        `,
      });
      try {
        await page.locator('#entry-bar .topbar').waitFor({ timeout: attempt >= 2 ? 90_000 : 25_000 });
        return page;
      } catch (error) {
        await page.close();
        if (attempt >= 2) throw error;
      }
    }
  }

  it('has no AI tool access link and no Sign out button; the name opens the menu', async () => {
    const page = await openBar(true);
    expect(await page.locator('#entry-bar .topbar-nav').innerText()).not.toContain('AI tool access');
    expect(await page.locator('#entry-bar .topbar-end button', { hasText: /^Sign out$/ }).count()).toBe(0);
    const name = page.locator('#entry-bar .topbar-me-btn');
    expect(await name.getAttribute('aria-haspopup')).toBe('menu');
    expect(Math.round((await name.boundingBox())!.height)).toBeGreaterThanOrEqual(44); // a 44 px target with a caret
    await name.click();
    const rows = (await page.locator('.account-menu .menu-item').allTextContents()).map((t) => t.trim());
    expect(rows).toEqual(['Your name and colour', 'AI tool access', 'Sign out']);
    await page.close();
  });

  it('lists AI tool access exactly when the server has it', async () => {
    const page = await openBar(false);
    await page.locator('#entry-bar .topbar-me-btn').click();
    const rows = (await page.locator('.account-menu .menu-item').allTextContents()).map((t) => t.trim());
    expect(rows).toEqual(['Your name and colour', 'Sign out']);
    await page.close();
  });

  it('returns focus to the name button when the menu closes', async () => {
    const page = await openBar(true);
    const name = page.locator('#entry-bar .topbar-me-btn');
    await name.focus();
    await page.keyboard.press('Enter');
    expect(await page.locator('.account-menu').count()).toBe(1);
    await page.keyboard.press('Escape');
    expect(await page.locator('.account-menu').count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('topbar-me-btn'))).toBe(true);
    await page.close();
  });

  it('signs out from the menu', async () => {
    const page = await openBar(true);
    await page.route('**/api/auth/logout', (route) => route.fulfill({ status: 204, body: '' }));
    await page.locator('#entry-bar .topbar-me-btn').click();
    await page.locator('.account-menu .menu-item', { hasText: /^Sign out$/ }).click();
    await page.waitForFunction(() => location.hash === '#/signin');
    expect(await page.evaluate(() => location.hash)).toBe('#/signin');
    await page.close();
  });
});
