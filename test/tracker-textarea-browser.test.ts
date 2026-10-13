import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

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
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe.skipIf(!available)('tracker textareas', { timeout: 200_000 }, () => {
  it.each(['default', 'ayu', 'kanagawa', 'matrix', 'evergreen'])('%s: typed text and placeholder are readable on the field, which is padded', async (theme) => {
    const page = await browser!.newPage({ viewport: { width: 900, height: 600 } });
    await page.addInitScript((t) => { try { localStorage.setItem('driftboard:theme', t); } catch { /* storage off */ } }, theme);
    await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="app"></div>' }));
    await page.goto(`${base}__blank`);
    await page.addScriptTag({
      type: 'module',
      content: `
        import '/src/styles.css'; import '/src/tracker/ui/tracker.css'; import '/src/tracker/ui/ticket-page.css';
        const { applyTheme, getStoredTheme } = await import('/src/themes.ts');
        applyTheme(getStoredTheme());
        const root = document.getElementById('app');
        document.body.style.background = 'var(--canvas)';
        root.innerHTML = '<div class="trk trk-modal trk-new-issue-back" style="background:var(--trk-ground);padding:20px"><div class="modal"><textarea id="a" class="trk-new-description" placeholder="Description (Markdown)">Typed text</textarea></div></div>'
          + '<div class="trk" style="padding:20px"><textarea id="b" class="trk-project-description" placeholder="Project description">Typed text</textarea></div>'
          + '<div class="trk tk-page" style="padding:20px"><textarea id="c" class="tk-comment-input" placeholder="Write a comment">Typed text</textarea></div>';
        window.__ready = true;
      `,
    });
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 60_000 });
    const rows = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      const rgb = (css: string): [number, number, number] => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      return ['a', 'b', 'c'].map((id) => {
        const el = document.getElementById(id) as HTMLTextAreaElement;
        const style = getComputedStyle(el);
        // the fill is a translucent or opaque mix over the page: composite on the canvas colour first
        const surround = getComputedStyle(el.closest('.trk') as HTMLElement).backgroundColor;
        const under = rgb(surround === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : surround);
        const fill = style.backgroundColor === 'rgba(0, 0, 0, 0)' ? under : rgb(style.backgroundColor);
        return {
          id, text: ratio(rgb(style.color), fill), placeholder: ratio(rgb(getComputedStyle(el, '::placeholder').color), fill),
          top: parseFloat(style.paddingTop), left: parseFloat(style.paddingLeft),
        };
      });
    });
    for (const row of rows) {
      expect(row.text).toBeGreaterThanOrEqual(4.5);
      expect(row.placeholder).toBeGreaterThanOrEqual(4.5);
      expect(row.top).toBeGreaterThanOrEqual(8);
      expect(row.left).toBeGreaterThanOrEqual(8);
    }
    await page.close();
  });
});
