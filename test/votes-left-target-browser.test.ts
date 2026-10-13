import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The votes-left control of the phone vote bar was 11 px wide (axe target-size, WCAG 2.2 2.5.8): it keeps the 44 px touch target the other buttons of the bar have.

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

describe.skipIf(!available)('the phone vote bar', () => {
  it('has a votes-left control of at least 44 x 44 px', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(budget(45_000));
    await page.goto(`${base}?debug#/b/vl-${Math.random().toString(36).slice(2, 8)}`);
    await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
    await page.evaluate(`(async () => {
      const app = window.__board;
      app.store.transactAs(() => app.store.create({ id: 's1', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: app.store.topZ(), text: 'a', fill: '#FFE16B' }), 'seed');
      const { startVote } = await import('/src/ui/flowbar.ts');
      startVote(app, { kind: 'all' });
    })()`);
    await page.waitForSelector('.flowbar.vote-compact > .votes-left');
    const box = await page.evaluate(() => {
      const r = document.querySelector('.flowbar.vote-compact > .votes-left')!.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    expect(box.w).toBeGreaterThanOrEqual(44);
    expect(box.h).toBeGreaterThanOrEqual(44);
    await page.close();
  });
});
