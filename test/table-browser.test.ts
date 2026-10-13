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
})()`).then(() => page.waitForFunction(() => { const o = (window as any).__board.store.get('tb1'); return o && o.w > 150 && document.querySelectorAll('svg.canvas line').length > 4; }))
  .then(() => page.evaluate(() => (window as any).__board.zoomToFit())) // the table has its real size now: fit the view to it
  .then(() => page.waitForTimeout(600)); // the camera glides there
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

  // ---------------------------------------------------------------- cells: selecting, rows and columns, style (slice 2)

  const select = (page: Page) => page.evaluate(() => (window as any).__board.setSelection(['tb1']));
  const range = (page: Page) => page.evaluate(() => { const s = (window as any).__board.tables.sel; return s && [s.r0, s.c0, s.r1, s.c1]; });
  const click = async (page: Page, row: number, col: number, shift = false) => {
    const at = await cellBox(page, row, col);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(at.x, at.y);
    if (shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(500); // a second press right after the first counts as a double click, which edits (a minimum gap, not a wait for state)
  };

  it('a click on a selected table selects the cell under it, Shift extends the range, the arrows and Tab move, Esc lets go', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
    await click(page, 1, 1); // not selected yet: this click selects the table and nothing else
    expect(await range(page)).toBeNull();
    await page.waitForTimeout(500); // a second press right after the first counts as a double click, which edits
    await click(page, 1, 1);
    expect(await range(page)).toEqual([1, 1, 1, 1]);
    await click(page, 2, 2, true);
    expect(await range(page)).toEqual([1, 1, 2, 2]);
    await page.keyboard.press('Escape');
    expect(await range(page)).toBeNull();
    await click(page, 0, 0);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    expect(await range(page)).toEqual([1, 1, 1, 1]);
    await page.keyboard.press('Shift+ArrowRight');
    expect(await range(page)).toEqual([1, 1, 1, 2]);
    await page.keyboard.press('Tab'); // from the active cell (the anchor), not from the end of the range
    expect(await range(page)).toEqual([1, 2, 1, 2]);
    await page.keyboard.press('Tab');
    expect(await range(page)).toEqual([2, 0, 2, 0]);
    await page.keyboard.press('Shift+Tab');
    expect(await range(page)).toEqual([1, 2, 1, 2]);
    await page.close();
  });

  it('Enter edits the active cell and Delete empties the selected cells, one undo step', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b'], ['c', 'd']]);
    await select(page);
    await page.waitForTimeout(500);
    await click(page, 0, 1);
    await page.keyboard.press('Enter');
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    expect(await ta.inputValue()).toBe('b');
    await page.keyboard.press('Escape');
    await ta.waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape'); // leaves the cell editor; the selection of cells is gone with it or stays: either way select again
    await select(page);
    await click(page, 0, 0);
    await click(page, 1, 1, true);
    await page.keyboard.press('Delete');
    expect(await grid(page)).toEqual([['', ''], ['', '']]);
    await page.evaluate(() => (window as any).__board.store.undo.undo());
    expect(await grid(page)).toEqual([['a', 'b'], ['c', 'd']]);
    await page.close();
  });

  it('the right-click menu inserts, moves and deletes rows and columns, and sets headers, alignment and fill', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b'], ['c', 'd']]);
    await select(page);
    const menu = async (row: number, col: number, name: string) => {
      const at = await cellBox(page, row, col);
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await page.locator('.ctx-menu button').filter({ hasText: new RegExp(`^${name}$`) }).click();
    };
    await menu(0, 0, 'Insert row below');
    expect(await grid(page)).toEqual([['a', 'b'], ['', ''], ['c', 'd']]);
    await menu(0, 1, 'Insert column left');
    expect(await grid(page)).toEqual([['a', '', 'b'], ['', '', ''], ['c', '', 'd']]);
    await menu(2, 2, 'Move row up');
    expect(await grid(page)).toEqual([['a', '', 'b'], ['c', '', 'd'], ['', '', '']]);
    await menu(2, 1, 'Delete row');
    await menu(0, 1, 'Delete column');
    expect(await grid(page)).toEqual([['a', 'b'], ['c', 'd']]);
    await menu(0, 0, 'Turn on header row');
    await menu(0, 1, 'Align right');
    await page.locator('.ctx-menu button.table-swatch').first(); // placeholder
    {
      const at = await cellBox(page, 1, 0);
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await page.locator('.ctx-menu button[aria-label="Fill Blue"]').click();
    }
    const info = await page.evaluate(`(async () => {
      const { tableModel } = await import('/shared/tables.mjs');
      const o = window.__board.store.get('tb1');
      const m = tableModel(o);
      return { header: o.headerRow, align: m.cols.map((c) => m.align(c)), fill: m.rows.map((r) => m.cols.map((c) => m.fill(r, c))), fitted: Math.abs(o.h - window.__board.store.getPlaced('tb1').h) < 1 };
    })()`) as { header: boolean; align: string[]; fill: (string | null)[][] };
    expect(info.header).toBe(true);
    expect(info.align).toEqual(['left', 'right']);
    expect(info.fill).toEqual([[null, null], ['#A3D2FF', null]]);
    // the fill is drawn, and the text on it in the ink that reads on it
    const drawn = await page.evaluate(() => [...document.querySelectorAll('svg.canvas rect')].some((r) => r.getAttribute('fill') === '#A3D2FF'));
    expect(drawn).toBe(true);
    await page.close();
  });

  it('dragging a column border resizes that column, as one undo step, and the table follows', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b'], ['c', 'd']]);
    await select(page);
    const before = await page.evaluate(() => (window as any).__board.store.get('tb1').w);
    const geom = await page.evaluate(`(async () => {
      const { layoutTable } = await import('/src/table-layout.ts');
      const { tableStyle } = await import('/src/markup.ts');
      const app = window.__board;
      const o = app.store.get('tb1');
      const l = layoutTable(o, tableStyle(o));
      const p = app.r.toScreen({ x: o.x + l.colX[1], y: o.y + l.h / 2 });
      const r = app.r.root.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y, zoom: app.r.cam.zoom };
    })()`) as { x: number; y: number; zoom: number };
    await page.mouse.move(geom.x, geom.y);
    expect(await page.evaluate(() => (window as any).__board.r.svg.style.cursor)).toBe('col-resize');
    await page.mouse.down();
    await page.mouse.move(geom.x + 60 * geom.zoom, geom.y, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => (window as any).__board.store.get('tb1').w);
    expect(after).toBeGreaterThan(before + 40);
    await page.evaluate(() => (window as any).__board.store.undo.undo());
    expect(await page.evaluate(() => (window as any).__board.store.get('tb1').w)).toBe(before);
    await page.close();
  });

  it('copies the selected cells as tab separated text and pastes tab separated text into the selected cell', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b'], ['c', 'd']]);
    await select(page);
    await page.waitForTimeout(500);
    await click(page, 0, 0);
    await click(page, 1, 1, true);
    const copied = await page.evaluate(() => {
      let text = '';
      (navigator as any).clipboard.writeText = async (t: string) => { text = t; };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
      return text;
    });
    expect(copied).toBe('a\tb\nc\td');
    await click(page, 1, 0);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'x\ty\tz');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    expect(await grid(page)).toEqual([['a', 'b', ''], ['x', 'y', 'z']]);
    await page.close();
  });

  // ---------------------------------------------------------------- files, copies and templates (slice 3)

  it('survives a JSON snapshot, a duplicate and a template: every row, column, width, alignment, fill and cell comes back', async () => {
    const page = await open();
    await seedTable(page, [['Name', 'Qty'], ['Apples', '3']]);
    const result = await page.evaluate(`(async () => {
      const { toJson, insertImported } = await import('/src/exporters.ts');
      const { tableModel, setAlignPatch, setFillPatch, setWidthPatch } = await import('/shared/tables.mjs');
      const { toTemplateContent, instantiate } = await import('/src/custom-templates.ts');
      const app = window.__board;
      const base = app.store.get('tb1');
      const m = tableModel(base);
      app.store.update('tb1', { headerRow: true, ...setAlignPatch(base, m.cols[1], 'right'), ...setFillPatch(base, [m.rows[1]], [m.cols[0]], '#BCE88C'), ...setWidthPatch(base, m.cols[0], 240) });
      const read = () => {
        const all = [...app.store.cache.values()].filter((o) => o.type === 'table');
        return all.map((o) => { const t = tableModel(o); return { grid: t.rows.map((r) => t.cols.map((c) => t.cell(r, c))), align: t.cols.map((c) => t.align(c)), fill: t.fill(t.rows[1], t.cols[0]), width: t.width(t.cols[0]), header: o.headerRow === true }; });
      };
      const original = read()[0];
      const json = JSON.parse(JSON.stringify(toJson(app, ['tb1'])));
      app.store.remove(['tb1']);
      insertImported(app, json);
      const fromJson = read();
      app.setSelection([fromJson.length ? [...app.store.cache.values()].find((o) => o.type === 'table').id : '']);
      app.duplicate();
      const afterDuplicate = read();
      const objs = [...app.store.cache.values()].filter((o) => o.type === 'table');
      const content = toTemplateContent(objs.slice(0, 1), [], { includeSteps: false });
      const made = instantiate(content, { x: 900, y: 900 }, 'u1');
      const fromTemplate = made.objects.map((o) => { const t = tableModel(o); return { grid: t.rows.map((r) => t.cols.map((c) => t.cell(r, c))), align: t.cols.map((c) => t.align(c)), fill: t.fill(t.rows[1], t.cols[0]), width: t.width(t.cols[0]), header: o.headerRow === true }; });
      return { original, fromJson, afterDuplicate, fromTemplate };
    })()`) as { original: unknown; fromJson: unknown[]; afterDuplicate: unknown[]; fromTemplate: unknown[] };
    expect(result.original).toMatchObject({ grid: [['Name', 'Qty'], ['Apples', '3']], align: ['left', 'right'], fill: '#BCE88C', width: 240, header: true });
    expect(result.fromJson).toEqual([result.original]);
    expect(result.afterDuplicate).toEqual([result.original, result.original]);
    expect(result.fromTemplate).toEqual([result.original]);
    await page.close();
  });

  it('prints and exports as vector with the cell fills drawn and no selection outline', async () => {
    const page = await open();
    await seedTable(page, [['a', 'b'], ['c', 'd']]);
    await page.evaluate(`(async () => {
      const { tableModel, setFillPatch } = await import('/shared/tables.mjs');
      const app = window.__board;
      const o = app.store.get('tb1');
      const m = tableModel(o);
      app.store.update('tb1', setFillPatch(o, [m.rows[0]], [m.cols[0]], '#A3D2FF'));
      app.setSelection(['tb1']);
      app.tables.select('tb1', 0, 0);
    })()`);
    const svg = await page.evaluate(`(async () => {
      const { exportSvg } = await import('/src/exporters.ts');
      return exportSvg(window.__board, ['tb1']).svg;
    })()`) as string;
    expect(svg).toContain('fill="#A3D2FF"');
    expect(svg).not.toContain('data-table-selection'); // the selection is for the screen, never a file
    expect(svg).not.toContain('foreignObject');
    await page.close();
  });
});
