import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';
import { openRailTool } from './rail-tool-helper';

// The code block in the real app (docs/code-blocks.md): made with the rail tool, typed in place (Tab, Enter, Esc), its properties, Copy and Wrap, the keyboard,
// a read-only board, the export, and the textarea sitting exactly on the drawn code at three zoom levels.

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

const SRC = 'const a = 1;\nfunction f() {\n  return a;\n}';
const LONG = `const long = "${'x'.repeat(160)}";`;

async function open(opts: { width?: number; height?: number; mobile?: boolean; board?: string } = {}): Promise<Page> {
  const context = await browser!.newContext({
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(budget(45_000));
  await page.addInitScript(() => {
    (navigator.clipboard ?? ((navigator as any).clipboard = {})).writeText = async (t: string) => { (window as any).__copied = t; };
  });
  await page.goto(`${base}?debug#/b/${opts.board ?? `code-${Math.random().toString(36).slice(2, 8)}`}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  return page;
}

async function seed(page: Page, extra: Record<string, unknown> = {}): Promise<string> {
  await page.evaluate((x) => {
    const app = (window as any).__board;
    app.store.transactAs(() => {
      app.store.create({ id: 'c1', type: 'code', x: 100, y: 100, w: 520, h: 100, rotation: 0, z: app.store.topZ(), text: 'const a = 1;\nfunction f() {\n  return a;\n}', lang: 'ts', lines: false, wrap: false, ...x });
    }, 'seed');
    app.zoomTo(1);
    app.r.setCamera({ x: 0, y: 0 });
  }, extra);
  await page.waitForFunction(() => document.querySelector('svg.canvas .code-block'));
  await settled(page);
  return 'c1';
}

/** Waits until the height heal has fitted the block and the frame drew it. */
const settled = (page: Page) => page.waitForFunction(() => {
  const w = window as any;
  const h = w.__board.store.get('c1')?.h;
  if (h !== w.__cH) { w.__cH = h; w.__cAt = performance.now(); }
  return h !== undefined && h !== 100 && performance.now() - w.__cAt > 250;
}, null, { polling: 80 });

const obj = (page: Page, id = 'c1') => page.evaluate((i) => ({ ...(window as any).__board.store.get(i) }), id);
const screenOf = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => {
  const app = (window as any).__board;
  const p = app.r.toScreen({ x: px, y: py });
  const r = app.r.root.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, [x, y]);
/** The textarea is focused a frame after it opens: typing before that would go to the page. */
const typing = (page: Page) => page.waitForFunction(() => document.activeElement === document.querySelector('textarea.text-editor'));
const select = (page: Page, ids: string[]) => page.evaluate((i) => (window as any).__board.setSelection(i), ids);
const hover = async (page: Page, id = 'c1') => {
  const o = await obj(page, id);
  const at = await screenOf(page, o.x + o.w / 2, o.y + o.h / 2);
  await page.mouse.move(at.x, at.y);
  await page.waitForFunction((i) => document.querySelector(`.code-ctl[data-id="${i}"]`)?.classList.contains('hot'), id);
};

describe.skipIf(!available)('the code block in the rail', { timeout: 200_000 }, () => {
  it('is the fifth item of the Text and content flyout, with no key, and the flyout fits a 720px window', async () => {
    const page = await open({ height: 720 });
    await page.locator('.rail-tool-group').waitFor();
    await page.locator('.rail-group-chevron').click();
    const flyout = page.locator('.rail-tool-pop');
    expect(await flyout.getAttribute('aria-label')).toBe('Text and content tools');
    const items = await flyout.getByRole('menuitem').evaluateAll((els) => els.map((e) => [e.getAttribute('aria-label'), e.getAttribute('aria-keyshortcuts')]));
    expect(items).toEqual([['Text', 'T'], ['Table', 'G'], ['Markdown block', null], ['Link', null], ['Code block', null]]);
    const r = await flyout.boundingBox();
    expect(r!.y).toBeGreaterThanOrEqual(0);
    expect(r!.y + r!.height).toBeLessThanOrEqual(720);
    // remembered choice and chevron work as for the others
    await page.getByRole('menuitem', { name: 'Code block' }).click();
    const group = page.locator('.rail-tool-group');
    expect(await group.getAttribute('data-tool')).toBe('code');
    expect(await group.getAttribute('aria-label')).toBe('Code block');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('driftboard:rail-tool-group:text-markdown-link'))).toBe('code');
    await page.context().close();
  });
});

describe.skipIf(!available)('creating and typing code', { timeout: 200_000 }, () => {
  it('a click with the tool makes a block in the last language used, opens it for typing; Tab, Enter and Esc work; it survives a reload', async () => {
    const board = `code-rel-${Math.random().toString(36).slice(2, 8)}`;
    const page = await open({ board });
    await openRailTool(page, 'Code block');
    await page.mouse.click(500, 300);
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    expect(await ta.getAttribute('data-kind')).toBe('code');
    expect(await ta.getAttribute('maxlength')).toBe('20000');
    expect(await page.evaluate(() => (window as any).__board.tool.kind)).toBe('select');
    let made = await page.evaluate(() => [...(window as any).__board.store.cache.values()].filter((o: any) => o.type === 'code').map((o: any) => ({ ...o })));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ lang: 'plaintext', wrap: false, lines: false, text: '', w: 520 });
    await page.keyboard.type('if (x) {');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('go();');
    await page.keyboard.press('Enter');
    await page.keyboard.type('more');
    await page.keyboard.press('Shift+Tab');
    expect(await ta.inputValue()).toBe('if (x) {\n  go();\nmore');
    await page.keyboard.press('Escape');
    await ta.waitFor({ state: 'hidden' });
    const id = made[0].id;
    expect((await obj(page, id)).text).toBe('if (x) {\n  go();\nmore');
    await page.evaluate((i) => { const app = (window as any).__board; app.store.update(i, { lang: 'python', title: 'Demo', lines: true, wrap: true }); }, id);
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForFunction((i) => (window as any).__board?.store.get(i), id, { timeout: budget(20_000) });
    expect(await obj(page, id)).toMatchObject({ text: 'if (x) {\n  go();\nmore', lang: 'python', title: 'Demo', lines: true, wrap: true });
    await page.context().close();
  });

  it('commits on Cmd/Ctrl+Enter and on blur; a block left empty goes away; one undo step undoes a whole session', async () => {
    const page = await open();
    await seed(page);
    await page.evaluate(() => (window as any).__board.editor.start('c1'));
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    await typing(page);
    await page.keyboard.type('\n// one');
    await page.waitForTimeout(500); // longer than the usual undo grouping
    await page.keyboard.type('\n// two');
    await page.keyboard.press('Control+Enter');
    await ta.waitFor({ state: 'hidden' });
    expect((await obj(page)).text).toBe(`${SRC}\n// one\n// two`);
    await page.evaluate(() => (window as any).__board.store.undo.undo());
    expect((await obj(page)).text).toBe(SRC);
    // blur commits
    await page.evaluate(() => (window as any).__board.editor.start('c1'));
    await ta.waitFor({ state: 'visible' });
    await typing(page);
    await page.keyboard.type('x');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await ta.waitFor({ state: 'hidden' });
    expect((await obj(page)).text).toBe(`${SRC}x`);
    // emptied: gone
    await page.evaluate(() => (window as any).__board.editor.start('c1'));
    await ta.waitFor({ state: 'visible' });
    await ta.fill('');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !(window as any).__board.store.get('c1'));
    await page.context().close();
  });

  it('cuts a paste at 20,000 characters and says so', async () => {
    const page = await open();
    await seed(page);
    await page.evaluate(() => (window as any).__board.editor.start('c1'));
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    await ta.focus();
    await page.evaluate(() => {
      const t = document.querySelector('textarea.text-editor') as HTMLTextAreaElement;
      t.setSelectionRange(0, t.value.length);
      const data = new DataTransfer();
      data.setData('text/plain', 'y'.repeat(25000));
      t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => /20,000 characters/.test(document.body.textContent ?? ''));
    expect(await page.locator('.toast').textContent()).toContain('20,000 characters');
    await page.context().close();
  });

  it('wraps by default on a coarse pointer', async () => {
    const page = await open({ width: 390, height: 800, mobile: true });
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await openRailTool(page, 'Code block');
    await page.mouse.click(200, 300);
    await page.locator('textarea.text-editor').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); // empty: removed. The tool made one first:
    await page.evaluate(() => {
      const app = (window as any).__board;
      app.setTool({ kind: 'code' });
    });
    await page.mouse.click(200, 400);
    await page.keyboard.type('a');
    const o = await page.evaluate(() => [...(window as any).__board.store.cache.values()].find((x: any) => x.type === 'code'));
    expect(o.wrap).toBe(true);
    await page.context().close();
  });
});

describe.skipIf(!available)('the textarea sits on the drawn code', { timeout: 200_000 }, () => {
  for (const zoom of [0.5, 1, 2]) {
    it(`within 1px at zoom ${zoom}: the box, and the first line's text`, async () => {
      const page = await open();
      await seed(page, { title: 'Demo', lines: true, text: 'const answer = 42;\nreturn answer;' });
      await page.evaluate((z) => { const app = (window as any).__board; app.zoomTo(z); app.r.setCamera({ x: 40, y: 40 }); }, zoom);
      await page.waitForTimeout(300);
      const drawn = await page.evaluate(() => {
        const t = [...document.querySelectorAll('svg.canvas .code-text text')][0].getBoundingClientRect();
        return { top: t.top, left: t.left };
      });
      await page.evaluate(() => (window as any).__board.editor.start('c1'));
      const ta = page.locator('textarea.text-editor');
      await ta.waitFor({ state: 'visible' });
      await page.waitForTimeout(150);
      const m = await page.evaluate(`(async () => {
        const app = window.__board;
        const o = app.store.get('c1');
        const { layoutCode } = await import('/src/code-layout.ts');
        const L = layoutCode(o);
        const el = document.querySelector('textarea.text-editor');
        const r = el.getBoundingClientRect();
        const z = app.r.cam.zoom;
        const root = app.r.root.getBoundingClientRect();
        const want = app.r.toScreen({ x: o.x + L.textX, y: o.y + L.top });
        // where the face puts a line's glyph box inside a row of this height: measured with the same face and line height in a probe
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:0;top:0;white-space:pre;font:400 13px ' + getComputedStyle(el).fontFamily + ';line-height:' + L.lineH + 'px;font-variant-ligatures:none';
        probe.textContent = 'M';
        document.body.appendChild(probe);
        const range = document.createRange();
        range.selectNodeContents(probe.firstChild);
        const halfLeading = range.getBoundingClientRect().top - probe.getBoundingClientRect().top;
        probe.remove();
        const cs = getComputedStyle(el);
        const scale = new DOMMatrix(cs.transform).a;
        return {
          dLeft: r.left - (root.left + want.x), dTop: r.top - (root.top + want.y), width: r.width, wantW: L.textW * z,
          glyphTop: r.top + halfLeading * z, glyphLeft: r.left, fontPx: parseFloat(cs.fontSize) * scale, linePx: parseFloat(cs.lineHeight) * scale,
          wantFont: 13 * z, wantLine: L.lineH * z, bg: cs.backgroundColor, outline: cs.outlineStyle, border: cs.borderTopWidth, resize: cs.resize, ring: cs.boxShadow,
        };
      })()`) as any;
      expect(Math.abs(m.dLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.dTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.width - m.wantW)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.fontPx - m.wantFont)).toBeLessThan(0.1);
      expect(Math.abs(m.linePx - m.wantLine)).toBeLessThan(0.1);
      expect(Math.abs(m.glyphTop - drawn.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.glyphLeft - drawn.left)).toBeLessThanOrEqual(1);
      expect([m.bg, m.border, m.resize, m.ring]).toEqual(['rgba(0, 0, 0, 0)', '0px', 'none', 'none']);
      expect(m.outline).toBe('none');
      // the header and the numbers stay while it is typed in, and the numbers follow the lines
      expect(await page.evaluate(() => [...document.querySelectorAll('svg.canvas .code-nums text')].map((t) => t.textContent))).toEqual(['1', '2']);
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\nthird');
      await page.waitForFunction(() => document.querySelectorAll('svg.canvas .code-nums text').length === 3);
      expect(await page.evaluate(() => [...document.querySelectorAll('svg.canvas text')].some((t) => t.textContent === 'Demo'))).toBe(true);
      await page.context().close();
    });
  }
});

describe.skipIf(!available)('properties, Copy and Wrap', { timeout: 200_000 }, () => {
  it('the panel has Language (searchable), Title and two switches; the language is remembered for the next block', async () => {
    const page = await open();
    await seed(page);
    await select(page, ['c1']);
    await page.getByRole('button', { name: 'More properties' }).click();
    const panel = page.locator('aside.props');
    await panel.getByRole('heading', { name: 'Code block' }).waitFor();
    const langBtn = panel.getByRole('button', { name: /^Language: TypeScript/ });
    await langBtn.click();
    const pop = page.locator('.code-lang-pop');
    expect(await pop.locator('[role="menuitemradio"]').first().textContent()).toBe('Plain text');
    const labels = await pop.locator('[role="menuitemradio"]').evaluateAll((els) => els.map((e) => e.textContent));
    expect(labels.slice(0, 13)).toEqual(['Plain text', 'TypeScript', 'JavaScript', 'JSON', 'HTML', 'CSS', 'Python', 'Shell', 'SQL', 'YAML', 'Go', 'Rust', 'Java']);
    expect(await pop.locator('[role="menuitemradio"][aria-checked="true"]').textContent()).toBe('TypeScript');
    const box = await pop.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(281);
    expect(box!.height).toBeLessThanOrEqual(321);
    const search = pop.getByRole('searchbox', { name: 'Search languages' });
    await search.fill('zzzz');
    await pop.getByText('No language matches').waitFor();
    await search.fill('pyth');
    await pop.getByRole('menuitemradio', { name: 'Python' }).click();
    await pop.waitFor({ state: 'detached' });
    await page.waitForFunction(() => (window as any).__board.store.get('c1').lang === 'python');
    // the switches and the title change the block (and its height, which follows the rows)
    const before = (await obj(page)).h;
    await panel.getByRole('textbox', { name: 'Title' }).fill('Sample');
    await panel.getByRole('textbox', { name: 'Title' }).press('Tab');
    await page.waitForFunction(() => (window as any).__board.store.get('c1').title === 'Sample');
    expect((await obj(page)).h - before).toBe(36);
    await panel.getByRole('switch', { name: 'Line numbers' }).click();
    await page.waitForFunction(() => (window as any).__board.store.get('c1').lines === true);
    await panel.getByRole('switch', { name: 'Wrap lines' }).click();
    await page.waitForFunction(() => (window as any).__board.store.get('c1').wrap === true);
    expect(await panel.getByRole('textbox', { name: 'Title' }).getAttribute('placeholder')).toBe('Untitled code');
    // the next block starts in Python
    await select(page, []);
    await openRailTool(page, 'Code block');
    await page.mouse.click(900, 500);
    await page.locator('textarea.text-editor').waitFor({ state: 'visible' });
    await page.keyboard.type('x');
    const langs = await page.evaluate(() => [...(window as any).__board.store.cache.values()].filter((o: any) => o.type === 'code').map((o: any) => o.lang).sort());
    expect(langs).toEqual(['python', 'python']);
    await page.context().close();
  });

  it('Copy puts the plain source on the clipboard (no numbers), shows a check for 1.5s, and says Copied', async () => {
    const page = await open();
    await seed(page, { lines: true, title: 'T' });
    await hover(page);
    const copy = page.getByRole('button', { name: 'Copy code' });
    await copy.click();
    await page.waitForFunction(() => (window as any).__copied);
    expect(await page.evaluate(() => (window as any).__copied)).toBe(SRC);
    expect(await copy.evaluate((e) => e.classList.contains('done'))).toBe(true);
    expect(await page.locator('.sr-only[role="status"]').first().textContent()).toContain('Copied');
    await page.waitForFunction(() => !document.querySelector('.code-btn[data-act="copy"]')?.classList.contains('done'), null, { timeout: 4000 });
    await page.context().close();
  });

  it('Wrap lines toggles the layout and is a pressed button', async () => {
    const page = await open();
    await seed(page, { text: LONG });
    const rows = () => page.evaluate(() => document.querySelectorAll('svg.canvas .code-text > text').length);
    expect(await rows()).toBe(1);
    await hover(page);
    const wrap = page.getByRole('button', { name: 'Wrap lines' });
    expect(await wrap.getAttribute('aria-pressed')).toBe('false');
    const h0 = (await obj(page)).h;
    await wrap.click();
    await page.waitForFunction(() => (window as any).__board.store.get('c1').wrap === true);
    await page.waitForFunction(() => document.querySelectorAll('svg.canvas .code-text > text').length > 1);
    expect(await wrap.getAttribute('aria-pressed')).toBe('true');
    expect((await obj(page)).h).toBeGreaterThan(h0);
    await page.context().close();
  });

  it('the buttons are hidden while the pointer is elsewhere, and visible on keyboard focus', async () => {
    const page = await open();
    await seed(page);
    await page.mouse.move(5, 5);
    const bar = page.locator('.code-bar');
    expect(await bar.evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
    await page.locator('.code-area').focus();
    await page.keyboard.press('Shift+Tab').catch(() => undefined);
    await page.getByRole('button', { name: 'Wrap lines' }).focus();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.code-bar')!).opacity === '1');
    // 28px buttons
    const b = await page.getByRole('button', { name: 'Copy code' }).boundingBox();
    expect(Math.round(b!.width)).toBe(28);
    await page.context().close();
  });
});

describe.skipIf(!available)('the keyboard, read-only and export', { timeout: 200_000 }, () => {
  it('the code area is a labelled region you can tab to; the arrows scroll long code, Enter edits it', async () => {
    const page = await open();
    await seed(page, { text: LONG, lang: 'ts', title: 'K' });
    const area = page.getByRole('region', { name: 'Code, K, TypeScript' });
    await area.focus();
    expect(await area.getAttribute('tabindex')).toBe('0');
    const shift = () => page.evaluate(() => document.querySelector('svg.canvas .code-text')!.parentElement!.getAttribute('transform'));
    const first = await shift();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((f) => document.querySelector('svg.canvas .code-text')!.parentElement!.getAttribute('transform') !== f, first);
    await page.keyboard.press('End');
    const end = await shift();
    expect(end).not.toBe(first);
    await page.keyboard.press('Home');
    await page.waitForFunction((f) => document.querySelector('svg.canvas .code-text')!.parentElement!.getAttribute('transform') === f, first);
    // the wheel scrolls it too (sideways), and Shift+wheel
    await hover(page);
    await page.mouse.wheel(120, 0);
    await page.waitForFunction((f) => document.querySelector('svg.canvas .code-text')!.parentElement!.getAttribute('transform') !== f, first);
    await area.focus();
    await page.keyboard.press('Enter');
    await page.locator('textarea.text-editor').waitFor({ state: 'visible' });
    await typing(page);
    await page.keyboard.type('// ');
    await page.keyboard.press('Escape');
    expect((await obj(page)).text.endsWith('// ')).toBe(true); // the caret opens at the end
    await page.context().close();
  });

  it('read-only: no editing, no Wrap, but Copy works', async () => {
    const page = await open();
    await seed(page);
    await page.evaluate(() => (window as any).__board.store.setReadOnly(true));
    await page.evaluate(() => (window as any).__board.editor.start('c1'));
    await page.waitForTimeout(200);
    expect(await page.locator('textarea.text-editor').isVisible()).toBe(false);
    const o = await obj(page);
    const at = await screenOf(page, o.x + 100, o.y + 40);
    await page.mouse.dblclick(at.x, at.y);
    await page.waitForTimeout(200);
    expect(await page.locator('textarea.text-editor').isVisible()).toBe(false);
    await hover(page);
    expect(await page.getByRole('button', { name: 'Wrap lines' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Copy code' }).click();
    await page.waitForFunction(() => (window as any).__copied);
    expect(await page.evaluate(() => (window as any).__copied)).toBe(SRC);
    await page.context().close();
  });

  it('exports as plain SVG: text runs, no foreignObject, none of the page controls', async () => {
    const page = await open();
    await seed(page, { title: 'Export', lines: true });
    await select(page, ['c1']);
    const { svg } = await page.evaluate(`(async () => {
      const mod = await import('/src/exporters.ts');
      return mod.exportSvg(window.__board, ['c1']);
    })()`) as { svg: string };
    expect(svg).toContain('<tspan');
    // the runs may be coloured by the highlighter by now, so the text is read across the tspans
    expect(svg.replace(/<[^>]+>/g, '')).toContain('const a = 1;');
    expect(svg).not.toContain('foreignObject');
    expect(svg).not.toMatch(/<button|code-ctl|code-bar|Copy code|<textarea/);
    await page.context().close();
  });

  it('draws in system colours with forced colours on, and the card edge is a 1px line', async () => {
    const page = await open();
    await seed(page, { lang: 'ts' });
    await page.emulateMedia({ forcedColors: 'active' });
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.color = 'CanvasText';
      document.body.appendChild(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      const tspan = document.querySelector('svg.canvas .code-text tspan')!;
      const card = document.querySelector('svg.canvas .code-card')!;
      return { ink, fill: getComputedStyle(tspan).fill, stroke: getComputedStyle(card).stroke, sw: getComputedStyle(card).strokeWidth };
    });
    expect(m.fill).toBe(m.ink);
    expect(m.stroke).toBe(m.ink);
    expect(m.sw).toBe('1px');
    await page.context().close();
  });

  it('fits a 390px phone: no sideways page scroll, and the language list is a full-height sheet', async () => {
    const page = await open({ width: 390, height: 800, mobile: true });
    await seed(page);
    await page.evaluate(() => (window as any).__board.zoomToFit());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await select(page, ['c1']);
    await page.getByRole('button', { name: 'More properties' }).click();
    await page.getByRole('button', { name: /^Language:/ }).click();
    const box = await page.locator('.code-lang-pop').boundingBox();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(790);
    expect(Math.round(box!.width)).toBeGreaterThanOrEqual(389);
    // 44px for the finger
    await page.keyboard.press('Escape');
    await page.context().close();
  });
});
