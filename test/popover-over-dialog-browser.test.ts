import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// TAB-405, in a real browser on a local board: a popover opened from inside a dialog is drawn above that dialog. The font pickers
// in Board settings (Heading font, Body font) are the case that broke (they sat under the modal); the colour list opened from the
// Labels dialog is the second dialog with a popover. A row click picks and closes only the popover; Esc closes the popover, leaves
// the dialog open and gives focus back to the control that opened it; Tab stays inside the popover.

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

type Board = { store: { getMeta(): { headingFont?: string; bodyFont?: string } }; createKanban(at: { x: number; y: number }): string | null; setSelection(ids: string[]): void };
const meta =(page: Page, key: 'headingFont' | 'bodyFont') => page.evaluate((k) => (window as unknown as { __board: Board }).__board.store.getMeta()[k], key);

/** Board settings, from the board's own menu (the visible 'Board settings' row). */
async function openBoardSettings(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 25_000 });
  await page.locator('.board-menu .menu-item[data-menu-label="Board settings"]').click({ timeout: 25_000 });
  await page.locator('.modal-back').waitFor({ timeout: 25_000 });
}

const FONT_POPOVER = '.popover:has(> .font-picker)';
const DIALOG = '.modal-back';

/** Opens a font picker from its field in Board settings. Returns the button it opened from. */
async function openFontPicker(page: Page, label: 'Heading font' | 'Body font') {
  const button = page.locator('.modal-back .field', { has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.font-btn');
  await button.click({ timeout: 25_000 });
  await page.locator(FONT_POPOVER).waitFor({ timeout: 25_000 });
  return button;
}

type Stacking = { popZ: number; dialogZ: number; onTop: boolean; atCentre: string | null };

/** What is drawn at the centre of the popover, and the two stacking levels, read in one step. */
async function stacking(page: Page, popover: string, dialog: string): Promise<Stacking> {
  return page.evaluate(({ popover, dialog }) => {
    const p = document.querySelector<HTMLElement>(popover);
    const d = document.querySelector<HTMLElement>(dialog);
    if (!p || !d) return { popZ: NaN, dialogZ: NaN, onTop: false, atCentre: null };
    const r = p.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      popZ: Number(getComputedStyle(p).zIndex),
      dialogZ: Number(getComputedStyle(d).zIndex),
      onTop: !!hit && p.contains(hit),
      atCentre: hit ? `${hit.tagName.toLowerCase()}.${hit.getAttribute('class') ?? ''}` : null,
    };
  }, { popover, dialog });
}

/** The popover is the element at its own centre, and it sits above the dialog. Polled: the popover is placed again when its list loads. */
async function expectOnTop(page: Page, popover: string, dialog: string) {
  await expect.poll(async () => (await stacking(page, popover, dialog)).onTop, { timeout: 25_000 }).toBe(true);
  const s = await stacking(page, popover, dialog);
  expect(s.popZ).toBeGreaterThan(s.dialogZ);
  return s;
}

/** Picks a row that is not the current font (and not the system font), with a real mouse click. */
async function pickOtherFont(page: Page, button: Locator, popover: string) {
  const current = await button.locator('.font-name').textContent();
  const rows = page.locator(`${popover} .font-row`);
  const names = await rows.locator('.font-name').allTextContents();
  const index = names.findIndex((name) => name !== current && name !== 'System font');
  expect(index).toBeGreaterThan(0);
  // Playwright's click is a real mouse press and release at the row's centre; it first checks that the row is what is drawn there
  await rows.nth(index).click({ timeout: 25_000 });
  return { picked: names[index], current };
}

describe.skipIf(!available)('popovers opened from a dialog', { timeout: 240_000 }, () => {
  it('Heading font: the picker is drawn above Board settings, and a row click picks the font and closes only the picker', async () => {
    const page = await openBoard();
    await openBoardSettings(page);
    const button = await openFontPicker(page, 'Heading font');
    await expectOnTop(page, FONT_POPOVER, DIALOG);
    const before = await meta(page, 'headingFont');
    const { picked } = await pickOtherFont(page, button, FONT_POPOVER);
    await page.locator(FONT_POPOVER).waitFor({ state: 'detached', timeout: 25_000 });
    expect(await page.locator(DIALOG).count()).toBe(1);
    expect(await button.locator('.font-name').textContent()).toBe(picked);
    expect(await meta(page, 'headingFont')).not.toBe(before);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('font-btn'))).toBe(true);
    await page.context().close();
  });

  it('Body font: the picker is drawn above Board settings, and a row click picks the font and closes only the picker', async () => {
    const page = await openBoard();
    await openBoardSettings(page);
    const button = await openFontPicker(page, 'Body font');
    await expectOnTop(page, FONT_POPOVER, DIALOG);
    const before = await meta(page, 'bodyFont');
    const { picked } = await pickOtherFont(page, button, FONT_POPOVER);
    await page.locator(FONT_POPOVER).waitFor({ state: 'detached', timeout: 25_000 });
    expect(await page.locator(DIALOG).count()).toBe(1);
    expect(await button.locator('.font-name').textContent()).toBe(picked);
    expect(await meta(page, 'bodyFont')).not.toBe(before);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('font-btn'))).toBe(true);
    await page.context().close();
  });

  it('Esc closes the picker, leaves Board settings open with focus on the font button, and a second Esc closes Board settings', async () => {
    const page = await openBoard();
    await openBoardSettings(page);
    const button = await openFontPicker(page, 'Heading font');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.popover'))).toBe(true);
    await page.keyboard.press('Escape');
    // the picker's Esc handler stops the event before the dialog's, and it runs inside the key press, so the wait is on the picker only
    await page.locator(FONT_POPOVER).waitFor({ state: 'detached', timeout: 25_000 });
    expect(await page.locator(DIALOG).count()).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('font-btn') && !!document.activeElement?.closest('.modal-back'))).toBe(true);
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    await page.keyboard.press('Escape');
    await page.locator(DIALOG).waitFor({ state: 'detached', timeout: 25_000 });
    await page.context().close();
  });

  it('keeps focus inside the picker when the font catalogue arrives late, with a row focused', async () => {
    const page = await openBoard();
    // a slow (here: delayed) Fontshare answer: the picker builds its list again after the keyboard user is already in it
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('https://api.fontshare.com/**', async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fonts: [], has_more: false }) }).catch(() => undefined);
    });
    await openBoardSettings(page);
    await openFontPicker(page, 'Heading font');
    await page.keyboard.press('Tab'); // out of the search field, onto a row
    await page.keyboard.press('Tab');
    const before = await page.evaluate(() => !!document.activeElement?.closest('.popover'));
    expect(before).toBe(true);
    release(); // the catalogue arrives now, with the keyboard user inside the picker
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.popover'))).toBe(true);
    await page.context().close();
  });

  it('Tab and Shift+Tab stay inside the picker, across its last and first controls', async () => {
    const page = await openBoard();
    await openBoardSettings(page);
    await openFontPicker(page, 'Heading font');
    // the picker builds its list again when the font catalogue arrives (late on a slow machine): count the controls only once that is done
    let controls = -1;
    await expect.poll(async () => {
      const now = await page.locator(`${FONT_POPOVER} button, ${FONT_POPOVER} input`).count();
      const settled = now === controls;
      controls = now;
      return settled && now > 5;
    }, { timeout: 30_000, interval: 400 }).toBe(true);
    // more presses than there are controls, so Tab has to wrap from the last row back to the search field
    const presses = controls + 3;
    const focusTrail = async () => page.evaluate(() => {
      const a = document.activeElement;
      return { inside: !!a?.closest('.popover'), label: a?.getAttribute('aria-label') ?? a?.className ?? null };
    });
    const forward: { inside: boolean; label: string | null }[] = [];
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press('Tab');
      forward.push(await focusTrail());
    }
    expect(forward.every((f) => f.inside)).toBe(true);
    expect(forward.slice(1).some((f) => f.label === 'Search fonts')).toBe(true); // wrapped back to the first control
    // Shift+Tab from the first control (the search field) wraps to the last one, which is a font row, not the search field
    await page.locator(`${FONT_POPOVER} input`).focus();
    const backward: { inside: boolean; label: string | null }[] = [];
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press('Shift+Tab');
      backward.push(await focusTrail());
    }
    expect(backward.every((f) => f.inside)).toBe(true);
    expect(backward[0].label).not.toBe('Search fonts');
    expect(await page.locator(DIALOG).count()).toBe(1);
    await page.context().close();
  });

  it('a colour list opened from the Labels dialog is drawn above it too, and Esc closes only the list', async () => {
    const page = await openBoard();
    // a kanban is selected, so its quick bar offers Labels; the Labels dialog is board-level, so no cards are needed
    await page.evaluate(() => {
      const app = (window as unknown as { __board: Board }).__board;
      const id = app.createKanban({ x: 3000, y: 3000 });
      if (id) app.setSelection([id]);
    });
    await page.locator('[aria-label="Labels"]').first().click({ timeout: 25_000 });
    await page.locator('.modal-back.k-labels-dialog').waitFor({ timeout: 25_000 });
    const name = page.locator('.k-label-add input');
    await name.fill('Urgent');
    await name.press('Enter');
    await page.locator('.k-colour-btn').first().click({ timeout: 25_000 });
    const colourPop = '.popover.k-colour-pop';
    const labelsDialog = '.modal-back.k-labels-dialog';
    await page.locator(colourPop).waitFor({ timeout: 25_000 });
    // k-colour-pop already has z-index 65 in card-dialog.css, so this case guards the stacking rather than the new rule
    await expectOnTop(page, colourPop, labelsDialog);
    await page.keyboard.press('Escape');
    await page.locator(colourPop).waitFor({ state: 'detached', timeout: 25_000 });
    expect(await page.locator(labelsDialog).count()).toBe(1);
    await page.context().close();
  });
});
