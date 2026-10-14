import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The tracker element on a board, as its own mounted shell in a real browser: the header never overlaps at any element width, the
// list drops columns by width, the empty and no-ticket states read as the spec says, and the touch targets are 44px at a coarse
// pointer. The shell is mounted in element mode (what a board frame does) inside a host of the element's width.

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

/** A page with the app's styles and a mount function: `mountElement(width, { empty })` replaces the element shell. */
async function openElementPage(options: { touch?: boolean; viewportWidth?: number } = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser!.newContext({
    viewport: { width: options.viewportWidth ?? 1000, height: 800 },
    hasTouch: options.touch === true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?element-look`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import { mountTrackerShell } from '/src/tracker/ui/shell.ts';
      import { createTrackerStore } from '/src/tracker-data.ts';
      import { createMockTrackerApi } from '/src/tracker-mock.ts';
      import { createTrackerVisualSeed } from '/src/tracker/ui/visual-seed.ts';
      window.__elementSeed = createTrackerVisualSeed();
      window.__mountElement = async (width, empty = false) => {
        window.__shell?.destroy();
        document.querySelector('#element-host')?.remove();
        const host = document.createElement('div');
        host.id = 'element-host';
        host.style.cssText = 'position:relative;padding:20px;';
        document.body.appendChild(host);
        const seed = empty ? { ...window.__elementSeed, tickets: [] } : window.__elementSeed;
        const api = createMockTrackerApi(seed);
        const store = createTrackerStore(api, { isVisible: () => false });
        const card = document.createElement('div');
        card.style.cssText = 'position:relative;';
        host.appendChild(card);
        window.__shell = mountTrackerShell(card, {
          store, api, viewerId: 'element-look', trackerId: 'tracker-demo', windowId: 'element-look-1', element: true,
          initialTab: 'all', layoutWidth: width, boardName: 'Board',
          onOpenFullScreen: () => { window.__opened = (window.__opened || 0) + 1; },
        });
        window.__shell.el.style.width = width + 'px';
        window.__shell.el.style.height = '480px';
        await store.loadMeta();
      };
      window.__opened = 0;
    `,
  });
  await page.waitForFunction(() => typeof (window as any).__mountElement === 'function', null, { timeout: budget(60_000) });
  return { page, close: () => context.close() };
}

async function mountAt(page: Page, width: number, empty = false): Promise<void> {
  await page.evaluate(([w, e]) => (window as any).__mountElement(w, e), [width, empty] as const);
  await page.locator('.trk-element-header').waitFor();
}

/** The header's direct parts that are showing, with their boxes and the header's box. */
async function headerBoxes(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('.trk-element-header')!.getBoundingClientRect();
    const parts = [...document.querySelectorAll<HTMLElement>('.trk-element-header .trk-element-title, .trk-element-header .trk-element-switch, .trk-element-header .trk-element-back, .trk-element-header .trk-new-trigger, .trk-element-header .trk-element-expand, .trk-element-header .trk-element-menu-button')]
      .filter((el) => !el.hidden && el.offsetParent !== null && getComputedStyle(el).display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.className.split(' ').find((c) => c.startsWith('trk-')) ?? el.tagName, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      });
    return { header: { left: header.left, right: header.right, top: header.top, bottom: header.bottom, width: header.width, height: header.height }, parts };
  });
}

const WIDTHS = [240, 300, 360, 420, 480, 560, 720, 900] as const;

describe.skipIf(!available)('tracker element look in a real browser', { timeout: 300_000 }, () => {
  it('keeps every header part inside the header and clear of the others at each element width', async () => {
    const { page, close } = await openElementPage();
    try {
      for (const width of WIDTHS) {
        await mountAt(page, width);
        const { header, parts } = await headerBoxes(page);
        expect(parts.length, `parts at ${width}`).toBeGreaterThanOrEqual(2);
        for (const part of parts) {
          expect(part.left, `${part.name} left at ${width}`).toBeGreaterThanOrEqual(header.left - 0.5);
          expect(part.right, `${part.name} right at ${width}`).toBeLessThanOrEqual(header.right + 0.5);
          expect(part.height, `${part.name} height at ${width}`).toBeLessThanOrEqual(header.height + 0.5);
        }
        for (let i = 0; i < parts.length; i++) {
          for (let j = i + 1; j < parts.length; j++) {
            const a = parts[i], b = parts[j];
            const overlap = a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
            expect(overlap, `${a.name} overlaps ${b.name} at ${width}`).toBe(false);
          }
        }
      }
    } finally {
      await close();
    }
  });

  it('shows the workspace subtitle from 560px, the full New ticket label from 420px, and collapses the view switch under 360px', async () => {
    const { page, close } = await openElementPage();
    try {
      await mountAt(page, 560);
      expect(await page.locator('.trk-element-sub').isVisible()).toBe(true);
      expect((await page.locator('.trk-new-trigger').textContent())?.trim()).toBe('+ New ticket');
      await mountAt(page, 540);
      expect(await page.locator('.trk-element-sub').isVisible()).toBe(false);
      await mountAt(page, 400);
      expect((await page.locator('.trk-new-trigger').textContent())?.trim()).toBe('+');
      expect(await page.locator('.trk-new-trigger').getAttribute('aria-label')).toBe('New ticket');
      expect(await page.locator('.trk-element-switch').isVisible()).toBe(true);
      await mountAt(page, 340);
      expect(await page.locator('.trk-element-switch').isVisible()).toBe(false);
      await page.locator('.trk-element-menu-button').click();
      const items = await page.locator('.trk-element-menu [role="menuitem"]').allTextContents();
      expect(items).toEqual(['Copy link', 'View: All', 'View: My', 'View: Board']);
    } finally {
      await close();
    }
  });

  it('drops the key and priority columns under 560px, and the avatar under 420px', async () => {
    const { page, close } = await openElementPage();
    try {
      const columnsAt = async (width: number) => {
        await mountAt(page, width);
        await page.locator('.trk-list-row').first().waitFor();
        return page.evaluate(() => {
          const row = document.querySelector('.trk-list-row')!;
          return ['key', 'title', 'assignee', 'priority'].filter((name) => row.querySelector(`.trk-col-${name}`) !== null);
        });
      };
      expect(await columnsAt(720)).toEqual(['key', 'title', 'assignee', 'priority']);
      expect(await columnsAt(560)).toEqual(['key', 'title', 'assignee', 'priority']);
      expect(await columnsAt(480)).toEqual(['title', 'assignee']);
      expect(await columnsAt(420)).toEqual(['title', 'assignee']);
      expect(await columnsAt(400)).toEqual(['title']);
    } finally {
      await close();
    }
  });

  it('hides the view switch and says No tickets yet when the All view is empty, and offers New ticket', async () => {
    const { page, close } = await openElementPage();
    try {
      await mountAt(page, 560, true);
      await page.locator('.trk-element-empty h2').waitFor();
      expect(await page.locator('.trk-element-empty h2').textContent()).toBe('No tickets yet');
      expect(await page.locator('.trk-element-empty p').textContent()).toBe('Create the first ticket to track work here.');
      expect(await page.locator('.trk-element-switch').isVisible()).toBe(false);
      expect(await page.locator('.trk-element-create').textContent()).toBe('+ New ticket');
    } finally {
      await close();
    }
  });

  it('shows Back and the ticket key in place of the view switch while a ticket is open', async () => {
    const { page, close } = await openElementPage();
    try {
      await mountAt(page, 720);
      const key = await page.evaluate(() => (window as any).__elementSeed.tickets[0].key as string);
      await page.evaluate((k) => (window as any).__shell.setTicket(k), key);
      await page.locator('.trk-element-back').waitFor();
      expect(await page.locator('.trk-element-name').textContent()).toBe(key);
      expect(await page.locator('.trk-element-switch').isVisible()).toBe(false);
      await page.locator('.trk-element-back').click();
      await page.locator('.trk-element-switch').waitFor();
      expect(await page.locator('.trk-element-name').textContent()).toBe('Tracker');
    } finally {
      await close();
    }
  });

  it('titles the create dialog New ticket in the element, like its header button', async () => {
    const { page, close } = await openElementPage();
    try {
      await mountAt(page, 720);
      await page.locator('.trk-new-trigger').click();
      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor();
      expect(await dialog.locator('h2').textContent()).toBe('New ticket');
      expect(await dialog.getByRole('button', { name: 'Close New ticket' }).count()).toBe(1);
    } finally { await close(); }
  });

  it('opens full screen from the expand button and keeps the menu closed until asked', async () => {
    const { page, close } = await openElementPage();
    try {
      await mountAt(page, 720);
      expect(await page.locator('.trk-element-expand').getAttribute('aria-label')).toBe('Open full screen');
      expect(await page.locator('.trk-element-menu [role="menuitem"]').count()).toBe(0);
      await page.locator('.trk-element-expand').click();
      expect(await page.evaluate(() => (window as any).__opened)).toBe(1);
    } finally {
      await close();
    }
  });

  it('makes every header button at least 44px at a coarse pointer', async () => {
    const { page, close } = await openElementPage({ touch: true, viewportWidth: 1000 });
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] });
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      for (const width of [420, 560, 720] as const) {
        await mountAt(page, width);
        const sizes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.trk-element-header button, .trk-element-header .segmented button')]
          .filter((el) => !el.closest('[hidden]') && el.offsetParent !== null)
          .map((el) => ({ name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '', height: el.getBoundingClientRect().height })));
        expect(sizes.length).toBeGreaterThanOrEqual(2);
        for (const size of sizes) expect(size.height, `${size.name} at ${width}`).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await close();
    }
  });

  it('the board frame has no separate Open full screen text button; the element header has the icon button', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(budget(45_000));
    try {
      await page.goto(`${base}?debug&trackerMock=board#/b/trk-${Math.random().toString(36).slice(2, 8)}`);
      await page.waitForFunction(() => (window as any).__board && [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'tracker'), null, { timeout: budget(30_000) });
      const id = await page.evaluate(() => [...(window as any).__board.store.cache.values()].find((o: any) => o.type === 'tracker').id as string);
      await page.evaluate((i) => (window as any).__board.setSelection([i]), id);
      await page.locator('.trk-frame-wrap.is-work .trk-element-header').waitFor();
      expect(await page.locator('.trk-frame-expand').count()).toBe(0);
      expect(await page.locator('.trk-frame-wrap.is-work .trk-element-expand').getAttribute('aria-label')).toBe('Open full screen');
    } finally {
      await context.close();
    }
  });
});
