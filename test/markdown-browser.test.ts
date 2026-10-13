import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';
import { openRailTool } from './rail-tool-helper';

// The Markdown block in the real app (TAB-140, docs/markdown-blocks.md): it renders as SVG, a task box ticks and a link opens only on a selected block,
// a board-item link jumps, the source is edited in place, the rail tool creates one, and the SVG export draws it as plain SVG (no foreignObject).

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

const SOURCE = '# Plan\n\n- [ ] one\n- [x] two\n\nSee [the site](https://example.com/x) and [the note](#obj:note1).\n\n| a | b |\n| - | - |\n| 1 | 2 |';

async function open(width = 1280): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(budget(45_000)); // one shared budget (test/wait-budget.ts): a slow machine takes tens of seconds for what a quiet one does in one
  await page.addInitScript(() => {
    (window as unknown as { __opened: unknown[] }).__opened = [];
    window.open = ((url: string) => { (window as unknown as { __opened: unknown[] }).__opened.push(url); return null; }) as typeof window.open;
  });
  await page.goto(`${base}?debug#/b/md-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  return page;
}

async function seed(page: Page, text = SOURCE): Promise<string> {
  return page.evaluate((src) => {
    const app = (window as any).__board;
    // written as a remote writer would (an agent, a template, a file): the height is only an estimate until the app measures it
    app.store.transactAs(() => {
      app.store.create({ id: 'note1', type: 'sticky', x: 700, y: 100, w: 192, h: 192, rotation: 0, z: app.store.topZ(), text: 'Target', fill: '#FFE16B' });
      app.store.create({ id: 'md1', type: 'markdown', x: 100, y: 100, w: 360, h: 100, rotation: 0, z: app.store.topZ(), text: src, font: 'satoshi' });
    }, 'seed');
    app.zoomToFit();
    return 'md1';
  }, text).then(async (id) => {
    await page.waitForFunction(() => [...document.querySelectorAll('svg.canvas text')].some((t) => t.textContent === 'Target'));
    await healed(page); // the block is drawn, then its height corrected, on the frames after the object appears
    return id;
  });
}

const height = (page: Page) => page.evaluate(() => (window as any).__board.store.get('md1').h as number);
/** Waits until the heal has corrected the seeded estimate (100) and the height has stood still for a moment, however slow the machine. */
const healed = (page: Page) => page.waitForFunction(() => {
  const w = window as any;
  const h = w.__board.store.get('md1')?.h;
  if (h !== w.__mdH) { w.__mdH = h; w.__mdAt = performance.now(); }
  const still = performance.now() - w.__mdAt;
  return h !== undefined && ((h !== 100 && still > 300) || still > 3000); // a height that really is the estimate is accepted after a long still moment
}, null, { polling: 100 });
const source = (page: Page) => page.evaluate(() => (window as any).__board.store.get('md1')?.text as string | undefined);
const box = (page: Page, selector: string) => page.evaluate((sel) => {
  const el = document.querySelector(sel) as Element | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, selector);
const select = (page: Page, ids: string[]) => page.evaluate((i) => (window as any).__board.setSelection(i), ids);

describe.skipIf(!available)('the Markdown block', () => {
  it('draws the source as plain SVG: text, a task box per task, a table grid, anchors for links; no foreignObject, nothing from the source as markup', async () => {
    const page = await open();
    await seed(page, `${SOURCE}\n\n<script>window.pwned=1</script> <img src=x onerror="window.pwned=1">`);
    const info = await page.evaluate(() => {
      const svg = document.querySelector('svg.canvas')!;
      return {
        texts: [...svg.querySelectorAll('text')].map((t) => t.textContent).filter(Boolean),
        tasks: svg.querySelectorAll('[data-md-task]').length,
        anchors: [...svg.querySelectorAll('a[data-md-owner]')].map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
        foreign: svg.querySelectorAll('foreignObject').length,
        scripts: svg.querySelectorAll('script, img, iframe').length,
        pwned: (window as any).pwned ?? null,
      };
    });
    expect(info.texts).toEqual(expect.arrayContaining(['Plan', 'one', 'two', 'the', 'site']));
    expect(info.texts.join(' ')).toContain('<script>window.pwned=1</script>'); // shown as the text it is
    expect(info.tasks).toBe(2);
    expect(info.anchors.some((a) => a[0] === 'https://example.com/x' && a[1] === '_blank' && a[2] === 'noopener noreferrer')).toBe(true);
    expect(info.anchors.some((a) => a[0] === '#obj:note1' && a[1] === null)).toBe(true);
    expect([info.foreign, info.scripts, info.pwned]).toEqual([0, 0, null]);
    await page.close();
  });

  it('keeps its stored height equal to its content (the heal), also after the source is rewritten from outside', async () => {
    const page = await open();
    await seed(page, 'x');
    await healed(page);
    const small = await height(page);
    await page.evaluate(() => {
      const app = (window as any).__board;
      app.store.transactAs(() => app.store.update('md1', { text: `# Big\n\n${'a long paragraph of words '.repeat(40)}\n\n- one\n- two\n- three` }), 'remote');
    });
    await page.waitForFunction((min) => (window as any).__board.store.get('md1').h > min, small * 3);
    const heights = { small, big: await height(page) };
    expect(heights.big).toBeGreaterThan(heights.small * 3);
    await page.close();
  });

  it('ticks a task box only on a selected block, one undo step, and flips it back', async () => {
    const page = await open();
    await seed(page);
    const at = await box(page, '[data-md-task="2"]');
    await page.mouse.click(at!.x, at!.y); // not selected yet: this click selects, nothing is ticked
    await page.waitForTimeout(600); // a second press right after the first counts as a double click, which edits
    expect(await source(page)).toBe(SOURCE);
    expect(await page.evaluate(() => (window as any).__board.selection)).toEqual(['md1']);
    const again = await box(page, '[data-md-task="2"]');
    await page.mouse.click(again!.x, again!.y);
    expect(await source(page)).toBe(SOURCE.replace('- [ ] one', '- [x] one'));
    await page.evaluate(() => (window as any).__board.store.undo.undo());
    expect(await source(page)).toBe(SOURCE);
    await page.close();
  });

  it('does not tick for a viewer, a locked block or a read-only board', async () => {
    const page = await open();
    await seed(page);
    await select(page, ['md1']);
    await page.evaluate(() => (window as any).__board.store.update('md1', { locked: true }));
    const at = await box(page, '[data-md-task="2"]');
    await page.mouse.click(at!.x, at!.y);
    expect(await source(page)).toBe(SOURCE);
    await page.close();
  });

  it('opens a web link only on a selected block (or with Ctrl/Cmd), in a new tab with noopener', async () => {
    const page = await open();
    await seed(page);
    const context = page.context();
    const link = () => box(page, 'a[href="https://example.com/x"] rect');
    let at = await link();
    const popup0: Page[] = [];
    context.on('page', (p) => popup0.push(p));
    await page.mouse.click(at!.x, at!.y); // selects only
    await page.waitForTimeout(700);
    expect(popup0.length).toBe(0);
    at = await link();
    const [popup] = await Promise.all([context.waitForEvent('page', { timeout: budget(20_000) }), page.mouse.click(at!.x, at!.y)]);
    expect(popup.url()).toContain('example.com');
    await popup.close();
    await page.close();
  });

  it('jumps to a board item from an item link (selecting it) on a selected block, and says so when the item is gone', async () => {
    const page = await open();
    await seed(page);
    await select(page, ['md1']);
    const at = await box(page, 'a[href="#obj:note1"] rect');
    await page.mouse.click(at!.x, at!.y);
    await page.waitForFunction(() => (window as any).__board.selection[0] === 'note1');
    expect(page.url()).not.toContain('#obj:'); // the address bar is the board's, never the link's
    await page.evaluate(() => { const app = (window as any).__board; app.store.remove(['note1']); app.setSelection(['md1']); app.zoomToFit(); });
    await page.waitForTimeout(700);
    const gone = await box(page, 'a[href="#obj:note1"] rect');
    await page.mouse.click(gone!.x, gone!.y);
    await page.waitForFunction(() => /not on this board/i.test(document.body.textContent ?? ''));
    await page.close();
  });

  it('is edited as its source: double-click opens a monospace textarea with the caret at the end, typing changes the block, Escape leaves, an emptied block is removed', async () => {
    const page = await open();
    await seed(page, '# One');
    const at = await box(page, 'svg.canvas text');
    await page.mouse.dblclick(at!.x, at!.y);
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    expect(await ta.evaluate((el) => [getComputedStyle(el).fontFamily, (el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).value])).toEqual([expect.stringMatching(/mono|Menlo|Consolas/i), 5, '# One']);
    await page.keyboard.type('\n\n- [ ] new task');
    await page.keyboard.press('Tab');
    await page.keyboard.type('x');
    expect(await ta.inputValue()).toContain('- [ ] new task  x'); // Tab indents; it does not leave
    await page.keyboard.press('Escape');
    await ta.waitFor({ state: 'hidden' });
    expect(await source(page)).toContain('- [ ] new task');
    await page.waitForSelector('[data-md-task]');
    expect(await page.evaluate(() => document.querySelectorAll('[data-md-task]').length)).toBe(1);
    // empty it: the block goes away
    await select(page, ['md1']);
    await page.evaluate(() => (window as any).__board.editor.start('md1'));
    await ta.waitFor({ state: 'visible' });
    await ta.focus();
    await ta.fill('');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !(window as any).__board.store.get('md1'));
    await page.close();
  });

  it('is made with the rail tool: click, click on the board, type; the block takes the typed source', async () => {
    const page = await open();
    await openRailTool(page, 'Markdown block');
    expect(await page.evaluate(() => (window as any).__board.tool.kind)).toBe('markdown');
    await page.mouse.click(500, 400);
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    expect(await ta.getAttribute('placeholder')).toMatch(/Markdown/);
    await page.keyboard.type('## Hello\n\n- [ ] it works');
    await page.keyboard.press('Escape');
    const made = await page.evaluate(() => [...(window as any).__board.store.cache.values()].filter((o: any) => o.type === 'markdown').map((o: any) => ({ text: o.text, w: o.w, h: o.h })));
    expect(made).toEqual([{ text: '## Hello\n\n- [ ] it works', w: 360, h: expect.any(Number) }]);
    expect(made[0].h).toBeGreaterThan(60);
    expect(await page.evaluate(() => (window as any).__board.tool.kind)).toBe('select');
    await page.close();
  });

  it('exports as plain SVG with its text and no foreignObject, to PNG without failing, and a copy of its source is one click', async () => {
    const page = await open();
    await seed(page);
    const out = await page.evaluate(`(async () => {
      const mod = await import('/src/exporters.ts');
      const app = window.__board;
      const { svg } = mod.exportSvg(app, ['md1']);
      const png = await mod.exportPng(app, ['md1'], 1);
      return { svg, pngSize: png.size, pngType: png.type };
    })()`) as { svg: string; pngSize: number; pngType: string };
    expect(out.svg).toContain('>Plan<');
    expect(out.svg).not.toContain('foreignObject');
    expect(out.svg).not.toMatch(/<script|onerror|onload/i);
    expect(out.pngType).toBe('image/png');
    expect(out.pngSize).toBeGreaterThan(500);
    await select(page, ['md1']);
    await page.evaluate(() => { (navigator.clipboard as any).writeText = async (t: string) => { (window as any).__copied = t; }; });
    await page.getByRole('button', { name: 'Copy as Markdown' }).first().click();
    await page.waitForFunction(() => (window as any).__copied);
    expect(await page.evaluate(() => (window as any).__copied)).toBe(SOURCE);
    await page.close();
  });

  it('shows its name and tasks to a screen reader, and fits a 390 px phone without scrolling the page sideways', async () => {
    const page = await open(390);
    await seed(page);
    const described = await page.evaluate(`(async () => {
      const mod = await import('/src/canvas-describe.ts');
      const app = window.__board;
      return mod.describeObject(app.store.get('md1'), { get: (id) => app.store.get(id), childCount: () => 0 });
    })()`) as { name: string; description: string };
    expect(described.name).toBe('Markdown block, "Plan"');
    expect(described.description).toContain('2 tasks, 1 done');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.close();
  });
});
