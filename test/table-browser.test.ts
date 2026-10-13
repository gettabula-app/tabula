import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The table in the real app (TAB-121, docs/tables.md): the G key picks the tool and makes one, a double click edits the cell under it in place, Tab and Shift+Tab move
// between cells (a Tab past the last cell adds a row), Enter is a line break in the cell, Esc leaves, a spreadsheet paste makes a table, the table is
// fitted to its content, and the SVG export draws it as plain SVG.

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

async function open(width = 1280): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(budget(45_000)); // one shared budget (test/wait-budget.ts)
  await page.goto(`${base}?debug#/b/tbl-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  await page.waitForFunction(() => document.querySelector('.rail-btn[aria-label="Sticky note"]'));
  return page;
}

const tables = (page: Page) => page.evaluate(() => [...(window as any).__board.store.cache.values()].filter((o: any) => o.type === 'table'));
/** The cell texts of the first table, row by row, read through the shared model. */
const grid = (page: Page) => page.evaluate(`(async () => {
  const { tableModel } = await import('/shared/tables.mjs');
  const t = [...window.__board.store.cache.values()].find((o) => o.type === 'table');
  const m = tableModel(t);
  return m.rows.map((r) => m.cols.map((c) => m.cell(r, c)));
})()`) as Promise<string[][]>;
const seedTable = (page: Page, cells: string[][]) => page.evaluate(`(async () => {
  const { tableFromGrid } = await import('/shared/tables.mjs');
  const app = window.__board;
  let i = 0;
  const fields = tableFromGrid(${JSON.stringify(cells)}, () => 't' + (++i));
  app.store.transactAs(() => app.store.create({ id: 'tb1', type: 'table', x: 100, y: 100, w: 100, h: 100, rotation: 0, z: app.store.topZ(), font: 'satoshi', ...fields }), 'seed');
  app.zoomToFit();
})()`).then(() => page.waitForFunction(() => { const o = (window as any).__board.store.get('tb1'); return o && o.w > 150 && document.querySelectorAll('svg.canvas line').length > 4; }));
const cellBox = (page: Page, row: number, col: number) => page.evaluate(`(async () => {
  const { layoutTable } = await import('/src/table-layout.ts');
  const { tableStyle } = await import('/src/markup.ts');
  const app = window.__board;
  const o = app.store.get('tb1');
  const l = layoutTable(o, tableStyle(o));
  const c = l.cells.find((x) => x.row === ${row} && x.col === ${col});
  const p = app.r.toScreen({ x: o.x + c.x + c.w / 2, y: o.y + c.y + c.h / 2 });
  const r = app.r.root.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
})()`) as Promise<{ x: number; y: number }>;

describe.skipIf(!available)('the table', () => {
  it('draws the cells as plain SVG text with a grid, a tinted header and no foreignObject', async () => {
    const page = await open();
    await seedTable(page, [['Name', 'Note'], ['Ann', '**bold** and `code`']]);
    await page.evaluate(() => (window as any).__board.store.update('tb1', { headerRow: true }));
    const info = await page.evaluate(() => {
      const svg = document.querySelector('svg.canvas')!;
      return { texts: [...svg.querySelectorAll('text')].map((t) => t.textContent).filter(Boolean), lines: svg.querySelectorAll('line').length, foreign: svg.querySelectorAll('foreignObject').length };
    });
    expect(info.texts).toEqual(expect.arrayContaining(['Name', 'Note', 'Ann', 'bold', 'code']));
    expect(info.lines).toBeGreaterThanOrEqual(6); // 3 horizontal + 3 vertical
    expect(info.foreign).toBe(0);
    await page.close();
  });

  it('is made with the G key: one click makes a 3 x 3 table with its first cell open for typing', async () => {
    const page = await open();
    await page.keyboard.press('g');
    expect(await page.evaluate(() => (window as any).__board.tool.kind)).toBe('table');
    await page.mouse.click(500, 400);
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    await page.keyboard.type('Hello');
    await page.keyboard.press('Escape');
    await ta.waitFor({ state: 'hidden' });
    expect(await tables(page)).toHaveLength(1);
    expect(await grid(page)).toEqual([['Hello', '', ''], ['', '', ''], ['', '', '']]);
    await page.close();
  });

  it('a drag asks for as many rows and columns as fit the box', async () => {
    const page = await open();
    await page.keyboard.press('g');
    await page.mouse.move(300, 200);
    await page.mouse.down();
    await page.mouse.move(300 + 4 * 160, 200 + 2 * 40, { steps: 6 });
    await page.mouse.up();
    await page.locator('textarea.text-editor').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    const g = await grid(page);
    expect([g.length, g[0].length]).toEqual([2, 4]);
    await page.close();
  });

  it('a double click edits the cell under it; Enter is a line break; Tab and Shift+Tab move; Esc leaves; every step reaches the board', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b'], ['c', 'd']]);
    const at = await cellBox(page, 0, 1);
    await page.mouse.dblclick(at.x, at.y);
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    expect(await ta.inputValue()).toBe('b');
    await page.keyboard.type('1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    expect((await grid(page))[0][1]).toBe('b1\ntwo'); // written on every keystroke
    await page.keyboard.press('Tab'); // the next cell in reading order: row 1, column 0
    expect(await ta.inputValue()).toBe('c');
    await page.keyboard.press('Shift+Tab');
    expect(await ta.inputValue()).toBe('b1\ntwo');
    await page.keyboard.press('Escape');
    await ta.waitFor({ state: 'hidden' });
    expect(await grid(page)).toEqual([['a', 'b1\ntwo'], ['c', 'd']]);
    // the table grew to fit the two lines
    const sized = await page.evaluate(`(async () => {
      const { tableBoxSize } = await import('/src/markup.ts');
      const o = window.__board.store.get('tb1');
      const s = tableBoxSize(o);
      return [Math.abs(o.w - s.w) < 1, Math.abs(o.h - s.h) < 1];
    })()`);
    expect(sized).toEqual([true, true]);
    await page.close();
  });

  it('Tab on the last cell adds a row and moves into it', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b'], ['c', 'd']]);
    await page.mouse.dblclick(...Object.values(await cellBox(page, 1, 1)) as [number, number]);
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    await page.keyboard.press('Tab');
    await page.keyboard.type('new');
    await page.keyboard.press('Escape');
    await ta.waitFor({ state: 'hidden' });
    expect(await grid(page)).toEqual([['a', 'b'], ['c', 'd'], ['new', '']]);
    await page.close();
  });

  it('one undo takes back what was typed in a cell', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b'], ['c', 'd']]);
    await page.mouse.dblclick(...Object.values(await cellBox(page, 0, 0)) as [number, number]);
    await page.locator('textarea.text-editor').waitFor({ state: 'visible' });
    await page.keyboard.type('xyz');
    await page.keyboard.press('Escape');
    expect((await grid(page))[0][0]).toBe('axyz');
    await page.evaluate(() => (window as any).__board.store.undo.undo());
    expect((await grid(page))[0][0]).toBe('a');
    await page.close();
  });

  it('a spreadsheet paste (tabs) makes a table; ordinary text is not turned into one', async () => {
    const page = await open();
    const paste = (text: string) => page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
    await paste('plain words, with a comma\nand a second line');
    expect(await tables(page)).toHaveLength(0);
    await paste('Name\tQty\nApples\t3\nPears\t5\n');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'table'));
    expect(await grid(page)).toEqual([['Name', 'Qty'], ['Apples', '3'], ['Pears', '5']]);
    await page.close();
  });

  it('is drawn in the SVG export as plain SVG with its text', async () => {
    const page = await open();
    await seedTable(page, [['Name', 'Note'], ['Ann', 'hello']]);
    const svg = await page.evaluate(`(async () => {
      const { exportSvg } = await import('/src/exporters.ts');
      return exportSvg(window.__board, undefined).svg;
    })()`) as string;
    expect(svg).toContain('>Name<');
    expect(svg).toContain('>hello<');
    expect(svg).not.toContain('foreignObject');
    await page.close();
  });
});
