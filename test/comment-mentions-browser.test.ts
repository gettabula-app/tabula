import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// Mentions in a comment, in a real browser (TAB-53): typing `@` in the new-comment field offers the people here, picking one shows
// their name in the field, and the posted comment stores the token. The comment card is the real component over a stub board.

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

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 900, height: 700 } });
  // under heavy machine load a wait that takes seconds on a quiet one can take tens of seconds: one shared budget (test/wait-budget.ts)
  page.setDefaultTimeout(budget(45_000));
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div class="chrome" id="chrome"></div>' }));
  await page.goto(`${base}__blank`);
  await page.addScriptTag({ type: 'module', url: '/test/comment-mentions-page.ts' });
  await page.addScriptTag({ type: 'module', content: "import '/src/styles.css';" });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  return page;
}

describe.skipIf(!available)('mentions in a comment', { timeout: 200_000 }, () => {
  it('offers the people here after @, shows the picked name, and stores the token', async () => {
    const page = await open();
    await page.evaluate(() => (window as unknown as { __app: { onOpenComment: (t: unknown) => void } }).__app.onOpenComment({ anchor: { x: 200, y: 200 }, screen: { x: 300, y: 300 } }));
    const field = page.getByRole('combobox', { name: 'Add a comment' });
    await field.click();
    await field.pressSequentially('Ask @');
    const list = page.getByRole('listbox', { name: 'People' });
    await list.waitFor();
    const options = await list.getByRole('option').allTextContents();
    expect(options).toEqual(['Ben']);
    expect(await field.getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('Enter');
    expect(await field.inputValue()).toBe('Ask @Ben ');
    await page.keyboard.type('look here');
    expect(await field.inputValue()).toBe('Ask @Ben look here');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { __comments: { list: () => unknown[] } }).__comments.list().length === 2);
    const stored = await page.evaluate(() => (window as unknown as { __comments: { list: () => { text: string }[] } }).__comments.list().map((t) => t.text));
    expect(stored).toContain('Ask @{u-ben} look here');
    await page.locator('.comment-card .comment-mention').first().waitFor();
    expect(await page.locator('.comment-card .comment-mention').first().textContent()).toBe('@Ben');
    await page.close();
  });

  it('names someone in a reply and stores the token on the reply', async () => {
    const page = await open();
    await page.evaluate(() => {
      const w = window as unknown as { __app: { onOpenComment: (t: unknown) => void }; __comments: { list: () => { id: string }[] } };
      w.__app.onOpenComment({ threadId: w.__comments.list()[0].id, screen: { x: 300, y: 300 } });
    });
    const field = page.getByRole('combobox', { name: 'Reply' });
    await field.click();
    await field.pressSequentially('@B');
    await page.getByRole('listbox', { name: 'People' }).waitFor();
    await page.keyboard.press('Enter');
    await page.keyboard.type('thanks');
    expect(await field.inputValue()).toBe('@Ben thanks');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { __comments: { list: () => { replies: unknown[] }[] } }).__comments.list()[0].replies.length === 1);
    const texts = await page.evaluate(() => (window as unknown as { __comments: { list: () => { replies: { text: string }[] }[] } }).__comments.list()[0].replies.map((r) => r.text));
    expect(texts).toEqual(['@{u-ben} thanks']);
    await page.close();
  });

  it('closes the list with Escape (the card stays) and with Tab (focus leaves the field), without picking', async () => {
    const page = await open();
    await page.evaluate(() => (window as unknown as { __app: { onOpenComment: (t: unknown) => void } }).__app.onOpenComment({ anchor: { x: 200, y: 200 }, screen: { x: 300, y: 300 } }));
    const field = page.getByRole('combobox', { name: 'Add a comment' });
    await field.click();
    await field.pressSequentially('hi @');
    const list = page.getByRole('listbox', { name: 'People' });
    await list.waitFor();
    await page.keyboard.press('Escape');
    await list.waitFor({ state: 'hidden' });
    expect(await page.locator('.comment-card').count()).toBe(1);
    expect(await field.inputValue()).toBe('hi @');
    await field.pressSequentially('B');
    await list.waitFor();
    await page.keyboard.press('Tab');
    await list.waitFor({ state: 'hidden' });
    expect(await field.inputValue()).toBe('hi @B');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).not.toBe('Add a comment');
    await page.close();
  });

  it('keeps the comment card inside the window while the list is open', async () => {
    const page = await open();
    await page.setViewportSize({ width: 900, height: 420 });
    await page.evaluate(() => (window as unknown as { __app: { onOpenComment: (t: unknown) => void } }).__app.onOpenComment({ anchor: { x: 200, y: 200 }, screen: { x: 300, y: 330 } }));
    const field = page.getByRole('combobox', { name: 'Add a comment' });
    await field.click();
    await field.pressSequentially('@');
    await page.getByRole('listbox', { name: 'People' }).waitFor();
    const box = await page.locator('.comment-card').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(420 + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    await page.close();
  });
});
