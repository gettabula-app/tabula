import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// A facilitator who moves on from Private writing without revealing still has a Reveal notes button on the next (Discuss) step.

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

describe.skipIf(!available)('Reveal notes on a Discuss step', () => {
  it('is on the bar after Next, reveals other people\'s notes, and the notes stay visible on the next step', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(budget(45_000));
    await page.goto(`${base}?debug#/b/rv-${Math.random().toString(36).slice(2, 8)}`);
    await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
    await page.evaluate(`(() => {
      const app = window.__board;
      app.store.transactAs(() => app.store.create({ id: 'n1', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: app.store.topZ(), text: 'their idea', fill: '#FFE16B', privateStep: 's1', createdBy: 'someone-else' }), 'seed');
      app.flow.setSteps([
        { id: 's1', title: 'Silent', instructions: '', mode: 'private-write' },
        { id: 's2', title: 'Reveal', instructions: '', mode: 'discuss' },
        { id: 's3', title: 'Cluster', instructions: '', mode: 'cluster' },
      ]);
      app.flow.goto(0);
    })()`);
    const hidden = () => page.evaluate(`window.__board.flow.isHidden(window.__board.store.get('n1'))`);
    const reveal = page.locator('.flowbar button', { hasText: 'Reveal notes' });
    await reveal.waitFor();
    await page.getByRole('button', { name: /next step/i }).first().click();
    await page.waitForFunction(() => (window as any).__board.flow.state().active === 1);
    await reveal.waitFor();
    expect(await hidden()).toBe(true);
    await reveal.click();
    expect(await hidden()).toBe(false);
    await reveal.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /next step/i }).first().click();
    await page.waitForFunction(() => (window as any).__board.flow.state().active === 2);
    expect(await hidden()).toBe(false);
    await page.close();
  });
});
