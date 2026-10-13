import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// A reload never moves an object (docs/geometry-heal.md): objects of every type are placed, dragged somewhere else, the page is reloaded and each one is where it was
// put, also after its height has been corrected by the app (link card, Markdown block, table, UML class). And when something deletes an object's position, the position
// is written back instead of the object jumping to the origin.

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

const IDS = ['uml', 'lnk', 'md', 'tbl', 'img', 'stk', 'ini'];

async function open(): Promise<{ page: Page; url: string }> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(budget(45_000));
  await page.route('**/api/boards/*/unfurl', (route) => route.fulfill({ contentType: 'application/json', body: '{}' }));
  const url = `${base}?debug#/b/pos-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  return { page, url };
}

const seed = (page: Page) => page.evaluate(`(async () => {
  const { tableFromGrid } = await import('/shared/tables.mjs');
  const app = window.__board; const s = app.store;
  let n = 0;
  const table = tableFromGrid([['a', 'b'], ['c', 'd']], () => 't' + (++n));
  s.transactAs(() => {
    s.create({ id: 'uml', type: 'uml-class', x: 100, y: 100, w: 220, h: 120, rotation: 0, z: s.topZ(), text: 'Order', attributes: [{ visibility: '-', name: 'id', type: 'UUID' }], operations: [{ visibility: '+', name: 'submit()', type: 'void' }], font: 'satoshi' });
    s.create({ id: 'lnk', type: 'link', x: 400, y: 100, w: 320, h: 112, rotation: 0, z: s.topZ(), url: 'https://www.youtube.com/watch?v=x', unfurl: 'ok', title: 'A video', font: 'satoshi' });
    s.create({ id: 'md', type: 'markdown', x: 800, y: 100, w: 360, h: 100, rotation: 0, z: s.topZ(), text: '# Title\\n\\nSome text\\n\\n- a\\n- b', font: 'satoshi' });
    s.create({ id: 'tbl', type: 'table', x: 100, y: 400, w: 100, h: 100, rotation: 0, z: s.topZ(), font: 'satoshi', ...table });
    s.create({ id: 'img', type: 'image', x: 500, y: 400, w: 156, h: 156, rotation: 0, z: s.topZ(), asset: 'a'.repeat(64), mime: 'image/png', font: 'satoshi' });
    s.create({ id: 'stk', type: 'sticky', x: 800, y: 400, w: 192, h: 192, rotation: 0, z: s.topZ(), text: 'note', fill: '#FFE16B', font: 'satoshi' });
    s.create({ id: 'ini', type: 'uml-initial', x: 1100, y: 400, w: 28, h: 28, rotation: 0, z: s.topZ(), font: 'satoshi' });
  }, 'seed');
  app.zoomToFit();
})()`);
const geometry = (page: Page) => page.evaluate((ids) => Object.fromEntries(ids.map((id) => { const o = (window as any).__board.store.get(id); return [id, o ? [Math.round(o.x), Math.round(o.y), Math.round(o.w)] : null]; })), IDS);
const drag = async (page: Page, id: string, dx: number, dy: number) => {
  const c = await page.evaluate((i) => { const app = (window as any).__board; const o = app.store.get(i); const p = app.r.toScreen({ x: o.x + o.w / 2, y: o.y + o.h / 2 }); const r = app.r.root.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y, zoom: app.r.cam.zoom }; }, id);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dx * c.zoom, c.y + dy * c.zoom, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(450); // a second press right after the first counts as a double click (a minimum gap, not a wait for state)
};
const reload = async (page: Page) => {
  await page.waitForTimeout(1200); // the local copy is written a moment after a change
  await page.reload();
  await page.waitForFunction((ids) => ids.every((id) => (window as any).__board?.store.get(id)), IDS, { timeout: budget(20_000) });
  await page.waitForTimeout(1500); // the app's own corrections of heights have run
};

describe.skipIf(!available)('a reload never moves an object', () => {
  it('every type is where it was put after being dragged and the page reloaded, twice', async () => {
    const { page } = await open();
    await seed(page);
    await page.waitForTimeout(1200);
    for (const [i, id] of IDS.entries()) await drag(page, id, 40 + i * 10, 120 + i * 15);
    const before = await geometry(page);
    await reload(page);
    const once = await geometry(page);
    await reload(page);
    const twice = await geometry(page);
    for (const id of IDS) {
      expect(once[id], `${id} after one reload`).toEqual(before[id]);
      expect(twice[id], `${id} after two reloads`).toEqual(before[id]);
    }
    await page.close();
  });

  it('an object whose position is deleted underneath the app is put back, not left at the origin, also after a reload', async () => {
    const { page } = await open();
    await seed(page);
    await page.waitForTimeout(1000);
    const before = await geometry(page);
    await page.evaluate(() => {
      const app = (window as any).__board;
      app.store.doc.transact(() => { for (const id of ['uml', 'lnk', 'ini']) { const m = app.store.objects.get(id); m.delete('x'); m.delete('y'); m.delete('updatedAt'); } }, 'remote');
    });
    await page.waitForTimeout(600);
    expect(await geometry(page)).toEqual(before);
    await reload(page);
    expect(await geometry(page)).toEqual(before);
    await page.close();
  });

  it('survives undoing and redoing the placements, then a reload', async () => {
    const { page } = await open();
    await seed(page);
    await page.waitForTimeout(1000);
    for (const id of ['uml', 'lnk', 'ini']) await drag(page, id, 60, 150);
    const placed = await geometry(page);
    await page.evaluate(() => { const u = (window as any).__board.store.undo; for (let i = 0; i < 3; i++) u.undo(); });
    await page.waitForTimeout(500);
    await page.evaluate(() => { const u = (window as any).__board.store.undo; for (let i = 0; i < 3; i++) u.redo(); });
    await page.waitForTimeout(500);
    expect(await geometry(page)).toEqual(placed);
    await reload(page);
    expect(await geometry(page)).toEqual(placed);
    await page.close();
  });
});
