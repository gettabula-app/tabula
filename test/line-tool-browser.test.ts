import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';
import { openRailTool } from './rail-tool-helper';

// The Line tool in the real app (src/app.ts, src/line-geometry.ts): a line is a connector with both ends free. It is drawn by
// a drag or by two clicks, Shift snaps its angle to 15 degree steps, a label shows its length and angle while it is made,
// the tool returns to Select, a selected line has two endpoint handles and no box, an endpoint drags on its own, and undo
// and redo follow.

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
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?debug#/b/line-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  await page.waitForFunction(() => document.querySelector('.rail-btn[aria-label="Sticky note"]'));
  await page.evaluate(() => (window as any).__board.zoomTo(1));
  return page;
}

/** The screen point of a world point, at the current camera (zoom 1 after open). */
const toScreen = (page: Page, p: { x: number; y: number }) => page.evaluate((w) => {
  const app = (window as any).__board;
  const rect = document.querySelector('svg.canvas')!.getBoundingClientRect();
  const cam = app.r.cam;
  return { x: rect.left + (w.x - cam.x) * cam.zoom, y: rect.top + (w.y - cam.y) * cam.zoom };
}, p);

const tool = (page: Page) => page.evaluate(() => (window as any).__board.tool.kind);
const lines = (page: Page) => page.evaluate(() => [...(window as any).__board.store.cache.values()]
  .filter((o: any) => o.type === 'connector' && o.line === true));

async function drag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }, keys: string[] = []) {
  const from = await toScreen(page, a);
  const to = await toScreen(page, b);
  for (const k of keys) await page.keyboard.down(k);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  for (const k of keys.reverse()) await page.keyboard.up(k);
}

describe.skipIf(!available)('the Line tool in the board', { timeout: 300_000 }, () => {
  it('is picked with Shift+L, which is not the Connector key', async () => {
    const page = await open();
    await page.keyboard.press('Shift+L');
    expect(await tool(page)).toBe('line');
    expect(await page.locator('.board-surface').getAttribute('data-tool')).toBe('line');
    expect(await page.locator('.rail-connector-group').getAttribute('aria-label')).toBe('Line');
    await page.keyboard.press('L');
    expect(await tool(page)).toBe('connector');
    await page.context().close();
  });

  it('draws a line by dragging, leaves both ends free, and returns to Select', async () => {
    const page = await open();
    await page.keyboard.press('Shift+L');
    await drag(page, { x: 200, y: 200 }, { x: 360, y: 260 });
    const [line] = await lines(page);
    expect(line).toBeDefined();
    expect(line.route).toBe('straight');
    expect(line.startHead).toBe('none');
    expect(line.endHead).toBe('none');
    expect(line.from.kind).toBe('free');
    expect(line.to.kind).toBe('free');
    // within a grid step of where it was dragged (snapping may move an end)
    expect(Math.abs(line.from.x - 200)).toBeLessThanOrEqual(12);
    expect(Math.abs(line.to.y - 260)).toBeLessThanOrEqual(12);
    expect(await tool(page)).toBe('select');
    await page.context().close();
  });

  it('starts with a click and ends with a second click, showing the length and angle while it is made', async () => {
    const page = await open();
    await page.keyboard.press('Shift+L');
    const a = await toScreen(page, { x: 400, y: 400 });
    const b = await toScreen(page, { x: 400 + 120, y: 400 - 70 });
    await page.mouse.click(a.x, a.y);
    await page.mouse.move(b.x, b.y, { steps: 6 });
    // the label is in the preview: its length and angle (from the start, counter-clockwise, as the user sees it)
    const label = page.locator('svg.canvas text', { hasText: 'px ·' });
    await label.waitFor({ timeout: budget(10_000) });
    expect(await label.textContent()).toMatch(/^\d+ px · \d+°$/);
    expect(await lines(page)).toHaveLength(0);
    await page.mouse.click(b.x, b.y);
    expect(await lines(page)).toHaveLength(1);
    expect(await tool(page)).toBe('select');
    await page.context().close();
  });

  it('snaps the angle to 15 degree steps while Shift is held', async () => {
    const page = await open();
    await page.keyboard.press('Shift+L');
    // a line near 40 degrees counter-clockwise: Shift takes it to 45, with the same length
    const start = { x: 500, y: 250 };
    const far = { x: 500 + 200 * Math.cos((41 * Math.PI) / 180), y: 250 - 200 * Math.sin((41 * Math.PI) / 180) };
    await drag(page, start, far, ['Shift']);
    const [line] = await lines(page);
    const dx = line.to.x - line.from.x, dy = line.to.y - line.from.y;
    const angle = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    expect(Math.abs(angle - Math.round(angle / 15) * 15)).toBeLessThan(0.5);
    expect(Math.round(angle)).toBe(45);
    await page.context().close();
  });

  it('shows exactly two endpoint handles and no bounding box when selected, and an endpoint drags on its own', async () => {
    const page = await open();
    await page.keyboard.press('Shift+L');
    await drag(page, { x: 300, y: 300 }, { x: 420, y: 300 });
    await page.keyboard.press('Escape');
    const [line] = await lines(page);
    // select it with a click on its middle
    const mid = await toScreen(page, { x: (line.from.x + line.to.x) / 2, y: (line.from.y + line.to.y) / 2 });
    await page.mouse.click(mid.x, mid.y);
    await page.waitForFunction(() => (window as any).__board.selection.length === 1);
    const handles = page.locator('svg.canvas circle[fill="var(--selection-handle-fill)"]');
    await expect.poll(() => handles.count()).toBe(2);
    expect(await page.locator('svg.canvas rect[stroke="var(--wire)"]').count()).toBe(0);
    expect(await page.locator('svg.canvas path.line-halo').count()).toBe(1);

    const end = await toScreen(page, { x: line.to.x, y: line.to.y });
    await page.mouse.move(end.x, end.y);
    await page.mouse.down();
    const target = await toScreen(page, { x: line.to.x + 40, y: line.to.y - 90 });
    await page.mouse.move(target.x, target.y, { steps: 6 });
    await page.mouse.up();
    const moved = (await lines(page))[0];
    expect(moved.to.kind).toBe('free');
    expect(moved.from).toEqual(line.from);
    expect(moved.to.y).toBeLessThan(line.to.y - 40);
    await page.context().close();
  });

  it('undoes and redoes a drawn line', async () => {
    const page = await open();
    await page.keyboard.press('Shift+L');
    await drag(page, { x: 200, y: 260 }, { x: 320, y: 300 });
    expect(await lines(page)).toHaveLength(1);
    await page.evaluate(() => (window as any).__board.store.undo.undo());
    expect(await lines(page)).toHaveLength(0);
    await page.evaluate(() => (window as any).__board.store.undo.redo());
    expect(await lines(page)).toHaveLength(1);
    await page.context().close();
  });

  it('is picked from the Connectors and lines flyout as Line, and Connector stays the other choice', async () => {
    const page = await open();
    await openRailTool(page, 'Line');
    expect(await tool(page)).toBe('line');
    expect(await page.locator('.rail-connector-group').getAttribute('aria-label')).toBe('Line');
    await openRailTool(page, 'Connector');
    expect(await tool(page)).toBe('connector');
    expect(await page.locator('.rail-connector-group').getAttribute('aria-label')).toBe('Connector');
    await page.context().close();
  });

  it('shows a line panel with its heads, colour, width and style, and no route or label', async () => {
    const page = await open();
    await page.keyboard.press('Shift+L');
    await drag(page, { x: 600, y: 250 }, { x: 720, y: 270 });
    const [line] = await lines(page);
    await page.evaluate((id) => (window as any).__board.setSelection([id]), line.id);
    await page.getByRole('button', { name: 'More properties' }).click();
    const panel = page.locator('.props');
    await expect.poll(() => panel.locator('h2').textContent()).toBe('Line');
    const text = (await panel.textContent()) ?? '';
    for (const row of ['Start', 'End', 'Stroke colour', 'Width', 'Style']) expect(text.includes(row)).toBe(true);
    expect(text).not.toContain('Route');
    expect(await panel.locator('[aria-label="Connector label"]').count()).toBe(0);
    expect(await panel.locator('[aria-label="Connector route"]').count()).toBe(0);
    await page.context().close();
  });

  it('cancels a pending first click with Escape, and makes nothing from a click without movement', async () => {
    const page = await open();
    await page.keyboard.press('Shift+L');
    const a = await toScreen(page, { x: 600, y: 300 });
    await page.mouse.click(a.x, a.y);
    await page.keyboard.press('Escape');
    expect(await tool(page)).toBe('select');
    await page.mouse.click(a.x + 60, a.y + 60);
    expect(await lines(page)).toHaveLength(0);
    await page.context().close();
  });
});
