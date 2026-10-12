import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// Message styling in a real browser (docs/chat.md, Interface): the hover tools and the quick-reactions bar by keyboard, your own
// bubble on the right, and the compact dock's one line per message. The conversation is mounted over a stub channel.

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

async function open(mode: 'open' | 'compact', width = 700): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 700 } });
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="host"></div>' }));
  await page.goto(`${base}__blank`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import { mountConversation } from '/src/ui/chat.ts';
      const T = Date.UTC(2026, 9, 12, 9, 40);
      const msg = (id, over) => ({ id, kind: 'workspace', ref: 'main', authorId: 'ana', authorName: 'Ana Lima', clientId: 'client-' + id + '-xx', text: 'm' + id, replyTo: null, objectId: null, mentions: [], createdAt: T + id * 1000, editedAt: null, deleted: false, deletedBy: null, ...over });
      const view = {
        meId: 'me', messages: [msg(1, { text: 'Flaky tests are mine' }), msg(2, { text: 'First sticky needs a headline' }),
          msg(3, { authorId: 'me', authorName: 'Me', text: 'On it, one minute.' }),
          msg(4, { authorId: 'ben', authorName: 'Ben Okafor', text: 'hi @{me} can you share?', mentions: [{ id: 'me', name: 'Me' }], reactions: [{ emoji: '👍', userIds: ['ana', 'me'] }] })],
        pending: [], access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [], loading: false, loadingOlder: false, hasOlder: false,
        savedOnly: false, lost: false, online: true, signedOut: false, newAfter: null, unread: 0, mentions: 0, error: null,
      };
      window.__reacted = [];
      const chat = { view: () => view, onChange: () => () => {}, setVisible() {}, loadOlder: async () => {}, send() {}, retry() {}, discard() {}, edit: async () => {}, remove: async () => {},
        react: async (id, emoji, on) => { window.__reacted.push([id, emoji, on]); }, markRead() {} };
      const host = document.querySelector('#host');
      ${mode === 'compact'
        ? "host.className = 'chat-dock-host'; host.dataset.mode = 'compact'; const dock = document.createElement('div'); dock.className = 'chat-dock tray'; host.append(dock);"
        : "const dock = document.createElement('div'); dock.className = 'chat-page tray'; dock.style.cssText = 'height:600px;display:flex;flex-direction:column'; host.append(dock);"}
      const panel = document.createElement('div');
      panel.className = 'chat-panel';
      dock.append(panel);
      mountConversation({ chat, id: 'w', panel, signal: new AbortController().signal, meId: 'me', meName: 'Me' }).setOpen(true);
      window.__ready = true;
    `,
  });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 120_000 });
  await page.locator('.chat-msg').first().waitFor();
  return page;
}

describe.skipIf(!available)('message styling in a browser', { timeout: 200_000 }, () => {
  it('shows the hover tools on hover and on focus, and Esc closes the quick reactions with focus back on React', async () => {
    const page = await open('open');
    const row = page.locator('.chat-msg').first();
    const shown = () => row.locator('.chat-hover').evaluate((el) => getComputedStyle(el).opacity);
    expect(await shown()).toBe('0');
    await row.hover();
    expect(await shown()).toBe('1');
    // by keyboard: focus within the row shows the tools too
    await page.mouse.move(0, 0);
    await row.locator('.chat-react').focus();
    expect(await shown()).toBe('1');
    await page.keyboard.press('Enter');
    const bar = page.locator('.chat-quick');
    await bar.waitFor();
    expect(await bar.locator('button').count()).toBe(6);
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('chat-quick-btn');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label'))).toBe((await bar.locator('button').nth(1).getAttribute('aria-label')));
    await page.keyboard.press('Escape');
    expect(await bar.count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('chat-react');
    await page.close();
  });

  it('reacts with the chosen emoji from the quick bar', async () => {
    const page = await open('open');
    const row = page.locator('.chat-msg').first();
    await row.hover();
    await row.locator('.chat-react').click();
    const first = page.locator('.chat-quick button').first();
    const label = await first.getAttribute('aria-label');
    await first.click();
    const sent = await page.evaluate(() => (window as unknown as { __reacted: unknown[][] }).__reacted);
    expect(sent).toEqual([[1, label, true]]);
    expect(await page.locator('.chat-quick').count()).toBe(0);
    await page.close();
  });

  it('draws your own message as a bubble on the right with no square, and a message that names you with a signal bar', async () => {
    const page = await open('open');
    const rows = page.locator('.chat-msg');
    const own = rows.nth(2);
    expect(await own.evaluate((el) => el.classList.contains('own'))).toBe(true);
    expect(await own.locator('.chat-avatar').isVisible()).toBe(false);
    const box = (await own.locator('.chat-text').boundingBox())!;
    const log = (await page.locator('.chat-log').boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(log.x + log.width - 40);
    expect(box.x).toBeGreaterThan(log.x + log.width / 2);
    expect(await own.locator('.chat-name').isVisible()).toBe(false);
    const mention = rows.nth(3);
    expect(await mention.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
    // the pill for a reaction that is yours carries the signal colour as its border
    const pill = mention.locator('.chat-reaction.mine');
    expect(await pill.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(await mention.locator('.chat-quote, .chat-text').first().evaluate((el) => getComputedStyle(el).color));
    await page.close();
  });

  it('puts every message on one line in the compact dock: name, time and text, no square, no bubble', async () => {
    const page = await open('compact', 340);
    const rows = page.locator('.chat-msg');
    for (let i = 0; i < 4; i++) {
      const row = rows.nth(i);
      expect(await row.locator('.chat-avatar').isVisible()).toBe(false);
      expect(await row.locator('.chat-name').isVisible()).toBe(true);
      expect(await row.locator('.chat-time').isVisible()).toBe(true);
    }
    // the second message of Ana's run still shows her name
    expect(await rows.nth(1).locator('.chat-name').innerText()).toBe('Ana Lima');
    const first = (await rows.nth(0).boundingBox())!;
    expect(first.height).toBeLessThan(30);
    const nameBox = (await rows.nth(0).locator('.chat-name').boundingBox())!;
    const textBox = (await rows.nth(0).locator('.chat-text').boundingBox())!;
    expect(Math.abs(nameBox.y - textBox.y)).toBeLessThan(8);
    expect(textBox.x).toBeGreaterThan(nameBox.x + nameBox.width);
    // your own message is not a right-aligned bubble here
    const ownBox = (await rows.nth(2).locator('.chat-text').boundingBox())!;
    expect(ownBox.x).toBeLessThan(200);
    expect(await rows.nth(2).locator('.chat-text').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await page.close();
  });

  it('shows a focus ring on a reaction pill and on Send when reached by keyboard, and no ring on an unfocused pill or badge', async () => {
    const page = await open('open');
    const pill = page.locator('.chat-reaction').first();
    const ring = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => { const c = getComputedStyle(el); return c.outlineStyle === 'none' ? 'none' : `${c.outlineStyle} ${c.outlineWidth}`; });
    expect(await ring(pill)).toBe('none');
    await page.locator('.chat-input').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    for (let i = 0; i < 12 && !(await pill.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Shift+Tab');
    expect(await ring(pill)).toBe('solid 2px');
    await page.locator('.chat-input').fill('hello');
    await page.locator('.chat-input').focus();
    for (let i = 0; i < 4 && !(await page.evaluate(() => document.activeElement?.classList.contains('chat-send'))); i++) await page.keyboard.press('Tab');
    expect(await ring(page.locator('.chat-send'))).toMatch(/^solid [1-9]/);
    await page.close();
  });
});
