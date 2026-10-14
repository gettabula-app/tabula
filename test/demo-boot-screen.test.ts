import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { DEMO_BOOT_HTML, DEMO_BOOT_STYLE, demoBootDone } from '../src/demo/boot-screen';
import { budget } from './wait-budget';

// The demo's loading screen (TAB-247): what the page shows before any script has run, how it leaves once the board is painted, and the
// ready message an embedding page receives. The browser tests run the demo build's dev server in demo mode (base /demo/).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const available = existsSync(chromium.executablePath());
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

describe('demo boot screen markup and style', () => {
  it('is a polite status region with the loading text and the Tabula mark', () => {
    expect(DEMO_BOOT_HTML).toContain('<div id="demo-boot" role="status" aria-live="polite">');
    expect(DEMO_BOOT_HTML).toContain('Loading the demo…');
    expect(DEMO_BOOT_HTML).toMatch(/<svg [^>]*viewBox="0 0 180 180"[^>]*width="56" height="56" aria-hidden="true"/);
    expect(DEMO_BOOT_HTML).toContain('d="M44.55 146.25V145.12H61.05V34.88H54Q48.23 34.88');
    expect(DEMO_BOOT_HTML).toContain('<path fill="#D42A18" d="M110.48 101.25h45.00v45.00h-45.00z"/>');
  });

  it('has no script and no network address other than the SVG namespace', () => {
    expect(`${DEMO_BOOT_HTML}${DEMO_BOOT_STYLE}`).not.toContain('<script');
    expect(DEMO_BOOT_HTML.split(SVG_NAMESPACE).join('')).not.toMatch(/http/i);
    expect(DEMO_BOOT_STYLE).not.toMatch(/http/i);
    expect(DEMO_BOOT_HTML.split(SVG_NAMESPACE).length - 1).toBe(1);
  });

  it('paints the paper ground and dot grid, with no white flash on the document', () => {
    expect(DEMO_BOOT_STYLE).toContain('html, body { background: #F7F5F0; }');
    expect(DEMO_BOOT_STYLE).toContain('background-image: radial-gradient(rgba(18,18,22,.10) 1px, transparent 1px);');
    expect(DEMO_BOOT_STYLE).toContain("font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;");
    expect(DEMO_BOOT_STYLE).toMatch(/#demo-boot \{[^}]*z-index: 1000;/);
  });

  it('is paper in every OS scheme (the demo always opens in the paper theme) and has a reduced-motion rule that stops the bar and the fade', () => {
    expect(DEMO_BOOT_STYLE).not.toMatch(/prefers-color-scheme/);
    const reduced = DEMO_BOOT_STYLE.slice(DEMO_BOOT_STYLE.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('animation: none;');
    expect(reduced).toContain('transition: none;');
    // the late message has no motion, so it stays out of the reduced-motion rule
    expect(reduced).not.toContain('demo-boot-late');
  });

  it('reveals the late message after 15 s with an animation that has no motion', () => {
    expect(DEMO_BOOT_STYLE).toContain('animation: demo-boot-late 0s 15s forwards;');
    expect(DEMO_BOOT_STYLE).toContain('opacity: 0; visibility: hidden;');
    expect(DEMO_BOOT_HTML).toContain('<p class="demo-boot-late">This is taking longer than usual. Reload the page to try again.</p>');
  });

  it('does nothing outside a DOM', () => {
    expect(() => demoBootDone()).not.toThrow();
  });
});

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';

beforeAll(async () => {
  if (!available) return;
  // the default config file, in demo mode: the same transform the demo build gets
  server = await createServer({ root: ROOT, mode: 'demo', base: '/demo/', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
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

describe.skipIf(!available)('demo boot screen in the browser', () => {
  it('is on screen before the app module runs, and leaves once the board is painted', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(budget(45_000));
    // The app module is held until the test has looked at the page: a barrier, not a guessed delay. The 20 s release only stops a hang.
    let releaseApp!: () => void;
    const appReleased = new Promise<void>((resolve) => { releaseApp = resolve; });
    let heldApp = 0;
    await page.route(/\/src\/main\.ts(\?|$)/, async (route) => {
      heldApp++;
      await Promise.race([appReleased, new Promise<void>((resolve) => setTimeout(resolve, budget(20_000)))]);
      await route.continue();
    });
    await page.route(/fontshare\.com/, (route) => route.abort());
    await page.goto(`${base}demo/`, { waitUntil: 'commit' });
    // The deferred module holds DOMContentLoaded, so the page is checked once it is parsed (readyState interactive), before the module runs.
    await page.waitForFunction(() => document.readyState !== 'loading');
    const boot = page.locator('#demo-boot');
    await boot.waitFor({ state: 'visible' });
    expect(await boot.getAttribute('role')).toBe('status');
    expect(await boot.textContent()).toContain('Loading the demo…');
    expect(heldApp).toBe(1);
    expect(await page.locator('.board-surface svg').count()).toBe(0);
    // the Fontshare stylesheets are not in the head; the two preconnects are
    expect(await page.locator('link[rel="stylesheet"][href*="fontshare"]').count()).toBe(0);
    expect(await page.locator('link[rel="preconnect"]').count()).toBe(2);

    releaseApp();
    await page.waitForSelector('.board-surface svg');
    await page.waitForSelector('#demo-boot', { state: 'detached', timeout: budget(5_000) });
    expect(await page.locator('.demo-board').count()).toBe(1);
    await page.close();
  });

  it('tells an embedding page once, after the board is on screen', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(budget(45_000));
    await page.route(/fontshare\.com/, (route) => route.abort());
    // the host shares the demo's origin, so it can look at the frame's document when the message arrives
    const hostUrl = `${base}embed-host.html`;
    await page.route(hostUrl, (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><title>Host</title>
<iframe id="demo" title="Try Tabula" src="${base}demo/" style="width:1000px;height:700px;border:0"></iframe>
<script>
  window.__ready = [];
  window.addEventListener('message', (event) => {
    const frame = document.getElementById('demo');
    if (event.source !== frame.contentWindow) return;
    const doc = frame.contentDocument;
    window.__ready.push({ data: event.data, boardOnScreen: !!doc.querySelector('.board-surface svg'), bootStillThere: !!doc.getElementById('demo-boot') });
  });
</script>`,
    }));
    await page.goto(hostUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__ready.length > 0);
    const received = await page.evaluate(() => (window as any).__ready);
    expect(received).toEqual([{ data: { type: 'tabula-demo-ready' }, boardOnScreen: true, bootStillThere: true }]);
    // The screen is removed 220 ms after the message: once it is gone, the post has happened, and demoBootDone runs only once, so the count stays at one.
    await page.frameLocator('#demo').locator('#demo-boot').waitFor({ state: 'detached', timeout: budget(5_000) });
    expect(await page.evaluate(() => (window as any).__ready.length)).toBe(1);
    await page.close();
  });
});
