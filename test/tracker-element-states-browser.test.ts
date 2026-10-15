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

  it.each(['default', 'evergreen', 'ayu', 'matrix'])('the All/My switch reads on its card in the %s theme (labels and the raised thumb at 4.5:1)', async (theme) => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(budget(45_000));
    await page.addInitScript((id) => { try { localStorage.setItem('driftboard:theme', id); } catch { /* the test falls back to the default theme and says so below */ } }, theme);
    await page.goto(`${base}?debug&trackerMock=board#/b/trk-sw-${theme}`);
    await page.waitForFunction(() => document.querySelector('.trk-frame-wrap.is-work .trk-element-switch .segmented button.on') !== null, null, { timeout: budget(30_000) });
    const result = await page.evaluate(() => {
      const px = (css: string) => {
        const c = document.createElement('canvas').getContext('2d')!;
        c.fillStyle = '#000000'; c.fillStyle = css;
        const v = c.fillStyle as string;
        if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
        const nums = (v.replace(/^color\(srgb/, '').match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
        return v.startsWith('color(') ? nums.map((x) => x * 255) : nums;
      };
      const lum = (rgb: number[]) => { const [r, g, b] = rgb.map((x) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const track = document.querySelector('.trk-frame-wrap.is-work .trk-element-switch .segmented') as HTMLElement;
      const on = track.querySelector('button.on') as HTMLElement; // the raised thumb is the sliding marker behind it now
      const off = [...track.querySelectorAll('button')].find((b) => !b.classList.contains('on')) as HTMLElement;
      const bg = (el: HTMLElement) => px(getComputedStyle(el).backgroundColor);
      const fg = (el: HTMLElement) => px(getComputedStyle(el).color);
      return { theme: document.documentElement.dataset.theme ?? 'default', off: ratio(fg(off), bg(track)), on: ratio(fg(on), bg(track.querySelector('.segmented-marker') as HTMLElement)) };
    });
    await shot(page, `switch-${theme}`);
    expect(result.theme).toBe(theme); // the stored theme was applied, so the check below is about that theme
    expect(result.off).toBeGreaterThanOrEqual(4.5);
    expect(result.on).toBeGreaterThanOrEqual(4.5);
    await page.close();
  });
});
