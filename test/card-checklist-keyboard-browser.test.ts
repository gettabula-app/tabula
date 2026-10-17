import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// TAB-372, the checklist of a card in the card dialog, in a real browser and driven by the keyboard alone. Enter in the add field adds
// an item and keeps the field focused and empty; Space ticks an item in place and keeps the focus on its checkbox; Tab walks each row in
// document order and never reaches the grip; Enter on an item's text starts an edit, Enter and leaving the field save it, Escape cancels
// it and only it; Enter on Delete removes an item; Alt+Arrow moves an item. The dialog is opened from the page (openCardDialog), and no
// click lands inside it.

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

const DIALOG = '.modal-back.k-card-dialog';
const ADD_LABEL = 'Add a checklist item';
const ADD_FIELD = `${DIALOG} input[aria-label="${ADD_LABEL}"]`;
const EDIT_FIELD = `${DIALOG} input[aria-label="Item text"]`;
const POLL = { timeout: 25_000 };

type Item = { id: string; text: string; done: boolean };
type BoardWindow = { __board: { r?: { cam?: unknown }; store: { get(id: string): { checklist?: Item[] } | undefined } } };
type Card = { cardId: string; ids: string[] };

/** What holds the focus, read in one step. `part` is the data-part of a row's control; `row` is the row's index (-1 outside a row). */
type Focused = {
  body: boolean; tag: string; cls: string; part: string | null; itemId: string | null; label: string | null; checked: string | null;
  row: number; inDialog: boolean; inChecklist: boolean; inRow: boolean;
};

const focused = (page: Page) => page.evaluate((): Focused => {
  const a = document.activeElement as HTMLElement | null;
  const row = a?.closest<HTMLElement>('.k-cl-row') ?? null;
  return {
    body: !a || a === document.body,
    tag: a?.tagName.toLowerCase() ?? '',
    cls: a?.getAttribute('class') ?? '',
    part: a?.dataset.part ?? null,
    itemId: a?.dataset.itemId ?? null,
    label: a?.getAttribute('aria-label') ?? null,
    checked: a?.getAttribute('aria-checked') ?? null,
    row: row ? [...document.querySelectorAll('.k-cl-row')].indexOf(row) : -1,
    inDialog: !!a?.closest('[role="dialog"]'),
    inChecklist: !!a?.closest('.k-checklist'),
    inRow: !!row,
  };
});

/** A short name for what has focus: a row's control as `part@rowN`, anything else by tag and class. */
const name = (f: Focused) => (f.body ? 'body' : f.inRow ? `${f.part ?? f.cls}@row${f.row}` : `${f.tag}.${f.cls || f.label}`);

/** Presses Tab until `done` holds for what has focus. Returns what each press focused, so a wrong order shows in the message. */
async function tabUntil(page: Page, done: (f: Focused) => boolean, max = 30): Promise<{ reached: boolean; trail: Focused[] }> {
  const trail: Focused[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    trail.push(f);
    if (done(f)) return { reached: true, trail };
  }
  return { reached: false, trail };
}

const onAdd = (f: Focused) => f.label === ADD_LABEL;
const onPart = (part: string, id: string) => (f: Focused) => f.part === part && f.itemId === id;
const trailText = (trail: Focused[]) => JSON.stringify(trail.map(name));

const savedItems = (page: Page, cardId: string) => page.evaluate(
  (id) => (window as unknown as BoardWindow).__board.store.get(id)?.checklist ?? [],
  cardId,
);
const rowIds = (page: Page) => page.locator(`${DIALOG} .k-cl-row`).evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.itemId ?? ''));
const rowTexts = (page: Page) => page.locator(`${DIALOG} .k-cl-row button.k-cl-text`).allTextContents();

/** What the board's camera and the page's scroll say, for the check that a key press did not pan anything. */
const view = (page: Page) => page.evaluate(() => ({
  cam: (window as unknown as BoardWindow).__board.r?.cam ?? null,
  scrollX: window.scrollX,
  scrollY: window.scrollY,
}));

/** Two animation frames, so anything the board lays out or animates on a change has landed before it is measured. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/**
 * A kanban with one card in its first lane, the card's checklist set to `items`, and the card dialog open on it. The dialog is opened
 * with openCardDialog from the page; the card is written through the same editCard the dialog uses. This is a string so the dynamic
 * imports are the browser's own.
 */
function openCardWith(page: Page, items: string[]): Promise<Card> {
  return page.evaluate<Card>(`(async () => {
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
    if (!app.openCardDialog(cardId)) throw new Error('the card dialog did not open');
    return { cardId, ids: (app.store.get(cardId).checklist ?? []).map((i) => i.id) };
  })()`);
}

/**
 * Runs `body` on a fresh board with one card whose checklist is `items`, the card dialog open, and Title focused (the dialog focuses its
 * first field when it opens). The browser context is closed at the end, also when the body fails.
 */
async function withCard(items: string[], body: (page: Page, card: Card) => Promise<void>): Promise<void> {
  const page = await openBoard();
  try {
    const card = await openCardWith(page, items);
    await page.locator(`${DIALOG} [role="dialog"]`).waitFor({ timeout: 25_000 });
    await expect.poll(async () => (await focused(page)).label, POLL).toBe('Title');
    await body(page, card);
  } finally {
    await page.context().close();
  }
}

/** Puts the focus on the text of an item with the keyboard, then starts its edit with Enter. */
async function startEditWithKeyboard(page: Page, id: string) {
  const reached = await tabUntil(page, onPart('text', id));
  expect(reached.reached, `Tab did not reach the item's text: ${trailText(reached.trail)}`).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await focused(page)).label, POLL).toBe('Item text');
}

describe.skipIf(!available)('the card checklist, driven by the keyboard, in a real browser', { timeout: 240_000 }, () => {
  it('Enter in the add field adds an item, the field is emptied and keeps the focus, and the next item goes after the first', () => withCard([], async (page, card) => {
    const reached = await tabUntil(page, onAdd);
    expect(reached.reached, `Tab from the title did not reach the add field: ${trailText(reached.trail)}`).toBe(true);
    expect((await focused(page)).label).toBe(ADD_LABEL);

    await page.keyboard.type('Pack bags');
    await page.keyboard.press('Enter');
    await expect.poll(() => rowTexts(page), POLL).toEqual(['Pack bags']);
    expect(await page.locator(ADD_FIELD).inputValue(), 'the add field was not emptied').toBe('');
    expect((await focused(page)).label, 'the add field lost the focus after Enter').toBe(ADD_LABEL);

    await page.keyboard.type('Book taxi');
    await page.keyboard.press('Enter');
    await expect.poll(() => rowTexts(page), POLL).toEqual(['Pack bags', 'Book taxi']);
    expect(await page.locator(ADD_FIELD).inputValue()).toBe('');
    expect((await focused(page)).label).toBe(ADD_LABEL);
    expect((await savedItems(page, card.cardId)).map((i) => i.text)).toEqual(['Pack bags', 'Book taxi']);
  }));

  // An empty add field: add() returns before any write, so Enter changes nothing and the field keeps the focus. Escape is not handled by
  // the field (it only handles Enter, and keepKeys lets Escape through), so it reaches the dialog's own key handler: the dialog closes.
  it('Enter in the empty add field adds no item and keeps the focus there; Escape in the empty add field closes the dialog', () => withCard(['Pack bags', 'Book taxi'], async (page, card) => {
    const reached = await tabUntil(page, onAdd);
    expect(reached.reached, `Tab did not reach the add field: ${trailText(reached.trail)}`).toBe(true);
    const before = await savedItems(page, card.cardId);

    await page.keyboard.press('Enter');
    await settle(page);
    expect(await rowTexts(page)).toEqual(['Pack bags', 'Book taxi']);
    expect(await savedItems(page, card.cardId), 'Enter in the empty add field wrote the list').toEqual(before);
    expect((await focused(page)).label, 'the add field lost the focus after Enter').toBe(ADD_LABEL);

    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator(DIALOG).count(), POLL).toBe(0);
  }));

  // designer's ruling 2026-10-17. The field has no Escape handler today, so the key reaches the dialog and closes it: this fails until the fix in checklist-ui.ts lands.
  it('FINDING: Escape in the add field with text clears the text, keeps the card dialog open and keeps focus in the field', () => withCard(['Pack bags', 'Book taxi'], async (page, card) => {
    const reached = await tabUntil(page, onAdd);
    expect(reached.reached, `Tab did not reach the add field: ${trailText(reached.trail)}`).toBe(true);
    const before = await savedItems(page, card.cardId);

    await page.keyboard.type('Pack the car');
    await page.keyboard.press('Escape');
    await settle(page);
    await expect.poll(() => page.locator(DIALOG).count(), POLL).toBe(1);
    await expect.poll(() => page.locator(ADD_FIELD).inputValue(), POLL).toBe('');
    expect((await focused(page)).label, 'Escape moved the focus out of the add field').toBe(ADD_LABEL);
    expect(await savedItems(page, card.cardId), 'Escape in the add field wrote the list').toEqual(before);
  }));

  it('Space on an item\'s checkbox ticks it in place, the focus stays on that checkbox, and a second Space unticks it', () => withCard(['Pack bags', 'Book taxi'], async (page, card) => {
    const [first] = card.ids;
    const reached = await tabUntil(page, (f) => f.part === 'box' && f.itemId === first);
    expect(reached.reached, `Tab did not reach the first checkbox: ${trailText(reached.trail)}`).toBe(true);
    expect((await focused(page)).checked).toBe('false');
    await settle(page);
    const before = await view(page);

    await page.keyboard.press('Space');
    await expect.poll(async () => (await focused(page)).checked, POLL).toBe('true');
    const ticked = await focused(page);
    expect(ticked.part, `focus after Space: ${JSON.stringify(ticked)}`).toBe('box');
    expect(ticked.itemId, `focus after Space: ${JSON.stringify(ticked)}`).toBe(first);
    expect(await page.locator(`${DIALOG} .k-cl-row.done`).getAttribute('data-item-id')).toBe(first);
    expect((await savedItems(page, card.cardId))[0].done).toBe(true);

    await page.keyboard.press('Space');
    await expect.poll(async () => (await focused(page)).checked, POLL).toBe('false');
    const unticked = await focused(page);
    expect(unticked.itemId, `focus after the second Space: ${JSON.stringify(unticked)}`).toBe(first);
    expect(await page.locator(`${DIALOG} .k-cl-row.done`).count()).toBe(0);
    expect((await savedItems(page, card.cardId))[0].done).toBe(false);

    expect(await view(page), 'a Space press panned the board or scrolled the page').toEqual(before);
  }));

  it('Tab walks one row in document order (checkbox, text, Turn into card, Delete), the same for every row, and never stops on the grip', () => withCard(['Pack bags', 'Book taxi', 'Buy tickets'], async (page, card) => {
    const [a, , c] = card.ids;
    // the row menu button is display:none at desktop width, so Tab does not stop on it
    expect(await page.locator(`${DIALOG} .k-cl-more`).first().isVisible(), 'the row menu button is shown at desktop width').toBe(false);
    const grip = page.locator(`${DIALOG} .k-cl-grip`).first();
    expect(await grip.getAttribute('aria-hidden')).toBe('true');
    expect(await grip.getAttribute('tabindex'), 'the grip has a tabindex').toBeNull();

    const start = await tabUntil(page, onPart('box', a));
    expect(start.reached, `Tab did not reach the first checkbox: ${trailText(start.trail)}`).toBe(true);
    const from = await focused(page);
    const walk = await tabUntil(page, onPart('box', c));
    expect(walk.reached, `Tab did not reach the third checkbox: ${trailText(walk.trail)}`).toBe(true);
    const seq = [name(from), ...walk.trail.map(name)];
    const expected = [
      'box@row0', 'text@row0', 'convert@row0', 'delete@row0',
      'box@row1', 'text@row1', 'convert@row1', 'delete@row1',
      'box@row2',
    ];
    expect(seq, `Tab order over three rows was ${JSON.stringify(seq)}`).toEqual(expected);
  }));

  it('Enter on an item\'s text starts the edit with the text in the field; Enter saves it, the field goes, and focus is back on that text', () => withCard(['Pack bags', 'Book taxi'], async (page, card) => {
    const [a] = card.ids;
    await startEditWithKeyboard(page, a);
    expect(await page.locator(EDIT_FIELD).inputValue()).toBe('Pack bags');

    await page.keyboard.press('Shift+Home');
    await page.keyboard.type('Pack the charger');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator(EDIT_FIELD).count(), POLL).toBe(0);
    await expect.poll(() => rowTexts(page), POLL).toEqual(['Pack the charger', 'Book taxi']);
    expect((await savedItems(page, card.cardId))[0].text).toBe('Pack the charger');
    const f = await focused(page);
    expect(f.part, `focus after the save: ${JSON.stringify(f)}`).toBe('text');
    expect(f.itemId, `focus after the save: ${JSON.stringify(f)}`).toBe(a);
  }));

  it('Escape in an edit cancels only the edit: the old text stays and the dialog stays open with focus on the text; a second Escape closes the dialog', () => withCard(['Pack bags', 'Book taxi'], async (page, card) => {
    const [a] = card.ids;
    await startEditWithKeyboard(page, a);
    await page.keyboard.press('Shift+Home');
    await page.keyboard.type('Changed my mind');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator(EDIT_FIELD).count(), POLL).toBe(0);
    expect(await rowTexts(page)).toEqual(['Pack bags', 'Book taxi']);
    expect(await page.locator(`${DIALOG} [role="dialog"]`).isVisible(), 'the first Escape closed the dialog').toBe(true);
    const f = await focused(page);
    expect(f.part, `focus after Escape: ${JSON.stringify(f)}`).toBe('text');
    expect(f.itemId, `focus after Escape: ${JSON.stringify(f)}`).toBe(a);
    expect((await savedItems(page, card.cardId))[0].text).toBe('Pack bags');

    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator(DIALOG).count(), POLL).toBe(0);
  }));

  // This pins the current behaviour, not the intent: pending the designer's answer on where focus should go after a Tab out of an edit.
  it('observed: Tab out of an edit saves the new text and focus returns to that item\'s text, it does not advance', () => withCard(['Pack bags', 'Book taxi'], async (page, card) => {
    const [a] = card.ids;
    await startEditWithKeyboard(page, a);
    await page.keyboard.press('Shift+Home');
    await page.keyboard.type('Saved by Tab');
    await page.keyboard.press('Tab');
    await expect.poll(() => page.locator(EDIT_FIELD).count(), POLL).toBe(0);
    expect((await savedItems(page, card.cardId))[0].text).toBe('Saved by Tab');
    expect(await rowTexts(page)).toEqual(['Saved by Tab', 'Book taxi']);
    const f = await focused(page);
    expect(f.body, `focus after Tab out of the edit: ${JSON.stringify(f)}`).toBe(false);
    expect(f.inDialog, `focus after Tab out of the edit: ${JSON.stringify(f)}`).toBe(true);
    expect(f.inChecklist, `focus after Tab out of the edit: ${JSON.stringify(f)}`).toBe(true);
    // Observed: the save rebuilds the list and focus lands on the edited item's own text button, not on the next stop (its Delete button).
    expect({ itemId: f.itemId, part: f.part }, `focus after Tab out of the edit: ${JSON.stringify(f)}`).toEqual({ itemId: a, part: 'text' });
  }));

  it('Enter on an item\'s Delete button removes the item, and focus lands on a neighbouring item or the add field, never on the body', () => withCard(['Pack bags', 'Book taxi', 'Buy tickets'], async (page, card) => {
    const [, b] = card.ids;
    const reached = await tabUntil(page, onPart('delete', b));
    expect(reached.reached, `Tab did not reach the Delete button: ${trailText(reached.trail)}`).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => rowTexts(page), POLL).toEqual(['Pack bags', 'Buy tickets']);
    expect((await savedItems(page, card.cardId)).map((i) => i.text)).toEqual(['Pack bags', 'Buy tickets']);
    const f = await focused(page);
    expect(f.body, `focus after Delete: ${JSON.stringify(f)}`).toBe(false);
    expect(f.inRow || f.label === ADD_LABEL, `focus after Delete: ${JSON.stringify(f)}`).toBe(true);
    // The neighbour that took the deleted item's place, here the one after it.
    expect({ itemId: f.itemId, part: f.part }, `focus after Delete: ${JSON.stringify(f)}`).toEqual({ itemId: card.ids[2], part: 'text' });
  }));

  // The neighbour rule (neighbourFocus in checklist-ui.ts): after a delete, focus goes to the next shown item, else to the one before it,
  // else to the add field. The last item has no next one, so focus lands on the PREVIOUS item's text (b), not on the add field.
  it('Enter on the Delete button of the last item removes it, and focus lands on the previous item\'s text, not the add field', () => withCard(['Pack bags', 'Book taxi', 'Buy tickets'], async (page, card) => {
    const [, b, c] = card.ids;
    const reached = await tabUntil(page, onPart('delete', c));
    expect(reached.reached, `Tab did not reach the last item's Delete button: ${trailText(reached.trail)}`).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => rowTexts(page), POLL).toEqual(['Pack bags', 'Book taxi']);
    expect((await savedItems(page, card.cardId)).map((i) => i.text)).toEqual(['Pack bags', 'Book taxi']);
    const f = await focused(page);
    expect(f.body, `focus after Delete: ${JSON.stringify(f)}`).toBe(false);
    expect({ itemId: f.itemId, part: f.part }, `focus after Delete: ${JSON.stringify(f)}`).toEqual({ itemId: b, part: 'text' });
  }));

  // The only item has no next and no previous one, so neighbourFocus falls back to the add field (designer's ruling 2026-10-17).
  it('Enter on the Delete button of the only item removes it and focus lands on the add field', () => withCard(['Pack bags'], async (page, card) => {
    const [a] = card.ids;
    const reached = await tabUntil(page, onPart('delete', a));
    expect(reached.reached, `Tab did not reach the Delete button: ${trailText(reached.trail)}`).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => rowTexts(page), POLL).toEqual([]);
    expect(await savedItems(page, card.cardId)).toEqual([]);
    const f = await focused(page);
    expect(f.label, `focus after Delete: ${JSON.stringify(f)}`).toBe(ADD_LABEL);
  }));

  it('Alt+ArrowDown moves an item down one place and Alt+ArrowUp moves it back, with focus on its text each time', () => withCard(['Pack bags', 'Book taxi', 'Buy tickets'], async (page, card) => {
    const [a, b, c] = card.ids;
    const reached = await tabUntil(page, onPart('text', a));
    expect(reached.reached, `Tab did not reach the first item's text: ${trailText(reached.trail)}`).toBe(true);

    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => rowIds(page), POLL).toEqual([b, a, c]);
    const down = await focused(page);
    expect(down.part, `focus after Alt+ArrowDown: ${JSON.stringify(down)}`).toBe('text');
    expect(down.itemId, `focus after Alt+ArrowDown: ${JSON.stringify(down)}`).toBe(a);
    expect((await savedItems(page, card.cardId)).map((i) => i.id)).toEqual([b, a, c]);

    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => rowIds(page), POLL).toEqual([a, b, c]);
    const up = await focused(page);
    expect(up.part, `focus after Alt+ArrowUp: ${JSON.stringify(up)}`).toBe('text');
    expect(up.itemId, `focus after Alt+ArrowUp: ${JSON.stringify(up)}`).toBe(a);
    expect((await savedItems(page, card.cardId)).map((i) => i.id)).toEqual([a, b, c]);
  }));

  // At an edge, moveItem returns the same list, and attempt returns before any save or focus change: a key press that moves nothing
  // writes nothing and leaves the focus where it was.
  it('Alt+ArrowUp on the first item changes nothing: the order stays, nothing is saved, and focus stays on its text', () => withCard(['Pack bags', 'Book taxi', 'Buy tickets'], async (page, card) => {
    const [a, b, c] = card.ids;
    const reached = await tabUntil(page, onPart('text', a));
    expect(reached.reached, `Tab did not reach the first item's text: ${trailText(reached.trail)}`).toBe(true);
    const before = await savedItems(page, card.cardId);

    await page.keyboard.press('Alt+ArrowUp');
    await settle(page);
    expect(await rowIds(page)).toEqual([a, b, c]);
    expect(await savedItems(page, card.cardId), 'Alt+ArrowUp on the first item wrote the list').toEqual(before);
    const f = await focused(page);
    expect({ itemId: f.itemId, part: f.part }, `focus after Alt+ArrowUp: ${JSON.stringify(f)}`).toEqual({ itemId: a, part: 'text' });
  }));

  it('Alt+ArrowDown on the last item changes nothing: the order stays, nothing is saved, and focus stays on its text', () => withCard(['Pack bags', 'Book taxi', 'Buy tickets'], async (page, card) => {
    const [a, b, c] = card.ids;
    const reached = await tabUntil(page, onPart('text', c));
    expect(reached.reached, `Tab did not reach the last item's text: ${trailText(reached.trail)}`).toBe(true);
    const before = await savedItems(page, card.cardId);

    await page.keyboard.press('Alt+ArrowDown');
    await settle(page);
    expect(await rowIds(page)).toEqual([a, b, c]);
    expect(await savedItems(page, card.cardId), 'Alt+ArrowDown on the last item wrote the list').toEqual(before);
    const f = await focused(page);
    expect({ itemId: f.itemId, part: f.part }, `focus after Alt+ArrowDown: ${JSON.stringify(f)}`).toEqual({ itemId: c, part: 'text' });
  }));
});
