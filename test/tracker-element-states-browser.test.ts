import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The empty, access-denied and error states of the tracker element on a board, in a real browser (visual-mode mock states:
// ?debug&trackerMock=board&trackerState=empty|denied|error). Set TRACKER_SHOTS_DIR to also save a screenshot of each for the designer.

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (!available) return;
  server = await createServer({ configFile: false, root: process.cwd(), mode: 'visual', logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
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

async function open(state: string): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?debug&trackerMock=board&trackerState=${state}#/b/trk-${state}-${Math.random().toString(36).slice(2, 6)}`);
  await page.waitForFunction(() => (window as any).__board && (window as any).__trackerStore && [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'tracker'), null, { timeout: budget(30_000) });
  await page.waitForFunction(() => document.querySelector('.trk-frame-wrap.is-work .trk-element-header') !== null, null, { timeout: budget(20_000) });
  return page;
}

async function shot(page: Page, name: string) {
  const dir = process.env.TRACKER_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.locator('.trk-frame-wrap.is-work').screenshot({ path: `${dir}/tracker-element-${name}.png` });
}

describe.skipIf(!available)('tracker element states', { timeout: 200_000 }, () => {
  it('empty: "No tickets yet", the invitation and the button, and no view switch', async () => {
    const page = await open('empty');
    const empty = page.locator('.trk-frame-wrap.is-work .trk-element-empty');
    await empty.waitFor();
    expect(await empty.locator('h2').textContent()).toBe('No tickets yet');
    expect(await empty.locator('p').textContent()).toBe('Create the first ticket to track work here.');
    expect(await empty.locator('.trk-element-create').textContent()).toBe('+ New ticket');
    // one primary per view: the header's button is hidden while the element is empty, the body's stays
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('.trk-frame-wrap.is-work .trk-element-header .trk-new-trigger')?.hidden)).toBe(true);
    await shot(page, 'empty');
    // the first ticket brings the header button and the view switch back
    await page.evaluate(() => (window as any).__trackerStore.createTicket({ title: 'First ticket', idempotencyKey: 'first-ticket-1' }));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.trk-frame-wrap.is-work .trk-element-header .trk-new-trigger')?.hidden === false, null, { timeout: budget(15_000) });
    await page.close();
  });

  it('denied: says so, offers no button', async () => {
    const page = await open('denied');
    const text = page.locator('.trk-frame-wrap.is-work');
    await text.getByText('You do not have access to the tracker').waitFor();
    await text.getByText('Ask a workspace admin').waitFor();
    expect(await text.getByText('Ask a workspace admin').isVisible()).toBe(true);
    expect(await text.locator('.trk-element-create, .trk-new-trigger:not([hidden])').count()).toBe(0);
    await shot(page, 'denied');
    await page.close();
  });

  it('error: one line "Could not load tickets" and a Retry button', async () => {
    const page = await open('error');
    const text = page.locator('.trk-frame-wrap.is-work');
    await text.getByText('Could not load tickets').first().waitFor();
    await text.getByRole('button', { name: 'Retry' }).waitFor();
    expect(await text.getByRole('button', { name: 'Retry' }).isVisible()).toBe(true);
    await shot(page, 'error');
    await page.close();
  });
});
