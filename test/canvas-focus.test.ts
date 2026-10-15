import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// docs/canvas-keyboard.md, slice 1, in a real browser on a local board: the canvas is one tab stop with an outline of the objects
// in reading order, arrows and Page keys move the current object without changing the board, the picture is hidden from
// assistive technology, and Tab leaves.

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
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('menuitem', { name: 'Blank board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.waitForFunction(() => (window as unknown as { __board?: unknown }).__board, undefined, { timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

/** Four notes in two rows, one frame around the second row's notes' neighbour is not needed: a plain grid. */
async function seed(page: Page) {
  await page.evaluate(() => {
    const app = (window as unknown as { __board: { store: { transact(fn: () => void): void; create(o: unknown): void }; selection: string[]; setSelection(ids: string[]): void } }).__board;
    const note = (id: string, x: number, y: number, text: string) => ({ id, type: 'sticky', x, y, w: 160, h: 160, z: id, rotation: 0, text, fill: '#FFE16B', updatedAt: 1 });
    app.store.transact(() => {
      app.store.create(note('n-a', 0, 0, 'Alpha'));
      app.store.create(note('n-b', 300, 0, 'Beta'));
      app.store.create(note('n-c', 0, 300, 'Gamma'));
      app.store.create(note('n-d', 300, 300, 'Delta'));
    });
    app.setSelection([]);
  });
  await page.waitForFunction(() => document.querySelectorAll('.canvas-outline [role="option"]').length === 4);
}

const current = (page: Page) => page.evaluate(() => {
  const id = document.querySelector('.canvas-focus')?.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent ?? null : null;
});

describe.skipIf(!available)('the canvas for the keyboard', { timeout: 240_000 }, () => {
  it('is one labelled tab stop with the picture hidden from assistive technology and an outline of the objects in reading order', async () => {
    const page = await openBoard();
    await seed(page);
    const target = page.locator('.canvas-focus');
    expect(await target.getAttribute('role')).toBe('application');
    expect(await target.getAttribute('aria-label')).toBe('Whiteboard, 4 objects');
    expect(await page.locator('svg.canvas').getAttribute('aria-hidden')).toBe('true');
    const names = await page.locator('.canvas-outline [role="option"]').allTextContents();
    expect(names).toEqual(['Sticky note, yellow, "Alpha"', 'Sticky note, yellow, "Beta"', 'Sticky note, yellow, "Gamma"', 'Sticky note, yellow, "Delta"']);
    const positions = await page.locator('.canvas-outline [role="option"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-posinset')}/${e.getAttribute('aria-setsize')}`));
    expect(positions).toEqual(['1/4', '2/4', '3/4', '4/4']);
    await page.context().close();
  });

  it('arrows move to the nearest object, Page keys read in order, Home and End go to the ends, and the board does not change', async () => {
    const page = await openBoard();
    await seed(page);
    const before = await page.evaluate(() => JSON.stringify([...(window as unknown as { __board: { store: { cache: Map<string, unknown> } } }).__board.store.cache.values()]));
    await page.locator('.canvas-focus').focus();
    expect(await current(page)).toContain('Alpha'); // the first object, nearest the middle of the view or first read
    await page.keyboard.press('ArrowRight');
    expect(await current(page)).toContain('Beta');
    await page.keyboard.press('ArrowDown');
    expect(await current(page)).toContain('Delta');
    await page.keyboard.press('ArrowLeft');
    expect(await current(page)).toContain('Gamma');
    await page.keyboard.press('PageUp');
    expect(await current(page)).toContain('Beta');
    await page.keyboard.press('End');
    expect(await current(page)).toContain('Delta');
    await page.keyboard.press('Home');
    expect(await current(page)).toContain('Alpha');
    await page.keyboard.press('ArrowUp'); // an edge
    expect(await current(page)).toContain('Alpha');
    const after = await page.evaluate(() => JSON.stringify([...(window as unknown as { __board: { store: { cache: Map<string, unknown> } } }).__board.store.cache.values()]));
    expect(after).toBe(before);
    await page.context().close();
  });

  it('shows the ring on the current object for the keyboard only, and Esc lets go of it', async () => {
    const page = await openBoard();
    await seed(page);
    await page.locator('.canvas-focus').focus();
    await page.keyboard.press('ArrowRight');
    const ring = page.locator('.canvas-ring');
    expect(await ring.isVisible()).toBe(true);
    const box = (await ring.boundingBox())!;
    expect(box.width).toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    expect(await ring.isHidden()).toBe(true);
    expect(await page.locator('.canvas-focus').getAttribute('aria-activedescendant')).toBeNull();
    await page.context().close();
  });

  it('puts the ring away on a mouse press, and keeps it out of the SVG, the SVG export and print', async () => {
    const page = await openBoard();
    await seed(page);
    await page.locator('.canvas-focus').focus();
    await page.keyboard.press('ArrowRight');
    const ring = page.locator('.canvas-ring');
    expect(await ring.isVisible()).toBe(true);
    expect(await page.evaluate(() => !!document.querySelector('.canvas-ring')!.closest('svg'))).toBe(false);
    expect(await page.evaluate(() => document.querySelector('svg.canvas')!.outerHTML.includes('canvas-ring'))).toBe(false);
    // a string, so the dynamic import is the browser's own and not the test runner's
    const exported = await page.evaluate<string>(`(async () => { const m = await import('/src/exporters.ts'); return m.exportSvgFile(window.__board); })()`);
    expect(exported).toContain('<svg');
    expect(exported).not.toContain('canvas-ring');
    expect(exported).not.toContain('canvas-outline');
    await page.emulateMedia({ media: 'print' });
    expect(await ring.isHidden()).toBe(true);
    await page.emulateMedia({ media: 'screen' });
    await page.mouse.move(900, 600);
    await page.mouse.down();
    await page.mouse.up();
    expect(await ring.isHidden()).toBe(true);
    await page.context().close();
  });

  it('a selected current object keeps its arrow-key nudge', async () => {
    const page = await openBoard();
    await seed(page);
    await page.locator('.canvas-focus').focus();
    await page.keyboard.press('ArrowRight'); // Beta is current
    await page.evaluate(() => (window as unknown as { __board: { setSelection(ids: string[]): void } }).__board.setSelection(['n-b']));
    const x = () => page.evaluate(() => (window as unknown as { __board: { store: { get(id: string): { x: number } } } }).__board.store.get('n-b').x);
    const before = await x();
    await page.keyboard.press('ArrowRight');
    expect(await x()).toBe(before + 1);
    expect(await current(page)).toContain('Beta');
    await page.context().close();
  });

  it('Tab leaves the whiteboard', async () => {
    const page = await openBoard();
    await seed(page);
    await page.locator('.canvas-focus').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('canvas-focus'))).toBe(false);
    await page.context().close();
  });
});
