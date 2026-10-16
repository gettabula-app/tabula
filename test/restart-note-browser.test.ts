import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// docs/cloud.md, Restart, in a real browser on a local board: the one note for a planned restart says how long is left, Dismiss
// hides it for that restart only, it fits a phone-width screen without scrolling sideways, it moves nothing on the board, and a
// keyboard user who dismisses it is not left on the body.

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

/**
 * main.ts mounts the note once, but keeps its handle to itself, so the test cannot drive that instance. This mounts a second one
 * on the body from the same modules, keeps its handle on window, and tags its element (the page then has two `.restart-note`s).
 * It is a string, so the dynamic imports are the browser's own and not the test runner's.
 */
async function mountNote(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    const { createRestartNotice } = await import('/src/restart-notice.ts');
    const { mountRestartNote } = await import('/src/ui/restart-note.ts');
    window.__restartNote = mountRestartNote(document.body, createRestartNotice());
    document.body.lastElementChild.setAttribute('data-test-note', '');
  })()`);
}

const workspace = (id: string, secondsLeft = 300) => ({ readOnly: false, banner: null, seatLimit: null, seatsUsed: 1, restart: { secondsLeft, id } });

/** Gives the page one /api/me answer, as main.ts would after a fresh read. */
async function answer(page: Page, value: ReturnType<typeof workspace>): Promise<void> {
  await page.evaluate((ws) => (window as unknown as { __restartNote: { update(w: unknown): void } }).__restartNote.update(ws), value);
}

const note = (page: Page) => page.locator('[data-test-note]');
const sentence = (page: Page) => page.locator('[data-test-note] .restart-note-text');
const dismissButton = (page: Page) => page.locator('[data-test-note] .restart-note-dismiss');

/** Two animation frames, so anything the board lays out on a change has landed before it is measured. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

describe.skipIf(!available)('the restart note in a real browser', { timeout: 240_000 }, () => {
  it('shows the sentence for a planned restart in a polite status region', async () => {
    const page = await openBoard();
    await mountNote(page);
    await answer(page, workspace('a'));
    const el = note(page);
    expect(await el.getAttribute('role')).toBe('status');
    expect(await el.getAttribute('aria-live')).toBe('polite');
    expect(await el.isVisible()).toBe(true);
    expect(await sentence(page).textContent()).toMatch(/^The server restarts in about 5 minutes\. /);
    await page.context().close();
  });

  it('Dismiss hides the note; the same restart stays hidden on the next answer; a new restart shows it again', async () => {
    const page = await openBoard();
    await mountNote(page);
    await answer(page, workspace('a'));
    await dismissButton(page).click();
    expect(await note(page).isHidden()).toBe(true);
    await answer(page, workspace('a', 290));
    expect(await note(page).isHidden()).toBe(true);
    await answer(page, workspace('b'));
    expect(await note(page).isVisible()).toBe(true);
    await page.context().close();
  });

  it('at 360 by 740 the page does not scroll sideways, and the note keeps a 12 px gutter on both sides', async () => {
    const page = await openBoard();
    await mountNote(page);
    await page.setViewportSize({ width: 360, height: 740 });
    await answer(page, workspace('a'));
    await settle(page);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const box = await note(page).boundingBox();
    expect(scrollWidth).toBeLessThanOrEqual(360);
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(12);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360 - 12);
    // the tool rail runs down the left edge on a phone: the note starts to the right of it
    const rail = await page.locator('.chrome > .rail').boundingBox();
    expect(rail).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(rail!.x + rail!.width);
    await page.context().close();
  });

  it('showing the note moves no part of the board and does not change the banner height the board reads', async () => {
    const page = await openBoard();
    await mountNote(page);
    await settle(page);
    const measure = () => page.evaluate(() => {
      const box = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      };
      const root = document.querySelector<HTMLElement>('.board-root');
      return {
        surface: box(document.querySelector('.board-surface')),
        canvas: box(document.querySelector('svg.canvas')),
        topLeft: box(document.querySelector('.chrome > .top-left')),
        bannerHeight: root ? getComputedStyle(root).getPropertyValue('--banner-h') : null,
      };
    });
    const before = await measure();
    await answer(page, workspace('a'));
    await settle(page);
    const after = await measure();
    expect(await note(page).isVisible()).toBe(true);
    expect(after).toEqual(before);
    await page.context().close();
  });

  it('after Dismiss from the keyboard, focus is on the board, not on the body', async () => {
    const page = await openBoard();
    await mountNote(page);
    await answer(page, workspace('a'));
    await dismissButton(page).focus();
    await page.keyboard.press('Enter');
    expect(await note(page).isHidden()).toBe(true);
    // Chromium moves focus off a control that has just become display:none at the next frame, so read it after one
    await settle(page);
    const focus = await page.evaluate(() => ({
      onBody: document.activeElement === document.body,
      onBoard: !!document.activeElement?.classList.contains('canvas-focus'),
    }));
    expect(focus.onBody).toBe(false);
    expect(focus.onBoard).toBe(true);
    await page.context().close();
  });
});
