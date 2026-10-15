import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { settledBox } from './settled-box';

// The notifications bell and panel in a real browser (proto/designer-preview/notifications/SPEC.md): the real component and CSS over
// a stubbed /api/notifications. Keyboard and focus, the badge, the filter, the states, new rows behind a line, a phone's sheet.

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

const NOW = Date.now();
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'chat_mention', at: NOW - 120_000, read: false, actor: { id: 'u-maja', name: 'Maja' }, board: { id: 'b1', title: 'Retro team' }, team: null,
  snippet: 'Can you look at the second column?', target: '#/b/b1', ...over,
});

interface Fake {
  items: ReturnType<typeof row>[];
  unread: number;
  unreadMentions: number;
  fail: boolean;
  reads: unknown[];
  pageCalls: string[];
  failRead: boolean;
}

async function open(width: number, fake: Partial<Fake> = {}): Promise<{ page: Page; fake: Fake }> {
  const state: Fake = { items: [row('n_1'), row('n_2', { kind: 'board_shared', snippet: null, read: true, at: NOW - 3 * 3_600_000 }), row('n_3', { actor: { id: 'u-ben', name: 'Ben' }, kind: 'comment_reply' })], unread: 2, unreadMentions: 1, fail: false, reads: [], pageCalls: [], failRead: false, ...fake };
  const page = await browser!.newPage({ viewport: { width, height: 800 } });
  await page.route('**/api/notifications**', async (route) => {
    const url = new URL(route.request().url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/unread')) return json(200, { unread: state.unread, unreadMentions: state.unreadMentions });
    if (url.pathname.endsWith('/read')) {
      state.reads.push(JSON.parse(route.request().postData() ?? '{}'));
      if (state.failRead) return json(500, { error: 'boom' });
      const all = JSON.parse(route.request().postData() ?? '{}').all === true;
      return json(200, { unread: all ? 0 : Math.max(0, state.unread - 1), unreadMentions: 0 });
    }
    state.pageCalls.push(url.search);
    if (state.fail) return json(500, { error: 'down' });
    return json(200, { items: state.items, nextCursor: null, unread: state.unread, unreadMentions: state.unreadMentions });
  });
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>.topbar{display:flex;align-items:center;gap:16px;padding:8px 24px}.topbar-end{margin-left:auto}</style><div class="topbar"><a href="#/" id="before">Before</a><div class="topbar-end" id="end"></div><a href="#/x" id="after">After</a></div>' }));
  await page.goto(`${base}__blank`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import { notificationsBell, notificationsStore } from '/src/ui/notifications.ts';
      document.getElementById('end').append(notificationsBell());
      window.__store = notificationsStore();
      window.__ready = true;
    `,
  });
  await page.waitForFunction('window.__ready === true');
  await page.waitForFunction(() => (window as any).__store.state().counts.unread >= 0);
  return { page, fake: state };
}

describe.skipIf(!available)('the bell', () => {
  it('shows no badge at zero, the count, 99+ and a red outline only for an unread mention', async () => {
    const { page } = await open(1280, { unread: 0, unreadMentions: 0 });
    const bell = page.locator('.bell');
    expect(await bell.getAttribute('aria-label')).toBe('Notifications');
    expect(await page.locator('.bell-badge').isVisible()).toBe(false);
    await page.evaluate(() => (window as any).__store.notified({ unread: 3, unreadMentions: 0 }));
    expect(await bell.getAttribute('aria-label')).toBe('Notifications, 3 unread');
    expect(await page.locator('.bell-badge').textContent()).toBe('3');
    expect(await page.locator('.bell-badge').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    await page.evaluate(() => (window as any).__store.notified({ unread: 120, unreadMentions: 2 }));
    expect(await page.locator('.bell-badge').textContent()).toBe('99+');
    expect(await page.locator('.bell-badge').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    expect(await page.locator('.bell-badge').getAttribute('aria-hidden')).toBe('true');
    expect(await page.locator('[aria-live]').count()).toBe(0);
    await page.close();
  });
});

describe.skipIf(!available)('the panel', () => {
  it('opens with Enter, focuses Mark all as read, lists the rows with a full label, and Esc returns focus to the bell', async () => {
    const { page } = await open(1280);
    await page.locator('.bell').focus();
    await page.keyboard.press('Enter');
    await page.locator('.notif-row[data-id]').first().waitFor();
    expect(await page.locator('.bell').getAttribute('aria-expanded')).toBe('true');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Mark all as read');
    expect(await page.getByRole('dialog', { name: 'Notifications' }).count()).toBe(1);
    const labels = await page.locator('.notif-link').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(labels[0]).toBe('Maja mentioned you in Retro team chat, unread. Board chat. 2 minutes ago');
    expect(labels[1]).toMatch(/^Maja shared Retro team with you\. Shared with you\./);
    expect(await page.locator('.notif-excerpt').first().textContent()).toBe('Can you look at the second column?');
    await page.keyboard.press('Escape');
    await page.locator('.notif').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.className)).toBe('bell');
    await page.close();
  });

  it('moves between rows with the arrow keys, and Tab out of the last control closes it and goes on after the bell', async () => {
    const { page } = await open(1280);
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    await page.locator('.notif-link').first().focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Maja shared'))).toBe(true);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Maja mentioned'))).toBe(true);
    await page.getByRole('button', { name: 'Notification settings' }).count(); // present only with chat
    await page.locator('.notif-link').last().focus();
    for (let i = 0; i < 6; i++) {
      const last = await page.evaluate(() => {
        const t = [...document.querySelectorAll('.notif button:not([disabled]), .notif a[href]')];
        return t.at(-1) === document.activeElement;
      });
      if (last) break;
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Tab');
    await page.locator('.notif').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('after');
    await page.close();
  });

  it('closes on a click outside', async () => {
    const { page } = await open(1280);
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    await page.mouse.click(120, 600);
    await page.locator('.notif').waitFor({ state: 'detached' });
    expect(await page.locator('.notif').count()).toBe(0);
    await page.close();
  });

  it('opens a row at its target and marks it read, in one step', async () => {
    const { page, fake } = await open(1280);
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    await page.locator('.notif-link').first().click();
    await page.locator('.notif').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => location.hash)).toBe('#/b/b1');
    expect(fake.reads).toEqual([{ ids: ['n_1'] }]);
    await page.close();
  });

  it('marks one row read from its check button and everything from Mark all, optimistically', async () => {
    const { page, fake } = await open(1280);
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    const first = page.locator('.notif-row').first();
    await first.hover();
    await first.locator('.notif-check').click();
    expect(await first.getAttribute('class')).toContain('read');
    expect(fake.reads[0]).toEqual({ ids: ['n_1'] });
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.notif-row.unread').length === 0);
    expect(fake.reads.at(-1)).toEqual({ all: true });
    expect(await page.getByRole('button', { name: 'Mark all as read' }).isDisabled()).toBe(true);
    await page.close();
  });

  it('puts the dot back and says so when a read cannot be saved', async () => {
    const { page } = await open(1280, { failRead: true });
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    const first = page.locator('.notif-row').first();
    await first.hover();
    await first.locator('.notif-check').click();
    await page.waitForFunction(() => document.querySelector('.notif-row')?.classList.contains('unread'));
    expect(await page.locator('.toast').first().textContent()).toContain('Could not mark that as read');
    await page.close();
  });

  it('narrows to mentions in the list, remembers the chip on this device, and counts per chip', async () => {
    const { page, fake } = await open(1280);
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    expect(await page.locator('.notif-chip', { hasText: 'All' }).locator('.notif-chip-count').textContent()).toBe('2');
    expect(await page.locator('.notif-chip', { hasText: 'Mentions' }).locator('.notif-chip-count').textContent()).toBe('1');
    await page.getByRole('button', { name: /Mentions/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.notif-row').length === 1);
    expect(fake.pageCalls).toHaveLength(1); // the same list, narrowed
    expect(await page.getByRole('button', { name: /Mentions/ }).getAttribute('aria-pressed')).toBe('true');
    expect(await page.evaluate(() => localStorage.getItem('tabula:notifications-filter'))).toBe('mentions');
    await page.close();
  });

  it('says what is empty, and what failed, and tries again', async () => {
    const empty = await open(1280, { items: [], unread: 0, unreadMentions: 0 });
    await empty.page.locator('.bell').click();
    await empty.page.locator('.notif-empty').waitFor();
    expect(await empty.page.locator('.notif-empty').textContent()).toContain("You're all caught up");
    await empty.page.close();

    const failing = await open(1280, { fail: true });
    await failing.page.locator('.bell').click();
    await failing.page.locator('.notif-error').waitFor();
    expect(await failing.page.locator('.notif-error').getAttribute('role')).toBe('alert');
    failing.fake.fail = false;
    await failing.page.getByRole('button', { name: 'Try again' }).click();
    await failing.page.locator('.notif-row[data-id]').first().waitFor();
    await failing.page.close();
  });

  it('keeps the rows where they are when something new arrives, and shows it behind a line on request', async () => {
    const { page, fake } = await open(1280);
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    const before = await page.locator('.notif-row').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
    fake.items = [row('n_9', { at: NOW - 1000, actor: { id: 'u-eva', name: 'Eva' } }), ...fake.items];
    fake.unread = 3;
    await page.evaluate(() => (window as any).__store.notified({ unread: 3, unreadMentions: 2 }));
    await page.getByRole('button', { name: 'Show 1 new' }).waitFor();
    expect(await page.locator('.notif-row').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual(before);
    expect(await page.locator('.bell').getAttribute('aria-label')).toBe('Notifications, 3 unread');
    await page.getByRole('button', { name: 'Show 1 new' }).click();
    expect(await page.locator('.notif-row').first().getAttribute('data-id')).toBe('n_9');
    await page.close();
  });

  it('draws the panel as a 400 px popover under the bell on a wide screen', async () => {
    const { page } = await open(1280);
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    await settledBox(page.locator('.notif-pop'));
    const box = await page.locator('.notif-pop').boundingBox();
    expect(box!.width).toBe(400);
    expect(box!.height).toBeLessThanOrEqual(560);
    const radius = await page.locator('.notif-pop').evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(radius).toBe('12px');
    await page.close();
  });

  it('is a sheet on a phone, inside the screen, with 44 px controls', async () => {
    const { page } = await open(390);
    await page.locator('.bell').click();
    await page.locator('.notif-row[data-id]').first().waitFor();
    await settledBox(page.locator('.notif-pop'));
    const box = await page.locator('.notif-pop').boundingBox();
    expect(box!.x).toBe(8);
    expect(box!.x + box!.width).toBe(382);
    expect(box!.y).toBe(64);
    expect(box!.y + box!.height).toBeLessThanOrEqual(800 - 8);
    for (const sel of ['.notif-chip', '.notif-text-btn']) {
      const sizes = await page.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      expect([sel, Math.min(...sizes) >= 44]).toEqual([sel, true]);
    }
    await page.keyboard.press('Escape');
    await page.locator('.notif').waitFor({ state: 'detached' });
    await page.close();
  });
});
