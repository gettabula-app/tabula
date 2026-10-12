import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// "Here now" on the Boards rows in a real browser (proto/designer-preview/presence/SPEC.md): the real table, rows and CSS with the
// presence store fed by hand. Layout (fixed row height, the phone's omitted cell), the hover list, the keyboard, the click.

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

async function open(width: number): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 700 } });
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="host"></div>' }));
  await page.goto(`${base}__blank`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import { boardTable } from '/src/ui/home.ts';
      import { boardsPresence } from '/src/presence.ts';
      const U = (userId, name, joinedAt, colour) => ({ userId, name, joinedAt, colour });
      boardsPresence.set('crowd', { boardId: 'crowd', count: 4, me: true, people: [U('a', 'Ana', 1, '#326DD3'), U('b', 'Ben', 2, '#D3332D'), U('c', 'Cy', 3, '#1B8151'), U('d', 'Di', 4, '#A06A00')] });
      boardsPresence.set('pair', { boardId: 'pair', count: 1, people: [U('a', 'Ana', 1, '#326DD3')] });
      const row = (id, title) => ({ id, title, updatedAt: Date.now() - 3600000, role: 'editor', chat: false, here: true, actions: [] });
      document.getElementById('host').append(boardTable('Team', [row('crowd', 'Crowded'), row('pair', 'Pair'), row('empty', 'Alone')], 'access'));
      window.__store = boardsPresence;
      window.__ready = true;
    `,
  });
  await page.waitForFunction('window.__ready === true');
  return page;
}

describe.skipIf(!available)('here now', () => {
  it('draws squares, You and +N from the store, with a spoken label and no new tab stop', async () => {
    const page = await open(1280);
    const crowd = page.locator('.board-row', { hasText: 'Crowded' }).locator('.board-here');
    expect(await crowd.getAttribute('role')).toBe('img');
    expect(await crowd.getAttribute('aria-label')).toBe('Ana, Ben and 3 more are here now');
    expect(await crowd.locator('.here-sq').allTextContents()).toEqual(['A', 'B', 'You']);
    expect(await crowd.locator('.here-more').textContent()).toBe('+2');
    // only the row's link and nothing in the cluster takes focus
    const stops = await page.evaluate(() => [...document.querySelectorAll('.board-row')].map((r) => r.querySelectorAll('a,button,[tabindex]').length));
    expect(stops).toEqual([1, 1, 1]);
    // alone on a board draws nothing
    const alone = page.locator('.board-row', { hasText: 'Alone' }).locator('.board-here');
    expect([await alone.count(), await alone.evaluate((el) => el.children.length), await alone.getAttribute('aria-label')]).toEqual([1, 0, null]);
    await page.close();
  });

  it('keeps every row the same height whether or not people are there, and updates in place', async () => {
    const page = await open(1280);
    const heights = await page.evaluate(() => [...document.querySelectorAll('.board-row')].map((r) => r.getBoundingClientRect().height));
    expect(new Set(heights).size).toBe(1);
    const grown = await page.evaluate(() => {
      (window as any).__store.set('empty', { boardId: 'empty', count: 1, people: [{ userId: 'z', name: 'Zed', joinedAt: 9 }] });
      return [...document.querySelectorAll('.board-row')].map((r) => r.getBoundingClientRect().height);
    });
    expect(grown).toEqual(heights);
    expect(await page.locator('.board-row', { hasText: 'Alone' }).locator('.board-here').getAttribute('aria-label')).toBe('Zed is here now');
    await page.close();
  });

  it('shows everyone in a list on hover and on keyboard focus of the row link', async () => {
    const page = await open(1280);
    const row = page.locator('.board-row', { hasText: 'Crowded' });
    const tip = row.locator('.here-tip');
    expect(await tip.isVisible()).toBe(false);
    await row.locator('.board-here').hover();
    expect(await tip.isVisible()).toBe(true);
    expect(await tip.locator('.here-tip-row').allTextContents()).toEqual(['Ana', 'Ben', 'Cy', 'Di']);
    await page.mouse.move(0, 0);
    expect(await tip.isVisible()).toBe(false);
    await page.keyboard.press('Tab');
    expect(await tip.isVisible()).toBe(true);
    await page.close();
  });

  it('goes to the board when the cluster is clicked', async () => {
    const page = await open(1280);
    await page.locator('.board-row', { hasText: 'Pair' }).locator('.here-sq').first().click();
    expect(await page.evaluate(() => location.hash)).toBe('#/b/pair');
    await page.close();
  });

  it('on a phone puts the cluster and the names before the edited time, and omits the cell when empty', async () => {
    const page = await open(390);
    const crowd = page.locator('.board-row', { hasText: 'Crowded' });
    expect(await crowd.locator('.here-names').isVisible()).toBe(true);
    expect(await crowd.locator('.here-names').textContent()).toBe('Ana, Ben and 3 more');
    expect(await crowd.locator('.here-sq').first().evaluate((el) => el.getBoundingClientRect().height)).toBe(20);
    expect(await crowd.locator('.here-tip').isVisible()).toBe(false);
    const order = await crowd.locator('.board-sub').evaluate((el) => [...el.children].map((c) => c.className.split(' ')[0]));
    expect(order.slice(0, 2)).toEqual(['board-here', 'board-edited']);
    const alone = page.locator('.board-row', { hasText: 'Alone' }).locator('.board-here');
    expect(await alone.evaluate((el) => getComputedStyle(el).display)).toBe('none');
    await page.close();
  });

  const tailOf = async (row: import('playwright').Locator) => ({
    shown: await row.locator('.here-names').evaluate((e) => getComputedStyle(e).display !== 'none'),
    head: await row.locator('.here-names-head').textContent(),
    tail: (await row.locator('.here-names-tail').textContent()) ?? '',
    cut: await row.locator('.here-names-head').evaluate((e) => e.scrollWidth > e.clientWidth),
  });
  const put = (page: Page, count: number, names: string[]) => page.evaluate(([c, n]) => (window as any).__store.set('empty', {
    boardId: 'empty', count: c, people: (n as string[]).map((name, i) => ({ userId: `p${i}`, name, joinedAt: i + 1 })),
  }), [count, names] as const);

  it('on a phone hides the text, and never shows a cut name beside the count, when nothing fits whole', async () => {
    const page = await open(390);
    await put(page, 6, ['Wolfeschlegelsteinhausen Bergerdorff', 'Hubert Blaine Wolfeschlegelstein']);
    const row = page.locator('.board-row', { hasText: 'Alone' });
    await page.waitForFunction(() => document.querySelectorAll('.board-row')[2].querySelector('.here-names')?.getAttribute('data-fit') === 'hidden');
    expect((await tailOf(row)).shown).toBe(false);
    // the squares and the label still carry it
    expect(await row.locator('.board-here').getAttribute('aria-label')).toBe('Wolfeschlegelsteinhausen Bergerdorff, Hubert Blaine Wolfeschlegelstein and 4 more are here now');
    await page.close();
  });

  it('on a phone writes one name and the count when two names do not fit, and keeps two when they do', async () => {
    const page = await open(390);
    await put(page, 3, ['Maximilian Rosenberg', 'Bartholomew Winterbourne', 'Cy']);
    const row = page.locator('.board-row', { hasText: 'Alone' });
    await page.waitForFunction(() => document.querySelectorAll('.board-row')[2].querySelector('.here-names-tail')?.textContent === ' and 2 more');
    expect(await tailOf(row)).toMatchObject({ shown: true, head: 'Maximilian', cut: false });
    await put(page, 3, ['Ana', 'Bo', 'Cy']);
    await page.waitForFunction(() => document.querySelectorAll('.board-row')[2].querySelector('.here-names-head')?.textContent === 'Ana, Bo');
    expect(await tailOf(row)).toMatchObject({ shown: true, tail: ' and 1 more', cut: false });
    await page.close();
  });

  it('on a phone may cut a long name when there are two people or fewer (no count to protect)', async () => {
    const page = await open(390);
    await put(page, 2, ['Wolfeschlegelsteinhausen Bergerdorff', 'Hubert Blaine Wolfeschlegelstein']);
    const row = page.locator('.board-row', { hasText: 'Alone' });
    await page.waitForFunction(() => document.querySelectorAll('.board-row')[2].querySelector('.here-names-head')?.textContent === 'Wolfeschlegelsteinhausen and Hubert');
    expect(await tailOf(row)).toMatchObject({ shown: true, tail: '', cut: true });
    await page.close();
  });

  it('picks the step from the real width: a 360 px phone and a 430 px phone can differ', async () => {
    const small = await open(360);
    const large = await open(430);
    for (const p of [small, large]) await put(p, 3, ['Maximilian', 'Bartholomew', 'Cy']);
    const rowOf = (p: Page) => p.locator('.board-row', { hasText: 'Alone' });
    await large.waitForFunction(() => document.querySelectorAll('.board-row')[2].querySelector('.here-names-tail') !== null);
    const [a, b] = [await tailOf(rowOf(small)), await tailOf(rowOf(large))];
    for (const t of [a, b]) expect(t.shown ? !(t.tail && t.cut) : true).toBe(true); // never a cut name beside a count
    expect(b.shown || !a.shown).toBe(true); // wider never shows less than narrower
    await small.close();
    await large.close();
  });

  it('draws each person in their own colour and falls back to the ink with the paper as text', async () => {
    const page = await open(1280);
    const crowd = page.locator('.board-row', { hasText: 'Crowded' }).locator('.here-sq');
    const bg = await crowd.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    expect(bg[0]).toBe('rgb(50, 109, 211)');
    expect(bg[1]).toBe('rgb(211, 51, 45)');
    await page.evaluate(() => (window as any).__store.set('empty', { boardId: 'empty', count: 1, people: [{ userId: 'q', name: 'Quinn', joinedAt: 1 }] }));
    const plain = page.locator('.board-row', { hasText: 'Alone' }).locator('.here-sq');
    const [ink, paper] = await plain.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]);
    const root = await page.evaluate(() => [getComputedStyle(document.body).color]);
    expect(ink).toBe(root[0]);
    expect(paper).not.toBe(ink);
    await page.close();
  });
});
