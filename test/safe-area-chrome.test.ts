import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// TAB-274: on a notched iPhone, in landscape, or as a home-screen app the fixed chrome must stay inside the safe area. Headless
// Chromium reports env(safe-area-inset-*) as 0, so the --safe-* variables (styles.css reads env() into them) are set by hand,
// which is exactly what the chrome reads.

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

const CASES = [
  { name: 'portrait iPhone with a notch and a home indicator', viewport: { width: 390, height: 844 }, safe: { top: 47, right: 0, bottom: 34, left: 0 } },
  { name: 'landscape iPhone', viewport: { width: 844, height: 390 }, safe: { top: 0, right: 47, bottom: 21, left: 47 } },
];

async function openBoard(width: number, height: number, safe: { top: number; right: number; bottom: number; left: number }): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await page.addInitScript((s) => {
        const style = document.createElement('style');
        style.textContent = `:root { --safe-top: ${s.top}px; --safe-right: ${s.right}px; --safe-bottom: ${s.bottom}px; --safe-left: ${s.left}px; }`;
        document.addEventListener('DOMContentLoaded', () => document.head.append(style));
      }, safe);
      await page.goto(base);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.locator('.rail').waitFor({ timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

describe('the pages and the tracker keep their content out of the notch (static)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  it('pads the Boards, Templates and Admin content and the full-screen phone tracker by the side insets', () => {
    expect(read('../src/ui/home.css')).toMatch(/\.home \{[^}]*padding: 48px calc\(24px \+ var\(--safe-right[^}]*var\(--safe-left/);
    expect(read('../src/ui/home.css')).toMatch(/\.home \{ gap: 40px; padding: 32px calc\(16px \+ var\(--safe-right/);
    expect(read('../src/ui/admin.css')).toMatch(/\.admin-body \{[^}]*padding: 48px calc\(24px \+ var\(--safe-right/);
    const tracker = read('../src/tracker/ui/tracker.css');
    expect(tracker).toMatch(/\.trk-shell \{ position: fixed;[^}]*padding: 0 var\(--safe-right[^}]*var\(--safe-left/);
    expect(tracker).toMatch(/\.trk-filter-suggestions \{ position: fixed;[^}]*right: calc\(8px \+ var\(--safe-right/);
  });
});

describe.skipIf(!available)('the fixed chrome stays inside the safe area', { timeout: 240_000 }, () => {
  for (const c of CASES) {
    it(`on a ${c.name}`, async () => {
      const page = await openBoard(c.viewport.width, c.viewport.height, c.safe);
      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el || getComputedStyle(el).display === 'none') return null;
          const b = el.getBoundingClientRect();
          return b.width ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null;
        };
        const names = ['.top-left', '.top-right', '.rail', '.zoom-tray'];
        return Object.fromEntries(names.map((n) => [n, rect(n)]));
      });
      const w = c.viewport.width;
      const h = c.viewport.height;
      const failures: string[] = [];
      for (const [name, b] of Object.entries(boxes)) {
        if (!b) { failures.push(`${name} is missing`); continue; }
        if (b.left < c.safe.left - 0.5) failures.push(`${name} starts ${b.left} px from the left, inside the ${c.safe.left} px inset`);
        if (b.right > w - c.safe.right + 0.5) failures.push(`${name} ends at ${b.right}, inside the ${c.safe.right} px right inset`);
        if (b.top < c.safe.top - 0.5) failures.push(`${name} starts ${b.top} px from the top, inside the ${c.safe.top} px inset`);
        if (b.bottom > h - c.safe.bottom + 0.5) failures.push(`${name} ends at ${b.bottom}, inside the ${c.safe.bottom} px bottom inset`);
      }
      expect(failures).toEqual([]);
      await page.context().close();
    });
  }
});
