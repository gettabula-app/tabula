import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

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
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openBoard(height = 900): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport: { width: 1280, height } });
    const page = await context.newPage();
    try {
      await page.goto(base);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('button', { name: 'Menu' }).waitFor({ timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

type Drawn = { tag: string; onRoot: boolean; outline: string; width: string; color: string; shadow: string; cls: string };

// The elements under `root` (root included) that draw a focus ring: an outline that shows, or the 3px spread ring a field uses.
async function ringsUnder(page: Page, root: string): Promise<Drawn[]> {
  return page.evaluate((selector) => {
    const top = document.querySelector(selector);
    if (!top) throw new Error(`no element matches ${selector}`);
    return [top, ...Array.from(top.querySelectorAll('*'))].flatMap((el) => {
      const s = getComputedStyle(el);
      const outlined = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      const spread = s.boxShadow.includes('0px 0px 0px 3px');
      if (!outlined && !spread) return [];
      return [{ tag: el.tagName.toLowerCase(), onRoot: el === top, outline: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, shadow: s.boxShadow, cls: el.getAttribute('class') ?? '' }];
    });
  }, root);
}

// A wrapped field (a leading icon and an inner input inside one wrapper): focus the input and read which elements draw the ring.
// Each ring is [tag, is it the wrapper itself]; the input's own outline and box-shadow are read as they are.
async function readWrappedField(page: Page, wrapper: string, input: string) {
  await page.locator(input).focus();
  const drawn = await ringsUnder(page, wrapper);
  const styleOf = (sel: string) => page.locator(sel).evaluate((el) => {
    const s = getComputedStyle(el);
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, boxShadow: s.boxShadow, borderColor: s.borderTopColor, borderWidth: s.borderTopWidth };
  });
  const field = await styleOf(input);
  const wrapperStyle = await styleOf(wrapper);
  return {
    rings: drawn.map((d) => [d.tag, d.onRoot]),
    outline: drawn[0]?.outline ?? 'none',
    field: { outlineStyle: field.outlineStyle, boxShadow: field.boxShadow },
    // the full computed values, so a failure shows exactly what the browser drew
    detail: { input: field, wrapper: wrapperStyle, rings: drawn },
  };
}

// Focuses every visible field in the DOM in turn and reports each field whose group (its label, its wrapper, or its parent) draws more than one ring.
async function scanFields(page: Page): Promise<{ scanned: number; doubled: string[] }> {
  return page.evaluate(() => {
    const name = (el: Element) => `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.id}].${el.getAttribute('class') ?? ''}`;
    const ringsIn = (root: Element) => [root, ...Array.from(root.querySelectorAll('*'))].filter((el) => {
      const s = getComputedStyle(el);
      return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow.includes('0px 0px 0px 3px');
    });
    let scanned = 0;
    const doubled: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea, .combo'))) {
      if (el.getClientRects().length === 0 || el.matches(':disabled')) continue;
      el.focus();
      if (document.activeElement !== el) continue;
      scanned++;
      const scope: Element = el.closest('label, .board-menu-search, .template-picker-search') ?? el.parentElement ?? el;
      const drawn = ringsIn(scope);
      if (drawn.length > 1) doubled.push(`${name(el)} -> ${drawn.map(name).join(', ')}`);
    }
    return { scanned, doubled };
  });
}

describe.skipIf(!available)('the focus ring on search fields', { timeout: 200_000 }, () => {
  it('the board menu search draws one ring on its wrapper and none on the input', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('.board-menu').waitFor();
    const look = await readWrappedField(page, '.board-menu-search', '.board-menu-search-input');
    // exactly one ring, and it is the wrapper's own
    expect(look.rings).toEqual([['label', true]]);
    expect(look.field).toEqual({ outlineStyle: 'none', boxShadow: 'none' });
  });

  it('the template picker search draws one ring on its wrapper and none on the input', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await page.locator('.template-picker').waitFor();
    const look = await readWrappedField(page, '.template-picker-search', '.template-picker-search-input');
    // exactly one ring, and it is the wrapper's own
    expect(look.rings).toEqual([['label', true]]);
    expect(look.field).toEqual({ outlineStyle: 'none', boxShadow: 'none' });
  });

  it('the emoji picker search draws its one ring on the input itself', async () => {
    const page = await openBoard(560);
    await page.keyboard.press('n');
    await page.mouse.click(640, 280);
    await page.getByRole('button', { name: 'Add emoji' }).click();
    await page.locator('.emoji-pop').waitFor();
    await page.getByLabel('Search emoji').focus();
    const drawn = await ringsUnder(page, '.emoji-pop');
    expect(drawn.map((d) => [d.tag, d.cls.includes('emoji-search')])).toEqual([['input', true]]);
  });

  it('no field in the DOM draws two rings when focused, with the board menu open', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('.board-menu').waitFor();
    const { scanned, doubled } = await scanFields(page);
    expect(scanned).toBeGreaterThan(0);
    expect(doubled).toEqual([]);
  });

  it('no field in the DOM draws two rings when focused, with the template picker open', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await page.locator('.template-picker').waitFor();
    const { scanned, doubled } = await scanFields(page);
    expect(scanned).toBeGreaterThan(0);
    expect(doubled).toEqual([]);
  });

  it('in forced colours the template picker search still draws one ring on its wrapper and none on the input', async () => {
    const page = await openBoard();
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await page.locator('.template-picker').waitFor();
    const look = await readWrappedField(page, '.template-picker-search', '.template-picker-search-input');
    // one outline on the wrapper, no ring on the input; the failure prints every computed value
    // toEqual prints every computed value of the input on failure (outline width and colour included)
    expect(look.detail.input).toMatchObject({ outlineStyle: 'none', boxShadow: 'none' });
    expect(look.rings).toEqual([['label', true]]);
    expect(look.outline).not.toBe('none');
  });
});
