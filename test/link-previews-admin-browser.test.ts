import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// The Link previews row of Admin > Privacy (proto/designer-preview/link-cards/SPEC.md, Admin row): the switch, its copy for a hosted and a
// self-hosted workspace, the note, the operator's kill switch and a failed save, over a stubbed /api/admin/link-previews.

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

interface Fake { state: { enabled: boolean; locked: boolean; setting: boolean | null }; puts: unknown[]; failPut: boolean }

async function open(hosted: boolean, state: Partial<Fake['state']> = {}): Promise<{ page: Page; fake: Fake }> {
  const fake: Fake = { state: { enabled: false, locked: false, setting: null, ...state }, puts: [], failPut: false };
  const page = await browser!.newPage({ viewport: { width: 900, height: 700 } });
  await page.route('**/api/admin/link-previews', async (route) => {
    if (route.request().method() === 'PUT') {
      fake.puts.push(JSON.parse(route.request().postData() ?? '{}'));
      if (fake.failPut) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
      const on = (fake.puts.at(-1) as { enabled: boolean }).enabled;
      fake.state = { ...fake.state, enabled: on, setting: on };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fake.state) });
  });
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="host"></div>' }));
  await page.goto(`${base}__blank`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import { linkPreviewsAdminPanel } from '/src/ui/link-previews-admin.ts';
      const me = { user: { id: 'u', role: 'owner', name: 'Owner', email: 'o@example.com' }, teams: [], mcpOauth: false${hosted ? ", workspace: { name: 'W' }" : ''} };
      document.getElementById('host').append(linkPreviewsAdminPanel(me));
      window.__ready = true;
    `,
  });
  await page.waitForFunction('window.__ready === true');
  await page.locator('.lp-switch').waitFor();
  return { page, fake };
}

describe.skipIf(!available)('the Link previews admin row', () => {
  it('says what it does for a self-hosted server, with the note while it is off, and turns on from the switch', async () => {
    const { page, fake } = await open(false);
    const sw = page.getByRole('switch', { name: 'Link previews' });
    expect(await sw.getAttribute('aria-checked')).toBe('false');
    expect(await page.locator('.lp-text').textContent()).toBe('When someone adds a link to a board, show its title, description and image. Links still work without it.');
    expect(await page.locator('.lp-note').textContent()).toContain('TABULA_LINK_PREVIEW_DENY');
    await sw.click();
    await page.waitForFunction(() => document.querySelector('.lp-switch')?.getAttribute('aria-checked') === 'true');
    expect(fake.puts).toEqual([{ enabled: true }]);
    // the switch flips at once, the outcome text arrives with the server's answer: wait for it instead of reading it straight away (it was '' on a slow CI runner)
    await page.waitForFunction(() => document.querySelector('.lp-outcome')?.textContent === 'Saved.');
    expect(await page.locator('.lp-outcome').textContent()).toBe('Saved.');
    expect(await page.locator('.lp-note').count()).toBe(0);
    await page.close();
  });

  it('says what it does for a hosted workspace, and turns off', async () => {
    const { page, fake } = await open(true, { enabled: true, setting: null });
    expect(await page.locator('.lp-text').textContent()).toBe("When someone adds a link to a board, show its title, description and image. Our server fetches the page once; nobody's browser contacts the linked site until they open it.");
    expect(await page.locator('.lp-note').count()).toBe(0);
    await page.getByRole('switch', { name: 'Link previews' }).click();
    await page.waitForFunction(() => document.querySelector('.lp-switch')?.getAttribute('aria-checked') === 'false');
    expect(fake.puts).toEqual([{ enabled: false }]);
    await page.close();
  });

  it('is disabled with an explanation when the operator turned it off', async () => {
    const { page, fake } = await open(false, { enabled: false, locked: true });
    expect(await page.getByRole('switch', { name: 'Link previews' }).isDisabled()).toBe(true);
    expect(await page.locator('.lp-locked').textContent()).toBe("Turned off in the server's settings.");
    expect(await page.locator('.lp-note').count()).toBe(0);
    expect(fake.puts).toEqual([]);
    await page.close();
  });

  it('keeps the old state and says so when a save fails, and the switch is keyboard-operable', async () => {
    const { page, fake } = await open(false);
    fake.failPut = true;
    await page.locator('.lp-switch').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.lp-outcome')?.textContent === 'Could not save. Try again.');
    expect(await page.getByRole('switch', { name: 'Link previews' }).getAttribute('aria-checked')).toBe('false');
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('lp-switch');
    await page.close();
  });

  it('is the shared 28 by 16 switch', async () => {
    const { page } = await open(false);
    const box = await page.locator('.lp-switch').boundingBox();
    expect([box!.width, box!.height]).toEqual([28, 16]);
    await page.close();
  });
});
