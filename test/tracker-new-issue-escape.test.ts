import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer | undefined;
let browser: Browser | undefined;

async function openTracker(): Promise<Page> {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import { mountTrackerShell } from '/src/tracker/ui/shell.ts';
      import { createTrackerStore } from '/src/tracker-data.ts';
      import { createMockTrackerApi } from '/src/tracker-mock.ts';
      import { createTrackerVisualSeed } from '/src/tracker/ui/visual-seed.ts';
      const api = createMockTrackerApi(createTrackerVisualSeed());
      const store = createTrackerStore(api, { isVisible: () => false });
      window.__workExitCalls = 0;
      window.__trackerShell = mountTrackerShell(document.querySelector('#app'), {
        store, api, viewerId: 'escape-regression', trackerId: 'tracker-demo', initialTab: 'all',
        onWorkExit: () => { window.__workExitCalls++; },
      });
      await store.loadMeta();
    `,
  });
  await page.locator('.trk-new-trigger').waitFor();
  return page;
}

afterEach(async () => {
  await browser?.close();
  await server?.close();
  browser = undefined;
  server = undefined;
});

describe('tracker New issue Escape routing in a real browser DOM', () => {
  it.skipIf(!existsSync(chromium.executablePath()))('closes only the dialog before its initial focus frame and preserves plain tracker Escape', async () => {
    const page = await openTracker();
    const first = await page.evaluate(() => {
      const opener = document.querySelector<HTMLButtonElement>('.trk-new-trigger')!;
      // Keep the dialog's initial focus RAF pending to exercise the short interval where focus remains on its opener.
      window.requestAnimationFrame = () => 1;
      opener.focus();
      opener.click();
      const wasOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      opener.dispatchEvent(event);
      return {
        wasOpen,
        remainsOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
        workExitCalls: (window as Window & { __workExitCalls?: number }).__workExitCalls,
        focusReturned: document.activeElement === opener,
      };
    });

    expect(first.wasOpen).toBe(true);
    expect(first.remainsOpen).toBe(false);
    expect(first.workExitCalls).toBe(0);
    expect(first.focusReturned).toBe(true);

    const plainEscapeCalls = await page.evaluate(() => {
      const opener = document.querySelector<HTMLButtonElement>('.trk-new-trigger')!;
      opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return (window as Window & { __workExitCalls?: number }).__workExitCalls;
    });
    expect(plainEscapeCalls).toBe(1);
  }, 30_000);
});
