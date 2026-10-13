import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// A key pressed with focus inside the live tracker on a board belongs to the tracker, not to the board: Backspace or Delete on a
// ticket row must never delete the selected tracker frame, and Space must not start panning the canvas. Runs the visual-mode mock
// (?debug&trackerMock=board): the real frame and tracker UI over a seeded mock tracker.

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

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?debug&trackerMock=board#/b/trk-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board && (window as any).__trackerStore && [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'tracker'), null, { timeout: budget(30_000) });
  return page;
}

const frameId = (page: Page) => page.evaluate(() => [...(window as any).__board.store.cache.values()].find((o: any) => o.type === 'tracker').id as string);
const frameExists = (page: Page, id: string) => page.evaluate((i) => (window as any).__board.store.get(i) !== undefined, id);

// The element is live where it sits: its rows list without a click (the default view is All issues).
async function liveRows(page: Page): Promise<void> {
  await page.locator('.trk-frame-wrap.is-work .trk-list-row').first().waitFor();
}

async function enterWork(page: Page): Promise<string> {
  const id = await frameId(page);
  await page.evaluate((i) => (window as any).__board.setSelection([i]), id);
  await liveRows(page);
  return id;
}

const liveCount = (page: Page) => page.evaluate(() => document.querySelectorAll('.trk-frame-wrap.is-work').length);
const frameFor = (page: Page, id: string) => page.evaluate((i) => {
  const o = (window as any).__board.store.get(i);
  return o ? { x: o.x, y: o.y, w: o.w, h: o.h } : null;
}, id);

describe.skipIf(!available)('keys inside the live tracker on a board', { timeout: 200_000 }, () => {
  it('lists rows on load with no click, goes back to a snapshot below 40 % zoom, and is live again when zoomed in', async () => {
    const page = await open();
    await liveRows(page);
    expect(await liveCount(page)).toBe(1);
    await page.evaluate(() => (window as any).__board.zoomTo(0.3));
    await page.waitForFunction(() => document.querySelectorAll('.trk-frame-wrap.is-work').length === 0, null, { timeout: budget(10_000) });
    expect(await page.evaluate(() => document.querySelectorAll('.trk-frame-wrap .trk-shell:not([hidden])').length)).toBe(0);
    await page.evaluate(() => (window as any).__board.zoomTo(1));
    await liveRows(page);
    await page.close();
  });

  it('shows the Open chip on a desktop frame that is not live (selected or hovered) and never on a live one', async () => {
    const page = await open();
    const id = await enterWork(page);
    const chipHidden = () => page.evaluate(() => (document.querySelector('.trk-frame-open') as HTMLButtonElement).hidden);
    // live: selected and hovered, and still no chip
    await page.locator('.trk-frame-wrap.is-work').hover();
    expect(await chipHidden()).toBe(true);
    // zoomed out below 40 %: a snapshot, selected, so the chip is the way in
    await page.evaluate(() => (window as any).__board.zoomTo(0.3));
    await page.waitForFunction(() => document.querySelectorAll('.trk-frame-wrap.is-work').length === 0, null, { timeout: budget(10_000) });
    await page.waitForFunction(() => !(document.querySelector('.trk-frame-open') as HTMLButtonElement).hidden, null, { timeout: budget(10_000) });
    // deselected and not hovered: hidden again
    await page.evaluate(() => (window as any).__board.setSelection([]));
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => (document.querySelector('.trk-frame-open') as HTMLButtonElement).hidden, null, { timeout: budget(10_000) });
    // hovered alone brings it back
    await page.evaluate((i) => {
      const wrap = document.querySelector('.trk-frame-wrap') as HTMLElement;
      wrap.dispatchEvent(new PointerEvent('pointerenter'));
      return i;
    }, id);
    await page.waitForFunction(() => !(document.querySelector('.trk-frame-open') as HTMLButtonElement).hidden, null, { timeout: budget(10_000) });
    await page.close();
  });

  it('keeps three frames live and renders a fourth as a snapshot', async () => {
    const page = await open();
    await liveRows(page);
    await page.evaluate(() => {
      const board = (window as any).__board;
      const tracker = [...board.store.cache.values()].find((o: any) => o.type === 'tracker') as any;
      const v = board.r.viewport();
      // a 2 x 2 grid of frames inside the viewport at 50 % zoom (each 360 x 240 on screen, so all four are eligible)
      board.zoomTo(0.5);
      for (let i = 0; i < 3; i++) {
        board.store.transact(() => board.store.create({
          id: `grid-${i}`, type: 'tracker', x: v.x + 40 + ((i + 1) % 2) * 800, y: v.y + 40 + Math.floor((i + 1) / 2) * 520,
          w: tracker.w, h: tracker.h, rotation: 0, z: board.store.topZ(), trackerId: tracker.trackerId, view: 'all',
        }));
      }
    });
    await page.waitForFunction(() => document.querySelectorAll('.trk-frame-wrap').length === 4, null, { timeout: budget(10_000) });
    await page.waitForFunction(() => document.querySelectorAll('.trk-frame-wrap.is-work').length === 3, null, { timeout: budget(10_000) });
    // the snapshot's shell is destroyed once it has been out of the live set for the hold (500 ms)
    await page.waitForFunction(() => document.querySelectorAll('.trk-frame-wrap .trk-shell').length === 3, null, { timeout: budget(10_000) });
    expect(await liveCount(page)).toBe(3);
    await page.close();
  });

  it('Escape in a live element returns focus to the canvas and keeps the frame selected', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.evaluate(() => (document.querySelector('.trk-frame-wrap.is-work .trk-shell') as HTMLElement).focus());
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('canvas-focus') ?? false)).toBe(true);
    expect(await page.evaluate((i) => (window as any).__board.selection.includes(i), id)).toBe(true);
    expect(await liveCount(page)).toBe(1);
    await page.close();
  });

  it('a click on the empty element header selects the element and does not move it (the header has no hit target of its own)', async () => {
    const page = await open();
    const id = await enterWork(page);
    const before = await frameFor(page, id);
    // the empty middle of the element header: no control there, so the click reaches the canvas, which selects the element
    const point = await page.evaluate(() => {
      const r = document.querySelector('.trk-frame-wrap.is-work .trk-element-title')!.getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    });
    await page.evaluate(() => (window as any).__board.setSelection([]));
    await page.mouse.click(point.x, point.y);
    expect(await page.evaluate((i) => (window as any).__board.selection.includes(i), id)).toBe(true);
    expect(await frameFor(page, id)).toEqual(before);
    await page.close();
  });

  it('a drag on the empty header strip of a live element moves the object (the canvas gets it)', async () => {
    const page = await open();
    const id = await enterWork(page);
    const before = await frameFor(page, id);
    // the empty middle of the element header (the title box, no control there)
    const point = await page.evaluate(() => {
      const r = document.querySelector('.trk-frame-wrap.is-work .trk-element-title')!.getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 80, point.y + 40, { steps: 6 });
    await page.mouse.up();
    const after = await frameFor(page, id);
    expect(after!.x).not.toBe(before!.x);
    expect(after!.y).not.toBe(before!.y);
    await page.close();
  });

  it('Backspace and Delete on a focused ticket row do not delete the selected tracker frame', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.evaluate(() => (document.querySelector('.trk-frame-wrap.is-work .trk-shell') as HTMLElement).focus()); // the shell takes the keys of its rows
    expect(await page.evaluate(() => document.activeElement?.closest('.trk') !== null)).toBe(true);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    expect(await frameExists(page, id)).toBe(true);
    await page.close();
  });

  // Backspace and Delete after a real interaction with a ticket: the control that had focus may be gone after a re-render, and the
  // keys must still belong to the tracker, never to the board (which would delete the selected tracker frame).
  const keysKeepFrame = async (page: Page, id: string) => {
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    return frameExists(page, id);
  };

  it('Backspace and Delete keep the frame after a click on a ticket row in the list', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.locator('.trk-frame-wrap.is-work .trk-list-row').first().click();
    // the control that had focus went away with the re-render: the tracker takes the focus back
    await page.waitForFunction(() => document.activeElement?.closest('.trk') !== null, null, { timeout: budget(10_000) });
    expect(await keysKeepFrame(page, id)).toBe(true);
    await page.close();
  });

  it('Backspace and Delete keep the frame after a ticket opened from the keyboard', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.locator('.trk-frame-wrap.is-work .trk-list-row').first().focus();
    await page.keyboard.press('Enter');
    expect(await keysKeepFrame(page, id)).toBe(true);
    await page.close();
  });

  it('Backspace and Delete keep the frame after a click and after a drag on a card in the Board tab', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.locator('.trk-frame-wrap.is-work .trk-element-switch').getByText('Board', { exact: true }).click();
    const cards = page.locator('.trk-frame-wrap.is-work .trk-board-card');
    await cards.first().waitFor();
    await cards.first().click();
    expect(await keysKeepFrame(page, id)).toBe(true);
    await page.keyboard.press('Escape'); // back from the opened ticket to the board
    await cards.first().waitFor();
    const box = (await cards.first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 10, { steps: 8 });
    await page.mouse.up();
    expect(await keysKeepFrame(page, id)).toBe(true);
    await page.close();
  });

  it('Backspace and Delete keep the frame after a click on a row in the full-screen route', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.locator('.trk-frame-wrap.is-work .trk-element-expand').click();
    const row = page.locator('.trk-route-root .trk-list-row, .trk-fullscreen-portal .trk-list-row').first();
    await row.waitFor();
    await row.click();
    expect(await keysKeepFrame(page, id)).toBe(true);
    await page.close();
  });

  it('Ctrl+Z after a ticket move is never the board undo: the frame stays, and the tracker undoes the move', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.locator('.trk-frame-wrap.is-work .trk-element-switch').getByText('Board', { exact: true }).click();
    const cards = page.locator('.trk-frame-wrap.is-work .trk-board-card');
    await cards.first().waitFor();
    const key = (await cards.first().getAttribute('data-key'))!;
    const laneOf = () => page.evaluate((k) => document.querySelector(`.trk-frame-wrap.is-work .trk-board-card[data-key="${k}"]`)?.closest('.trk-board-lane')?.getAttribute('data-state') ?? '', key);
    const before = await laneOf();
    const box = (await cards.first().boundingBox())!;
    const lanes = await page.locator('.trk-frame-wrap.is-work .trk-board-lane').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 80 }; }));
    const target = lanes.find((l) => Math.abs(l.x - (box.x + box.width / 2)) > 60)!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(([k, b]) => {
      const c = document.querySelector(`.trk-frame-wrap.is-work .trk-board-card[data-key="${k}"]`);
      const l = c?.closest('.trk-board-lane');
      return !!c && (l?.getAttribute('data-state') ?? '') !== b;
    }, [key, before] as const, { timeout: budget(10_000) });
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Meta+z');
    expect(await frameExists(page, id)).toBe(true);
    await page.waitForFunction(([k, b]) => {
      const l = document.querySelector(`.trk-frame-wrap.is-work .trk-board-card[data-key="${k}"]`)?.closest('.trk-board-lane');
      return (l?.getAttribute('data-state') ?? '') === b;
    }, [key, before] as const, { timeout: budget(10_000) });
    await page.close();
  });

  it('the Undo button of the State changed toast puts the ticket back in its lane', async () => {
    const page = await open();
    const id = await enterWork(page);
    await page.locator('.trk-frame-wrap.is-work .trk-element-switch').getByText('Board', { exact: true }).click();
    const cards = page.locator('.trk-frame-wrap.is-work .trk-board-card');
    await cards.first().waitFor();
    const key = (await cards.first().getAttribute('data-key'))!;
    const laneOf = () => page.evaluate((k) => document.querySelector(`.trk-frame-wrap.is-work .trk-board-card[data-key="${k}"]`)?.closest('.trk-board-lane')?.getAttribute('data-state') ?? '', key);
    const before = await laneOf();
    const box = (await cards.first().boundingBox())!;
    const lanes = await page.locator('.trk-frame-wrap.is-work .trk-board-lane').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 80 }; }));
    const target = lanes.find((l) => Math.abs(l.x - (box.x + box.width / 2)) > 60)!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(([k, b]) => {
      const c = document.querySelector(`.trk-frame-wrap.is-work .trk-board-card[data-key="${k}"]`);
      const l = c?.closest('.trk-board-lane');
      return !!c && (l?.getAttribute('data-state') ?? '') !== b;
    }, [key, before] as const, { timeout: budget(10_000) });
    await page.locator('.toast button', { hasText: 'Undo' }).click();
    expect(await frameExists(page, id)).toBe(true);
    await page.waitForFunction(([k, b]) => {
      const l = document.querySelector(`.trk-frame-wrap.is-work .trk-board-card[data-key="${k}"]`)?.closest('.trk-board-lane');
      return (l?.getAttribute('data-state') ?? '') === b;
    }, [key, before] as const, { timeout: budget(10_000) });
    await page.close();
  });

  it('the Undo button of the State changed toast from the list state picker puts the state back', async () => {
    const page = await open();
    await enterWork(page);
    const row = page.locator('.trk-frame-wrap.is-work .trk-list-row').first();
    const key = (await row.getAttribute('data-key'))!;
    const stateOf = (k: string) => page.evaluate((x) => document.querySelector(`.trk-frame-wrap.is-work .trk-list-row[data-key="${x}"] .trk-state-value`)?.getAttribute('aria-label') ?? '', k);
    const before = await stateOf(key);
    await row.locator('.trk-state-value').click();
    await page.locator('.trk-picker-option').first().waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(([k, b]) => (document.querySelector(`.trk-frame-wrap.is-work .trk-list-row[data-key="${k}"] .trk-state-value`)?.getAttribute('aria-label') ?? b) !== b, [key, before] as const, { timeout: budget(10_000) });
    await page.locator('.toast button', { hasText: 'Undo' }).click();
    await page.waitForFunction(([k, b]) => document.querySelector(`.trk-frame-wrap.is-work .trk-list-row[data-key="${k}"] .trk-state-value`)?.getAttribute('aria-label') === b, [key, before] as const, { timeout: budget(10_000) });
    expect(await stateOf(key)).toBe(before);
    await page.close();
  });

  it('Backspace on a focused row archives that one ticket, says so with the right count, and keeps the frame', async () => {
    const page = await open();
    const id = await enterWork(page);
    const row = page.locator('.trk-frame-wrap.is-work .trk-list-row').first();
    const key = (await row.getAttribute('data-key'))!;
    await row.focus();
    await page.keyboard.press('Backspace');
    await page.locator('.toast', { hasText: 'archived' }).waitFor();
    expect(await page.locator('.toast', { hasText: 'archived' }).first().textContent()).toMatch(/^1 issue/);
    expect(await page.locator(`.trk-frame-wrap.is-work .trk-list-row[data-key="${key}"]`).count()).toBe(0);
    expect(await frameExists(page, id)).toBe(true);
    await page.close();
  });

  it('a key typed inside the tracker is not a canvas shortcut (Space does not pan, a tool key does not switch the tool)', async () => {
    const page = await open();
    await enterWork(page);
    await page.evaluate(() => (document.querySelector('.trk-frame-wrap.is-work .trk-shell') as HTMLElement).focus()); // the shell takes the keys of its rows
    await page.keyboard.press('r');
    expect(await page.evaluate(() => (window as any).__board.tool.kind)).toBe('select');
    await page.keyboard.down('Space');
    expect(await page.evaluate(() => document.querySelector('svg.canvas')?.parentElement?.classList.contains('space') ?? false)).toBe(false);
    await page.keyboard.up('Space');
    await page.close();
  });

  it('a board that is read-only for this person shows the live tracker without New issue, and gives it back when the role allows', async () => {
    const page = await open();
    await enterWork(page);
    const newIssue = () => page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('.trk-frame-wrap.is-work .trk-new-trigger');
      return b ? !b.hidden : false;
    });
    expect(await newIssue()).toBe(true);
    await page.evaluate(() => (window as any).__board.store.setReadOnly(true));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.trk-frame-wrap.is-work .trk-new-trigger')?.hidden === true, null, { timeout: budget(10_000) });
    await page.evaluate(() => (window as any).__board.store.setReadOnly(false));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.trk-frame-wrap.is-work .trk-new-trigger')?.hidden === false, null, { timeout: budget(10_000) });
    await page.close();
  });

  it('a selected tracker element shows no text edit bar (the emoji button belongs to text editing only)', async () => {
    const page = await open();
    const id = await frameId(page);
    await page.evaluate((i) => (window as any).__board.setSelection([i]), id);
    await page.waitForFunction(() => document.querySelector('.trk-frame-wrap.is-work') !== null, null, { timeout: budget(10_000) });
    const state = await page.evaluate(() => ({
      active: (window as any).__board.editor.active as boolean,
      shown: document.querySelector('.edit-bar')?.classList.contains('show') ?? false,
      emojiVisible: (() => { const e = document.querySelector<HTMLElement>('.edit-emoji'); return !!e && e.getClientRects().length > 0 && getComputedStyle(e.closest('.edit-bar') as Element).visibility !== 'hidden'; })(),
    }));
    expect(state.active).toBe(false);
    expect(state.shown).toBe(false);
    await page.close();
  });

  it('Enter on a selected tracker element focuses it and does not start a text edit (no edit bar, no emoji button)', async () => {
    const page = await open();
    const id = await frameId(page);
    await page.evaluate((i) => { (window as any).__board.zoomTo(0.5); (window as any).__board.setSelection([i]); }, id);
    await page.keyboard.press('Enter');
    await page.locator('.trk-frame-wrap.is-work .trk-shell').waitFor({ timeout: budget(10_000) });
    const state = await page.evaluate(() => ({
      active: (window as any).__board.editor.active as boolean,
      bar: document.querySelector('.edit-bar')?.classList.contains('show') ?? false,
      focusInShell: document.activeElement?.closest('.trk') !== null,
    }));
    expect(state.active).toBe(false);
    expect(state.bar).toBe(false);
    expect(state.focusInShell).toBe(true);
    await page.close();
  });
});
