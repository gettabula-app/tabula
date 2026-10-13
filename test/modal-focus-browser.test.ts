import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
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
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openDialog(theme: 'default' | 'ayu'): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 900, height: 700 } });
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="host"></div>' }));
  await page.goto(`${base}__blank`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import { applyTheme } from '/src/themes.ts';
      import { dialog } from '/src/ui/common.ts';
      import { h } from '/src/ui/dom.ts';
      applyTheme('${theme}');
      dialog('Confirm action', h('p', null, 'Delete this item?'), [{ label: 'Cancel' }, { label: 'Delete', primary: true }]);
      window.__dialogReady = true;
    `,
  });
  await page.waitForFunction(() => (window as unknown as { __dialogReady?: boolean }).__dialogReady === true
    && document.activeElement === document.querySelector('.modal .btn.primary'));
  await page.locator('.modal-head .icon-btn').focus();
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.modal .modal-actions .btn'));
  return page;
}

describe.skipIf(!available)('modal keyboard focus in a browser', { timeout: 200_000 }, () => {
  it('shows a focus ring on a modal action in the default and Ayu themes', async () => {
    for (const theme of ['default', 'ayu'] as const) {
      const page = await openDialog(theme);
      const cancel = page.locator('.modal .modal-actions .btn').first();
      expect(await cancel.evaluate((el) => el === document.activeElement)).toBe(true);
      const focus = await cancel.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          boxShadow: style.boxShadow,
        };
      });
      expect((focus.outlineStyle !== 'none' && focus.outlineWidth >= 2) || focus.boxShadow !== 'none').toBe(true);
      await page.close();
    }
  });
});
