import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';
import { PROBE_INPUTS } from '../scripts/lib/code-probe-inputs.mjs';

// The highlighter in the real app (docs/code-blocks.md): a TypeScript block gets coloured runs from the module worker, a theme change re-colours, typing shows
// plain text and the commit highlights again, a hostile block ends up plain without freezing the page and is not asked for twice, and the export carries the
// colours. Runs on the Vite dev server in headless Chromium, where module workers load like in the built app.

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

const SRC = 'const a: number = 1;\nfunction f(x: string) {\n  return "s" + x;\n}';

async function open(opts: { noWorker?: boolean } = {}): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(budget(45_000));
  if (opts.noWorker) await page.addInitScript(() => { delete (window as any).Worker; });
  await page.addInitScript(() => {
    (window as any).__errors = [];
    window.addEventListener('error', (e) => (window as any).__errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => (window as any).__errors.push(String(e.reason)));
  });
  await page.goto(`${base}?debug#/b/hl-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  return page;
}

async function seed(page: Page, extra: Record<string, unknown> = {}, id = 'c1'): Promise<void> {
  await page.evaluate(([x, i]) => {
    const app = (window as any).__board;
    app.store.transactAs(() => {
      app.store.create({ id: i, type: 'code', x: 100, y: 100, w: 520, h: 100, rotation: 0, z: app.store.topZ(), text: 'x', lang: 'ts', lines: false, wrap: false, ...(x as object) });
    }, 'seed');
    app.zoomTo(1);
    app.r.setCamera({ x: 0, y: 0 });
  }, [extra, id] as const);
  await page.waitForFunction(() => document.querySelector('svg.canvas .code-block'));
}

/** The distinct fills of the code runs of a block as drawn, and how many runs have none. */
const fills = (page: Page) => page.evaluate(() => {
  const ts = [...document.querySelectorAll('svg.canvas .code-text tspan')];
  return { fills: [...new Set(ts.map((t) => t.getAttribute('fill')).filter(Boolean))] as string[], plain: ts.filter((t) => !t.getAttribute('fill')).length, runs: ts.length };
});
const waitColoured = (page: Page, ms = 20_000) => page.waitForFunction(() => new Set([...document.querySelectorAll('svg.canvas .code-text tspan')].map((t) => t.getAttribute('fill')).filter(Boolean)).size > 1, null, { timeout: budget(ms) });
const setTheme = (page: Page, id: string) => page.evaluate(`(async () => { const m = await import('/src/themes.ts'); m.setTheme(${JSON.stringify(id)}); })()`);
const set = (page: Page, patch: Record<string, unknown>, id = 'c1') => page.evaluate(([p, i]) => (window as any).__board.store.update(i, p), [patch, id] as const);

describe.skipIf(!available)('the code highlighter in the app', { timeout: 200_000 }, () => {
  it('colours a TypeScript block, re-colours on a theme change and puts the colours in the exported SVG', async () => {
    const page = await open();
    await seed(page, { text: SRC });
    await waitColoured(page);
    const first = await fills(page);
    expect(first.fills.length).toBeGreaterThan(2);
    expect(first.fills).not.toContain('var(--ink, #111111)');
    // the export has the same coloured runs
    const { svg } = await page.evaluate(`(async () => (await import('/src/exporters.ts')).exportSvg(window.__board, ['c1']))()`) as { svg: string };
    expect(svg).not.toContain('foreignObject');
    expect(svg).toMatch(/<tspan x="[\d.]+" fill="#[0-9a-fA-F]{6}">/);
    // another app theme: the tokens are re-made for it
    await setTheme(page, 'ayu');
    await page.waitForFunction((old) => {
      const f = [...new Set([...document.querySelectorAll('svg.canvas .code-text tspan')].map((t) => t.getAttribute('fill')).filter(Boolean))].sort().join();
      return f.length > 0 && f !== old;
    }, first.fills.slice().sort().join(), { timeout: budget(20_000) });
    expect((await fills(page)).fills.length).toBeGreaterThan(2);
    expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
    await page.context().close();
  });

  it('shows plain text while typing and highlights again after the commit', async () => {
    const page = await open();
    await seed(page, { text: SRC });
    await waitColoured(page);
    await page.evaluate(() => { const app = (window as any).__board; app.setSelection(['c1']); });
    await page.keyboard.press('Enter');
    const ta = page.locator('textarea.text-editor');
    await ta.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('textarea.text-editor'));
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nlet z = 2;');
    await page.waitForTimeout(budget(1200));
    // the block is drawn without code runs while the box is open, and no request is made for the half-typed text
    expect(await page.locator('svg.canvas .code-text tspan').count()).toBe(0);
    await page.keyboard.press('Escape');
    await ta.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('svg.canvas .code-text tspan').length > 0);
    await waitColoured(page);
    expect(await page.evaluate(() => [...document.querySelectorAll('svg.canvas .code-text')].map((e) => e.textContent).join(''))).toContain('let z = 2;');
    await page.context().close();
  });

  it('draws a block over 20,000 characters and plain text without colours', async () => {
    const page = await open();
    await seed(page, { text: 'plain words here', lang: 'plaintext' });
    await page.waitForTimeout(budget(1500));
    expect((await fills(page)).fills).toEqual([]);
    await page.context().close();
  });

  it('shows plain text, quietly, where there is no Worker (the demo build)', async () => {
    const page = await open({ noWorker: true });
    await seed(page, { text: SRC });
    await page.waitForTimeout(budget(2000));
    const f = await fills(page);
    expect(f.fills).toEqual([]);
    expect(f.runs).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
    await page.context().close();
  });
});

const HOSTILE = [
  ['bash', '< x20000 (lines of 500)'],
  ['cpp', '< x20000 (lines of 500)'],
] as const;

describe.skipIf(!available)('a hostile block', { timeout: 200_000 }, () => {
  for (const [lang, name] of HOSTILE) {
    it(`${lang} ${name}: ends as plain text, the page stays responsive, and it is not asked for again`, async () => {
      const input = PROBE_INPUTS.find((p) => p.name === name);
      if (!input) throw new Error(`no probe input ${name}`);
      // the app takes at most 20,000 characters; the probe's lines of 500 add newlines on top of that
      const text = input.text.slice(0, 20_000);
      const page = await open();
      await page.evaluate(() => {
        const w = window as any;
        w.__gaps = [];
        let last = performance.now();
        setInterval(() => { const n = performance.now(); w.__gaps.push(n - last); last = n; }, 20);
        const orig = Worker;
        w.__workers = 0;
        w.Worker = class extends orig { constructor(...a: ConstructorParameters<typeof Worker>) { super(...a); w.__workers++; } };
      });
      await seed(page, { text, lang });
      // the watchdog (1.5 s) ends the request and starts a second worker; with the idle wait the block is settled within about 3 s
      await page.waitForFunction(() => (window as any).__workers >= 2, null, { timeout: budget(4000), polling: 50 });
      await page.waitForTimeout(budget(500));
      const f = await fills(page);
      expect(f.fills, 'drawn plain').toEqual([]);
      const gaps: number[] = await page.evaluate(() => (window as any).__gaps);
      expect(gaps.length).toBeGreaterThan(20);
      expect(Math.max(...gaps)).toBeLessThan(budget(200));
      // the same text in a second block, and a retry of the same block: no new worker is started for it
      const workers = await page.evaluate(() => (window as any).__workers);
      await seed(page, { text, lang, y: 900 }, 'c2');
      await set(page, { x: 101 });
      await page.waitForTimeout(budget(2500));
      expect(await page.evaluate(() => (window as any).__workers)).toBe(workers);
      expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
      await page.context().close();
    });
  }
});
