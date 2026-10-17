import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// TAB-454, the checklist of a card in the card dialog at desktop width (1024 px, above the 860 px phone breakpoint), in a real browser. A
// read-only row (here a locked card) has no grip and no tools, so its checkbox and text take the first two grid columns: the text keeps
// at least 200 px and most of the row, and starts right after its checkbox. The same card, unlocked, keeps its text at least 200 px wide.
// The dialog is opened from the page (openCardDialog), as in card-checklist-keyboard-browser.test.ts.

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
    const context = await browser!.newContext({ viewport: { width: 1024, height: 768 } });
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

const DIALOG = '.modal-back.k-card-dialog';
const POLL = { timeout: 25_000 };
const ITEM = 'Book the taxi to the airport before six on Friday morning';

/** One row's checkbox and text as rendered, in CSS pixels: the row's width, the checkbox's right edge, the text's left edge and width. */
type RowLayout = { rowWidth: number; boxLeft: number; boxRight: number; textLeft: number; textWidth: number };

/**
 * A kanban with one card in its first lane, the card's checklist set to `items`, the card locked when `locked` is set, and the card dialog
 * open on it. The card is written through the same editCard the dialog uses, before it is locked (a locked card refuses edits). This is a
 * string so the dynamic imports are the browser's own.
 */
function openCardWith(page: Page, items: string[], locked: boolean): Promise<void> {
  return page.evaluate<void>(`(async () => {
    const app = window.__board;
    const { addCard, editCard } = await import('/src/containers.ts');
    const { withNewIds } = await import('/src/checklist.ts');
    const kanbanId = app.createKanban({ x: 3000, y: 3000 });
    if (!kanbanId) throw new Error('the board refused a kanban');
    const lanes = [...app.store.cache.values()]
      .filter((o) => o.type === 'lane' && o.parent === kanbanId)
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    const cardId = addCard(app.store, lanes[0].id, 'Pack for the trip', { createdBy: app.user.id });
    if (!cardId) throw new Error('the card was not added');
    const list = withNewIds(${JSON.stringify(items)}.map((text) => ({ text, done: false })));
    if (list.length && !editCard(app.store, cardId, { checklist: list })) throw new Error('the checklist was not written');
    if (${JSON.stringify(locked)}) app.setLocked(cardId, true);
    if (!app.openCardDialog(cardId)) throw new Error('the card dialog did not open');
  })()`);
}

/**
 * Runs `body` on a fresh board with one card whose checklist is `items`, locked or not, and the card dialog open on it, with every row
 * rendered. The browser context is closed at the end, also when the body fails.
 */
async function withCard(items: string[], locked: boolean, body: (page: Page) => Promise<void>): Promise<void> {
  const page = await openBoard();
  try {
    await openCardWith(page, items, locked);
    await page.locator(`${DIALOG} [role="dialog"]`).waitFor({ timeout: 25_000 });
    await expect.poll(() => page.locator(`${DIALOG} .k-cl-row`).count(), POLL).toBe(items.length);
    await body(page);
  } finally {
    await page.context().close();
  }
}

/**
 * The first row's checkbox and text, measured once the dialog's open animation has ended (the dialog scales in over 200 ms), so the
 * widths are the final ones. Throws when the row has no checkbox or no text.
 */
async function firstRow(page: Page): Promise<RowLayout> {
  await expect.poll(() => page.locator(`${DIALOG} .modal`).evaluate((el) => el.getAnimations().length), POLL).toBe(0);
  const layout = await page.evaluate((dialog) => {
    const row = document.querySelector<HTMLElement>(`${dialog} .k-cl-row`);
    const box = row?.querySelector<HTMLElement>('.k-cl-box');
    const text = row?.querySelector<HTMLElement>('.k-cl-text');
    if (!row || !box || !text) return null;
    const b = box.getBoundingClientRect();
    const t = text.getBoundingClientRect();
    return { rowWidth: row.getBoundingClientRect().width, boxLeft: b.left, boxRight: b.right, textLeft: t.left, textWidth: t.width };
  }, DIALOG);
  if (!layout) throw new Error('the first row has no checkbox or no text');
  return layout;
}

describe.skipIf(!available)('the card checklist at desktop width, in a real browser', { timeout: 240_000 }, () => {
  it('a read-only row keeps its text beside its checkbox: at least 200 px wide, at least 70% of the row, and starting within 40 px of the checkbox', () => withCard([ITEM], true, async (page) => {
    // the precondition: the dialog really opened read-only, so the layout measured is the read-only one
    expect(await page.locator(`${DIALOG} .k-cl-box`).first().isDisabled(), 'the locked card\'s checkbox is not disabled').toBe(true);
    const row = await firstRow(page);
    expect(row.textWidth, `the text is ${row.textWidth} px wide in a ${row.rowWidth} px row`).toBeGreaterThanOrEqual(200);
    expect(row.textWidth, `the text is ${row.textWidth} px wide in a ${row.rowWidth} px row`).toBeGreaterThanOrEqual(0.7 * row.rowWidth);
    expect(row.boxLeft, 'the checkbox is not before the text').toBeLessThan(row.textLeft);
    expect(Math.abs(row.textLeft - row.boxRight), `the text starts ${row.textLeft - row.boxRight} px from the checkbox`).toBeLessThanOrEqual(40);
  }));

  it('an editable row keeps its text at least 200 px wide at the same width', () => withCard([ITEM], false, async (page) => {
    expect(await page.locator(`${DIALOG} .k-cl-box`).first().isDisabled(), 'the unlocked card\'s checkbox is disabled').toBe(false);
    const row = await firstRow(page);
    expect(row.textWidth, `the text is ${row.textWidth} px wide in a ${row.rowWidth} px row`).toBeGreaterThanOrEqual(200);
  }));
});
