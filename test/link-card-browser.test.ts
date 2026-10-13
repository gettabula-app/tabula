import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { openRailTool } from './rail-tool-helper';
import { budget } from './wait-budget';

// Link cards in the real app (docs/link-cards.md, proto/designer-preview/link-cards/SPEC.md): the board runs from the dev server with
// no relay (it opens from this browser's own copy), and the API the card needs is answered by the test: config, the unfurl route
// and the asset route. Paste, Turn into text and Undo, opening, the rail popover, the secret warning, drops, previews off, failures.

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

const HASH = 'b'.repeat(64);
const GREY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

interface Stub {
  previews: boolean;
  /** What the unfurl route answers: a body, or an error status and code. */
  answer: { status: number; body: unknown };
  unfurls: { url: string; refresh?: boolean }[];
  delay: number;
}

async function open(over: Partial<Stub> = {}, width = 1280): Promise<{ page: Page; stub: Stub }> {
  const stub: Stub = {
    previews: true,
    answer: { status: 200, body: { title: 'Example Domain', description: 'This domain is for use in examples.', siteName: 'Example', image: HASH, imageW: 1200, imageH: 630, icon: HASH, finalUrl: 'https://example.com/', fetchedAt: 1 } },
    unfurls: [],
    delay: 0,
    ...over,
  };
  const page = await browser!.newPage({ viewport: { width, height: 800 } });
  // under heavy machine load a wait that takes seconds on a quiet one can take tens of seconds: one shared budget (test/wait-budget.ts)
  page.setDefaultTimeout(budget(45_000));
  await page.addInitScript(() => {
    (window as unknown as { __opened: unknown[] }).__opened = [];
    window.open = ((url: string, target: string, features: string) => { (window as unknown as { __opened: unknown[] }).__opened.push([url, target, features]); return null; }) as typeof window.open;
  });
  await page.route('**/api/config', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authEnabled: false, images: true, linkPreviews: stub.previews }) }));
  await page.route('**/api/boards/*/unfurl', async (route) => {
    stub.unfurls.push(JSON.parse(route.request().postData() ?? '{}'));
    if (stub.delay) await new Promise((r) => setTimeout(r, stub.delay));
    await route.fulfill({ status: stub.answer.status, contentType: 'application/json', body: JSON.stringify(stub.answer.body) });
  });
  await page.route('**/api/boards/*/assets/**', (route) => route.fulfill({ contentType: 'image/png', body: GREY_PNG }));
  await page.goto(`${base}?debug#/b/link-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  await page.waitForFunction(() => document.querySelector('.rail-tool-group'));
  return { page, stub };
}

const links = (page: Page) => page.evaluate(() => [...(window as any).__board.store.cache.values()].filter((o: any) => o.type === 'link').map((o: any) => ({ id: o.id, url: o.url, unfurl: o.unfurl, title: o.title, w: o.w, h: o.h, unfurlError: o.unfurlError, image: o.image, edited: o.edited })));
const texts = (page: Page) => page.evaluate(() => [...(window as any).__board.store.cache.values()].filter((o: any) => o.type === 'text' || o.type === 'sticky').map((o: any) => o.text));
const paste = (page: Page, text: string) => page.evaluate((t) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', t);
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);
const opened = (page: Page) => page.evaluate(() => (window as any).__opened as unknown[][]);

describe.skipIf(!available)('a pasted address', () => {
  it('makes a card at once, fills its preview in, and tells the person with a Turn into text button', async () => {
    const { page, stub } = await open({ delay: 150 });
    await paste(page, 'https://example.com/');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link'));
    const first = (await links(page))[0];
    expect([first.url, first.unfurl, first.w, first.h]).toEqual(['https://example.com/', 'pending', 320, 128]);
    expect(await page.locator('.toast').textContent()).toContain('Link added');
    expect(await page.locator('.toast-action').textContent()).toBe('Turn into text');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link' && o.unfurl === 'ok'));
    const done = (await links(page))[0];
    expect([done.title, done.image, stub.unfurls]).toEqual(['Example Domain', HASH, [{ url: 'https://example.com/' }]]);
    // the card is real SVG text, named for assistive tech, with the picture only from our asset route
    const card = page.locator('[role="link"].link-card').first();
    expect(await card.getAttribute('aria-label')).toBe('Link card: Example Domain, example.com. Press Enter to open.');
    const hrefs = await page.locator('.link-card image').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    for (const href of hrefs) expect(href).toMatch(/^blob:/);
    await page.close();
  });

  it('is taken back whole by Undo, never leaving an empty card, and comes back with Redo', async () => {
    const { page } = await open();
    await paste(page, 'https://example.com/');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link' && o.unfurl === 'ok'));
    await page.keyboard.press('Control+z');
    expect(await links(page)).toEqual([]);
    await page.keyboard.press('Control+Shift+z');
    expect((await links(page)).map((l) => [l.url, l.unfurl])).toEqual([['https://example.com/', 'ok']]);
    await page.close();
  });

  it('turns into text in one undo step, and Undo brings the card back whole', async () => {
    const { page } = await open();
    await paste(page, 'https://example.com/a');
    await page.waitForFunction(() => document.querySelector('.toast-action'));
    await page.locator('.toast-action').click();
    expect(await links(page)).toEqual([]);
    expect(await texts(page)).toEqual(['https://example.com/a']);
    await page.keyboard.press('Control+z');
    expect((await links(page)).map((l) => l.url)).toEqual(['https://example.com/a']);
    expect(await texts(page)).toEqual([]);
    await page.close();
  });

  it('stays a sticky or text when it is among other text, and when it is pasted as plain text', async () => {
    const { page } = await open();
    await paste(page, 'see https://example.com/ for more');
    expect(await links(page)).toEqual([]);
    expect(await texts(page)).toEqual(['see https://example.com/ for more']);
    await page.keyboard.press('Control+Shift+v');
    await paste(page, 'https://example.com/plain');
    expect(await links(page)).toEqual([]);
    expect(await texts(page)).toContain('https://example.com/plain');
    await page.close();
  });

  it('is a compact card with the address only when previews are off, and asks the relay for nothing', async () => {
    const { page, stub } = await open({ previews: false });
    await paste(page, 'https://example.com/off');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link'));
    const card = (await links(page))[0];
    expect([card.unfurl, card.w, card.h]).toEqual(['off', 320, 48]);
    expect(stub.unfurls).toEqual([]);
    await page.close();
  });

  it('marks the card failed with a reason, and keeps it', async () => {
    const { page } = await open({ answer: { status: 422, body: { error: 'timeout', message: 'The site did not answer in time' } } });
    await paste(page, 'https://slow.example/');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link' && o.unfurl === 'failed'));
    expect((await links(page))[0]).toMatchObject({ unfurl: 'failed', unfurlError: 'timeout' });
    expect(await page.locator('.link-card').first().getAttribute('aria-label')).toContain('no preview');
    expect(await page.locator('.link-card title').first().textContent()).toContain('The site did not answer in time.');
    await page.close();
  });

  it('marks it off when the relay says previews are off', async () => {
    const { page } = await open({ answer: { status: 409, body: { error: 'previews_off', message: 'Link previews are off.' } } });
    await paste(page, 'https://example.com/');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link' && o.unfurl === 'off'));
    expect((await links(page))[0].unfurl).toBe('off');
    await page.close();
  });
});

describe.skipIf(!available)('opening a card', () => {
  async function withCard() {
    const ctx = await open();
    await paste(ctx.page, 'https://example.com/open');
    await ctx.page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link' && o.unfurl === 'ok'));
    await ctx.page.evaluate(() => (window as any).__board.setSelection([]));
    return ctx;
  }
  const centre = (page: Page) => page.evaluate(() => {
    const app = (window as any).__board;
    const o = [...app.store.cache.values()].find((x: any) => x.type === 'link') as any;
    const p = app.r.toScreen({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
    const box = app.r.svg.getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
  });

  it('opens on Enter and Cmd/Ctrl+Enter, without opener or referrer, and a plain click only selects', async () => {
    const { page } = await withCard();
    const c = await centre(page);
    await page.mouse.click(c.x, c.y);
    expect(await opened(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__board.selection.length)).toBe(1);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+Enter');
    expect(await opened(page)).toEqual([['https://example.com/open', '_blank', 'noopener,noreferrer'], ['https://example.com/open', '_blank', 'noopener,noreferrer']]);
    await page.close();
  });

  it('opens on a double click and on Ctrl/Cmd+click', async () => {
    const { page } = await withCard();
    const c = await centre(page);
    await page.mouse.dblclick(c.x, c.y);
    await page.keyboard.down('Control');
    await page.mouse.click(c.x, c.y);
    await page.keyboard.up('Control');
    expect((await opened(page)).length).toBeGreaterThanOrEqual(2);
    expect((await opened(page)).every((o) => o[0] === 'https://example.com/open' && o[2] === 'noopener,noreferrer')).toBe(true);
    await page.close();
  });

  it('shows the edge in ink and an open hint under the pointer, and takes them away again', async () => {
    const { page } = await withCard();
    const c = await centre(page);
    await page.mouse.move(c.x, c.y);
    await page.waitForSelector('.link-hover');
    expect(await page.locator('.link-hover rect').first().getAttribute('stroke')).toContain('--ink');
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => !document.querySelector('.link-hover'));
    await page.close();
  });
});

describe.skipIf(!available)('the Link button', () => {
  it('opens a popover on the right, adds on Enter at the view centre, selected, and Esc returns focus to the button', async () => {
    const { page } = await open();
    await openRailTool(page, 'Link');
    const rail = page.locator('.rail-btn[aria-label="Link"]');
    const field = page.getByRole('textbox', { name: 'Web address' });
    await field.waitFor();
    expect(await rail.evaluate((e) => e.classList.contains('on'))).toBe(true);
    expect(await page.locator('.link-hint').textContent()).toBe('Press Add to put a link card on the board.');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Link');
    await rail.click();
    await field.fill('https://example.org/x');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link'));
    expect((await links(page))[0].url).toBe('https://example.org/x');
    expect(await page.evaluate(() => (window as any).__board.selection.length)).toBe(1);
    await page.close();
  });

  it('says why an address is refused, under the field, and adds nothing', async () => {
    const { page } = await open();
    await openRailTool(page, 'Link');
    const field = page.getByRole('textbox', { name: 'Web address' });
    for (const [text, message] of [['example.org', 'Enter a web address that starts with http:// or https://.'], ['https://user:pw@example.org/', 'Addresses that contain a user name or password cannot be added.'], ['javascript:alert(1)', 'Enter a web address that starts with http:// or https://.']]) {
      await field.fill(text);
      await page.keyboard.press('Enter');
      expect(await page.locator('.link-problem').textContent()).toBe(message);
      expect(await field.getAttribute('aria-invalid')).toBe('true');
    }
    expect(await links(page)).toEqual([]);
    await page.close();
  });

  it('says previews are off in the hint when they are', async () => {
    const { page } = await open({ previews: false });
    await openRailTool(page, 'Link');
    expect(await page.locator('.link-hint').textContent()).toBe('Previews are off. The card shows the address only.');
    await page.close();
  });
});

describe.skipIf(!available)('an address that looks like it holds a secret', () => {
  it('asks first, starting on Cancel, with the value cut; Cancel adds nothing and Add anyway does', async () => {
    const { page } = await open();
    await paste(page, 'https://example.com/cb?token=abc123&q=1');
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    expect(await page.locator('.link-secret p').textContent()).toBe('This link may contain a secret that everyone on the board will see.');
    expect(await page.locator('.link-secret-url').textContent()).toBe('https://example.com/cb?token=…&q=1');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Cancel');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Cancel');
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await links(page)).toEqual([]);
    await paste(page, 'https://example.com/cb?token=abc123&q=1');
    await page.getByRole('button', { name: 'Add anyway' }).click();
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link'));
    expect((await links(page))[0].url).toBe('https://example.com/cb?token=abc123&q=1');
    await page.close();
  });
});

describe.skipIf(!available)('a dropped link', () => {
  it('makes a card per address, at most ten, and says how many', async () => {
    const { page } = await open();
    await page.evaluate(() => {
      const list = Array.from({ length: 14 }, (_, i) => `https://site${i}.example/`).join('\r\n');
      const dt = new DataTransfer();
      dt.setData('text/uri-list', list);
      const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 400, clientY: 300 });
      (window as any).__board.r.svg.dispatchEvent(drop);
    });
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].filter((o: any) => o.type === 'link').length === 10, null, { timeout: budget(8000) });
    expect(await page.locator('.toast').textContent()).toBe('10 links added');
    await page.close();
  });
});

describe.skipIf(!available)('the quick bar', () => {
  async function selected(over: Partial<Stub> = {}, width = 1280) {
    const ctx = await open(over, width);
    await paste(ctx.page, 'https://example.com/bar');
    const settled = ctx.stub.previews ? 'ok' : 'off';
    await ctx.page.waitForFunction((state) => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link' && o.unfurl === state), settled);
    await ctx.page.evaluate(() => { const app = (window as any).__board; app.setSelection([[...app.store.cache.values()].find((o: any) => o.type === 'link').id]); });
    await ctx.page.locator('.quickbar.show').waitFor();
    return ctx;
  }
  const bar = (page: Page) => page.locator('.quickbar');

  it('offers the layouts, Open, Refresh, Edit and Turn into text, with the current layout pressed', async () => {
    const { page } = await selected();
    expect(await bar(page).locator('.qb-seg').allTextContents()).toEqual(['Compact', 'Card', 'Large']);
    expect(await bar(page).locator('.qb-seg[aria-pressed="true"]').textContent()).toBe('Card');
    for (const name of ['Open link', 'Refresh preview', 'Edit', 'Turn into text']) expect([name, await bar(page).getByRole('button', { name }).count()]).toEqual([name, 1]);
    await page.close();
  });

  it('resizes to a layout default in one undo step', async () => {
    const { page } = await selected();
    await bar(page).locator('.qb-seg', { hasText: 'Large' }).click();
    expect((await links(page))[0]).toMatchObject({ w: 320, h: 280 });
    await bar(page).locator('.qb-seg', { hasText: 'Compact' }).click();
    expect((await links(page))[0]).toMatchObject({ w: 320, h: 48 });
    await page.keyboard.press('Control+z');
    expect((await links(page))[0]).toMatchObject({ w: 320, h: 280 });
    expect(await bar(page).locator('.qb-seg[aria-pressed="true"]').textContent()).toBe('Large');
    await page.close();
  });

  it('refreshes: pending at once, the cache skipped, and what a person edited kept', async () => {
    const { page, stub } = await selected({ delay: 300 });
    await page.evaluate(() => { const app = (window as any).__board; const o = [...app.store.cache.values()].find((x: any) => x.type === 'link'); app.store.transact(() => app.store.update(o.id, { title: 'My own title', edited: ['title'] })); });
    await bar(page).getByRole('button', { name: 'Refresh preview' }).click();
    expect((await links(page))[0].unfurl).toBe('pending');
    expect(await bar(page).getByRole('button', { name: 'Refresh preview' }).isDisabled()).toBe(true);
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link' && o.unfurl === 'ok'));
    expect(stub.unfurls.at(-1)).toEqual({ url: 'https://example.com/bar', refresh: true });
    expect((await links(page))[0].title).toBe('My own title');
    await page.close();
  });

  it('edits the title and description in place: a click outside saves, Esc cancels, and edited fields are marked', async () => {
    const { page } = await selected();
    await bar(page).getByRole('button', { name: 'Edit' }).click();
    const title = page.getByRole('textbox', { name: 'Title' });
    await title.fill('Renamed');
    await page.keyboard.press('Escape');
    await page.locator('.link-edit').waitFor({ state: 'detached', timeout: budget(5000) });
    expect((await links(page))[0].title).toBe('Example Domain');
    await bar(page).getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Renamed');
    await page.mouse.click(5, 400);
    await page.locator('.link-edit').waitFor({ state: 'detached' });
    expect((await links(page))[0]).toMatchObject({ title: 'Renamed', edited: ['title'] });
    await page.close();
  });

  it('turns into text from the bar, and a text that is one address into a card', async () => {
    const { page } = await selected();
    await bar(page).getByRole('button', { name: 'Turn into text' }).click();
    expect(await links(page)).toEqual([]);
    const id = await page.evaluate(() => { const app = (window as any).__board; const t = [...app.store.cache.values()].find((o: any) => o.type === 'text'); app.setSelection([t.id]); return t.id; });
    await page.locator('.quickbar.show').waitFor();
    await bar(page).getByRole('button', { name: 'Turn into link card' }).click();
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link'));
    expect((await links(page))[0].url).toBe('https://example.com/bar');
    expect(await page.evaluate((i) => (window as any).__board.store.get(i), id)).toBeUndefined();
    await page.keyboard.press('Control+z');
    expect(await links(page)).toEqual([]);
    expect(await texts(page)).toEqual(['https://example.com/bar']);
    await page.close();
  });

  it('shows a viewer Open alone', async () => {
    const { page } = await selected();
    await page.evaluate(() => (window as any).__board.store.setReadOnly(true));
    await page.waitForFunction(() => document.querySelectorAll('.quickbar .icon-btn').length === 1);
    expect(await bar(page).getByRole('button').allTextContents()).toEqual(['Open']);
    await bar(page).getByRole('button', { name: 'Open link' }).click();
    expect((await opened(page)).length).toBe(1);
    await page.close();
  });

  it('has no Refresh when previews are off', async () => {
    const { page } = await selected({ previews: false });
    expect(await bar(page).getByRole('button', { name: 'Refresh preview' }).isVisible()).toBe(false);
    await page.close();
  });

  it('keeps Open in the bar on a phone and puts the rest in the more-actions menu', async () => {
    const { page } = await selected({}, 390);
    expect(await bar(page).locator('.qb-seg').count()).toBe(0);
    expect(await bar(page).getByRole('button', { name: 'Open link' }).count()).toBe(1);
    await bar(page).getByRole('button', { name: 'More actions' }).click();
    const items = await page.locator('.qb-action-menu .menu-item').allTextContents();
    for (const label of ['Compact', 'Card', 'Large', 'Refresh preview', 'Edit', 'Turn into text']) expect(items.join('|')).toContain(label);
    await page.close();
  });
});

describe.skipIf(!available)('exports', () => {
  it('writes the card as a real link with its picture inlined in an SVG export, and as [Title](address) in the Markdown summary', async () => {
    const { page } = await open();
    await page.addScriptTag({ type: 'module', content: "import { exportSvgFile } from '/src/exporters.ts'; window.__exportSvgFile = exportSvgFile; window.__exp = true;" });
    await page.waitForFunction(() => (window as any).__exp === true);
    await paste(page, 'https://example.com/md');
    await page.waitForFunction(() => [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'link' && o.unfurl === 'ok'));
    const out = await page.evaluate(async () => {
      const app = (window as any).__board;
      const link = [...app.store.cache.values()].find((o: any) => o.type === 'link');
      app.store.transact(() => app.store.create({ id: 'fr1', type: 'frame', x: link.x - 40, y: link.y - 60, w: link.w + 80, h: link.h + 120, rotation: 0, z: 'f0', name: 'Reading' }));
      app.store.transact(() => app.store.update(link.id, { parent: 'fr1' }));
      const svg: string = await (window as any).__exportSvgFile(app, [link.id]);
      return { svg, md: app.flow.summaryMarkdown() };
    });
    expect(out.svg).toMatch(/<a class="link-card" href="https:\/\/example\.com\/md" target="_blank" rel="noopener noreferrer"/);
    expect(out.svg).toMatch(/<image href="data:image\/png;base64,/);
    expect(out.svg).not.toContain('link-seg');
    expect(out.svg).not.toContain('blob:');
    expect(out.md).toContain('- [Example Domain](https://example.com/md)');
    await page.close();
  });
});

