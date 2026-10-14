import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { handleVisualizationFrame, VISUALIZATION_FRAME_PATH } from '../server/ai/visual-frame.mjs';
import type { Visualization } from '../shared/ai-visualization';

// Same script/frame restrictions as the production relay. A srcdoc implementation fails here because it inherits
// script-src self. The real visualization response must retain its separate, narrower policy.
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://api.fontshare.com; font-src 'self' data: https://cdn.fontshare.com; img-src 'self' data: blob: https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com; connect-src 'self' ws: wss: https://api.fontshare.com https://cdn.fontshare.com https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const available = existsSync(chromium.executablePath());
let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';
const resourceRequests: string[] = [];
const navigationProbes: { cookie: string | null; site: string | null }[] = [];

beforeAll(async () => {
  if (!available) return;
  server = await createServer({
    configFile: false, root: process.cwd(), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'visualization-browser-harness',
      resolveId(id) { if (id === '/__visualization-entry.ts') return id; },
      load(id) {
        if (id !== '/__visualization-entry.ts') return;
        return `
          import '/src/styles.css';
          import { showVisualization } from '/src/ui/ai-visualization.ts';
          window.__closed = 0;
          window.__retried = 0;
          window.__messageListeners = new Set();
          const addListener = window.addEventListener;
          const removeListener = window.removeEventListener;
          window.addEventListener = function (type, listener, options) {
            if (type === 'message') window.__messageListeners.add(listener);
            return addListener.call(this, type, listener, options);
          };
          window.removeEventListener = function (type, listener, options) {
            if (type === 'message') window.__messageListeners.delete(listener);
            return removeListener.call(this, type, listener, options);
          };
          window.__showVisualization = (value, cut = false) => {
            window.__visualization = showVisualization(value, {
              cut, onClose: () => window.__closed++, onRetry: () => window.__retried++,
            });
          };
          window.__ready = true;
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
          if (pathname.startsWith('/__blocked-')) resourceRequests.push(pathname);
          if (handleVisualizationFrame(req, res, pathname)) return;
          if (pathname === '/__navigation-probe') {
            navigationProbes.push({ cookie: req.headers.cookie ?? null, site: (req.headers['sec-fetch-site'] as string | undefined) ?? null });
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('navigated');
            return;
          }
          if (pathname !== '/__visualization-test') return next();
          res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': APP_CSP });
          res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><button id="opener">Visualize</button><div id="host-secret">Board stays here</div><script type="module" src="/__visualization-entry.ts"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const tool: Visualization = {
  title: 'A counter', description: 'Change the number with the button.', initialHeight: 320,
  css: 'button { padding: 12px; }', html: '<button id="increase">Increase</button><output id="count">0</output>',
  jsFunctions: 'function increase() { const output = document.getElementById("count"); output.textContent = String(Number(output.textContent) + 1); }',
  jsExpressions: ['document.getElementById("increase").addEventListener("click", increase);'],
};

async function openPage(value = tool, cut = false): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(`${base}/__visualization-test`);
  await page.waitForFunction(() => (window as any).__ready === true);
  await page.locator('#opener').focus();
  await page.evaluate(({ value, cut }) => (window as any).__showVisualization(value, cut), { value, cut });
  return page;
}

async function readyFrame(page: Page) {
  await page.waitForFunction(() => document.querySelector('.ai-visualization-surface')?.getAttribute('aria-busy') === 'false');
  const frame = page.frameLocator('.ai-visualization iframe');
  await frame.locator('body').waitFor();
  return frame;
}

describe.skipIf(!available)('completed AI visualizations under the production CSP', { timeout: 200_000 }, () => {
  it('runs local controls in a fetched opaque frame and shows accessible answer text', async () => {
    const page = await openPage(tool, true);
    const frame = await readyFrame(page);
    expect(await page.getByRole('dialog', { name: tool.title }).getAttribute('aria-describedby')).toMatch(/^visualization-description-/);
    expect(await page.getByText('Some board content was left out.').isVisible()).toBe(true);
    expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts ');
    expect(await page.locator('iframe').getAttribute('src')).toBe(VISUALIZATION_FRAME_PATH);
    expect(await page.evaluate(() => (window as any).__messageListeners.size)).toBe(2);
    await frame.getByRole('button', { name: 'Increase' }).click();
    await expect.poll(() => frame.locator('#count').textContent()).toBe('1');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await page.locator('iframe').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__messageListeners.size)).toBe(0);
    expect(await page.locator('#opener').evaluate((el) => document.activeElement === el)).toBe(true);
    await page.close();
  });

  it('blocks parent DOM, browser storage, same-origin and external fetch, child frames and CSS resources', async () => {
    resourceRequests.length = 0;
    const value = {
      ...tool,
      css: '',
      html: '<output id="protection">checking</output>',
      jsFunctions: '',
      jsExpressions: [`(async function () {
        const blocked = {};
        const violations = new Set();
        const resourcesDenied = new Promise(resolve => document.addEventListener('securitypolicyviolation', event => {
          violations.add(event.effectiveDirective);
          if (violations.has('frame-src') && violations.has('img-src')) resolve();
        }));
        const child = document.createElement('iframe');
        child.src = '${base}/__blocked-child';
        document.body.appendChild(child);
        document.body.style.backgroundImage = 'url("${base}/__blocked-css")';
        for (const [name, operation] of Object.entries({
          parent: () => parent.document.getElementById('host-secret').remove(),
          localStorage: () => localStorage.setItem('visualization', 'bad'),
          sessionStorage: () => sessionStorage.setItem('visualization', 'bad'),
          cookie: () => document.cookie,
          indexedDB: () => indexedDB.open('visualization'),
        })) { try { operation(); blocked[name] = false; } catch { blocked[name] = true; } }
        for (const [name, url] of [['sameOrigin', '${base}/__blocked-fetch'], ['external', 'https://example.com/blocked']]) {
          try { await fetch(url); blocked[name] = false; } catch { blocked[name] = true; }
        }
        await resourcesDenied;
        blocked.childFrame = violations.has('frame-src');
        blocked.cssImage = violations.has('img-src');
        document.getElementById('protection').textContent = JSON.stringify(blocked);
      })();`],
    };
    const page = await openPage(value);
    const frame = await readyFrame(page);
    await expect.poll(() => frame.locator('#protection').textContent()).not.toBe('checking');
    const result = JSON.parse((await frame.locator('#protection').textContent())!);
    expect(result).toEqual({ parent: true, localStorage: true, sessionStorage: true, cookie: true, indexedDB: true, sameOrigin: true, external: true, childFrame: true, cssImage: true });
    // Completion waits for both CSP violation events and both fetch rejections: forbidden requests cannot merely be late.
    expect(resourceRequests).toEqual([]);
    expect(await page.locator('#host-secret').textContent()).toBe('Board stays here');
    // Even same-origin content cannot be nested in the generated tool. Check the enforced HTTP policy too.
    const response = await page.request.get(`${base}${VISUALIZATION_FRAME_PATH}`);
    expect(response.headers()['content-security-policy']).toContain("frame-src 'none'");
    expect(response.headers()['content-security-policy']).toContain('sandbox allow-scripts');
    expect(response.headers()['permissions-policy']).toContain('camera=()');
    await page.close();
  });

  it('retains the parent frame policy when generated code tries external navigation, links or meta refresh', async () => {
    for (const mode of ['location', 'link', 'refresh']) {
      const target = `https://example.com/visualization-${mode}`;
      const navigation = mode === 'location' ? `window.location.href = '${target}';`
        : mode === 'link' ? `const link = document.createElement('a'); link.href = '${target}'; document.body.appendChild(link); link.click();`
          : `const meta = document.createElement('meta'); meta.httpEquiv = 'refresh'; meta.content = '0;url=${target}'; document.head.appendChild(meta);`;
      const page = await openPage({
        ...tool, html: '<button id="navigate">Navigate</button>', jsFunctions: '',
        jsExpressions: [`document.getElementById('navigate').addEventListener('click', function () { ${navigation} });`],
      });
      let externalRequests = 0;
      await page.route('https://example.com/**', (route) => { externalRequests++; return route.abort(); });
      await page.evaluate(() => {
        (window as any).__frameViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => {
          (window as any).__frameViolations.push({ directive: event.effectiveDirective, uri: event.blockedURI });
        });
      });
      const frame = await readyFrame(page);
      await frame.getByRole('button', { name: 'Navigate' }).click();
      await page.waitForFunction(() => (window as any).__frameViolations.some((event: any) => event.directive === 'frame-src'));
      expect(externalRequests).toBe(0);
      // Chromium replaces a denied navigation with an error document. The renderer removes that frame and offers Retry.
      await page.getByRole('alert').waitFor();
      expect(await page.locator('.ai-visualization iframe').count()).toBe(0);
      expect(page.url()).toBe(`${base}/__visualization-test`);
      await page.close();
    }
  });

  it('sends same-origin navigation from the frame as cross-site, without the person\'s cookies', async () => {
    navigationProbes.length = 0;
    const page = await openPage({
      ...tool, html: '<button id="navigate">Navigate</button>', jsFunctions: '',
      jsExpressions: [`document.getElementById('navigate').addEventListener('click', function () { location.href = '${base}/__navigation-probe'; });`],
    });
    await page.context().addCookies([{ name: 'session', value: 'signed-in', url: base, httpOnly: true, sameSite: 'Lax' }]);
    const frame = await readyFrame(page);
    await frame.getByRole('button', { name: 'Navigate' }).click();
    await expect.poll(() => navigationProbes.length).toBe(1);
    expect(navigationProbes).toEqual([{ cookie: null, site: 'cross-site' }]);
    // The second document in the frame is treated as a failure: the renderer removes the frame and offers Retry.
    await page.getByRole('alert').waitFor();
    await page.close();
  });

  // A documented limit, not a protection (docs/ai-visualizations.md): Content Security Policy does not govern WebRTC, so
  // generated code can reach a STUN server of its choosing. If a browser starts blocking this, narrow the documentation.
  it('does not stop WebRTC from reaching a host outside the frame policy', async () => {
    const socket = createSocket('udp4');
    let stunRequests = 0;
    socket.on('message', () => { stunRequests++; });
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    const page = await openPage({
      ...tool, html: '<output id="peer">starting</output>', jsFunctions: '',
      jsExpressions: [`const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${socket.address().port}' }] });
        peer.createDataChannel('probe');
        peer.createOffer().then(function (offer) { return peer.setLocalDescription(offer); });`],
    });
    try {
      await readyFrame(page);
      await expect.poll(() => stunRequests, { timeout: 10_000 }).toBeGreaterThan(0);
    } finally {
      socket.close();
      await page.close();
    }
  });

  it('closes on Escape from inside the tool and restores focus; replacement destroys the old frame', async () => {
    const page = await openPage();
    const frame = await readyFrame(page);
    await frame.getByRole('button', { name: 'Increase' }).focus();
    await page.keyboard.press('Escape');
    await page.locator('.ai-visualization').waitFor({ state: 'detached' });
    expect(await page.locator('#opener').evaluate((el) => document.activeElement === el)).toBe(true);
    await page.evaluate((value) => (window as any).__showVisualization(value), tool);
    await readyFrame(page);
    const previous = await page.locator('.ai-visualization iframe').elementHandle();
    await page.evaluate((value) => (window as any).__showVisualization(value), { ...tool, title: 'Replacement' });
    await readyFrame(page);
    expect(await previous!.evaluate((el) => el.isConnected)).toBe(false);
    expect(await page.locator('.ai-visualization iframe').count()).toBe(1);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.ai-visualization').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => ({ closed: (window as any).__closed, retried: (window as any).__retried }))).toEqual({ closed: 3, retried: 1 });
    expect(await page.locator('#opener').evaluate((el) => document.activeElement === el)).toBe(true);
    await page.close();
  });

  it('reports execution errors with Retry instead of leaving a broken iframe', async () => {
    const page = await openPage({ ...tool, jsFunctions: 'function {' });
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toBe('Could not open this visualization. Try again.');
    expect(await page.locator('iframe').count()).toBe(0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__retried)).toBe(1);
    await page.close();
  });

  it('can close before the frame handshakes without retaining listeners or reopening the dialog', async () => {
    const page = await browser!.newPage();
    await page.goto(`${base}/__visualization-test`);
    await page.waitForFunction(() => (window as any).__ready === true);
    const response = await page.request.get(`${base}${VISUALIZATION_FRAME_PATH}`);
    let release: (() => Promise<void>) | undefined;
    let notice: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => { notice = resolve; });
    await page.route(`**${VISUALIZATION_FRAME_PATH}`, (route) => {
      release = () => route.fulfill({ response });
      notice!();
    });
    await page.locator('#opener').focus();
    await page.evaluate((value) => (window as any).__showVisualization(value), tool);
    await requested;
    await page.evaluate(() => (window as any).__visualization.close());
    await release!();
    expect(await page.locator('.ai-visualization').count()).toBe(0);
    expect(await page.locator('iframe').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__messageListeners.size)).toBe(0);
    expect(await page.locator('#opener').evaluate((el) => document.activeElement === el)).toBe(true);
    await page.close();
  });
});
