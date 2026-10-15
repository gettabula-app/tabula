import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// TAB-375 slice 2: dragging a board between the sections of the Boards page, in a real browser. A card may be dropped on a section it
// may move to (its targets); a section it may not go to is marked refused and takes no drop; the section it is in takes nothing.
// The page is the real sections view and CSS; the moves are recorded, not sent (the move is a dev stub).

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

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1000, height: 900 } });
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="host"></div>' }));
  await page.goto(`${base}__blank`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import '/src/ui/home.css';
      import { renderBoardSections } from '/src/ui/boards-cards-view.ts';
      const card = (id, name, targets) => ({ id, name, updatedAt: Date.now() - 60000, role: 'owner', targets });
      window.__moves = [];
      const sections = [
        { id: 'design', title: 'Design team', kind: 'team', teamId: 'design', canAdd: true, boards: [card('a', 'Alpha', [{ id: 'retro', name: 'Retro team' }, { id: null, name: 'Personal' }])] },
        { id: 'retro', title: 'Retro team', kind: 'team', teamId: 'retro', canAdd: true, boards: [card('r', 'Retro board', [])] },
        { id: 'growth', title: 'Growth team', kind: 'team', teamId: 'growth', canAdd: false, boards: [] },
        { id: 'personal', title: 'Personal', kind: 'personal', teamId: null, canAdd: true, boards: [] },
        { id: 'shared', title: 'Shared with you', kind: 'shared', boards: [card('s', 'Shared', [])] },
      ];
      renderBoardSections(document.getElementById('host'), sections, {
        view: 'cards', tile: 'tint', previews: true,
        onMove: (to, data) => window.__moves.push([to.id, data.id]),
      });
      window.__ready = true;
    `,
  });
  await page.waitForFunction('window.__ready === true');
  return page;
}

/** The class state of each section, by its heading. */
const marks = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('section.bc-group')].map((s) => [
  s.querySelector('h2')?.textContent ?? '',
  s.classList.contains('bc-drop-ok') ? 'ok' : s.classList.contains('bc-drop-no') ? 'no' : '-',
])));

describe.skipIf(!available)('dragging a board between the Boards sections', { timeout: 200_000 }, () => {
  it('draggable only for a card that has somewhere to go', async () => {
    const page = await open();
    expect(await page.locator('li.bc-li', { hasText: 'Alpha' }).getAttribute('draggable')).toBe('true');
    expect(await page.locator('li.bc-li', { hasText: 'Shared' }).getAttribute('draggable')).toBeNull();
    await page.close();
  });

  it('marks the sections while dragging: the targets allowed, the others refused, the board\'s own section neither', async () => {
    const page = await open();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      document.querySelector('li.bc-li')!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    });
    expect(await marks(page)).toEqual({
      'Design team': '-', 'Retro team': 'ok', 'Growth team': 'no', 'Personal': 'ok', 'Shared with you': 'no',
    });
    await page.close();
  });

  it('lets a drop on an allowed section through, and refuses one on a section it may not go to', async () => {
    const page = await open();
    const result = await page.evaluate(() => {
      const dt = new DataTransfer();
      const source = document.querySelector('li.bc-li')!;
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const sectionOf = (name: string) => [...document.querySelectorAll('section.bc-group')].find((s) => s.querySelector('h2')?.textContent === name)!;
      const over = (el: Element) => {
        const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const refused = over(sectionOf('Growth team'));
      const allowed = over(sectionOf('Retro team'));
      sectionOf('Retro team').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { refused, allowed, moves: (window as unknown as { __moves: unknown[] }).__moves };
    });
    expect(result.refused).toBe(false);
    expect(result.allowed).toBe(true);
    expect(result.moves).toEqual([['retro', 'a']]);
    await page.close();
  });

  it('a drop on a refused section does nothing, and no state is left behind after the drag ends', async () => {
    const page = await open();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      const source = document.querySelector('li.bc-li')!;
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const shared = [...document.querySelectorAll('section.bc-group')].find((s) => s.querySelector('h2')?.textContent === 'Shared with you')!;
      shared.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    expect(await page.evaluate(() => (window as unknown as { __moves: unknown[] }).__moves)).toEqual([]);
    await page.evaluate(() => {
      document.querySelector('li.bc-li')!.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    });
    expect(Object.values(await marks(page)).every((v) => v === '-')).toBe(true);
    await page.close();
  });
});
