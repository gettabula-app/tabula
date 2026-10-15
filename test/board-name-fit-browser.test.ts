import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// TAB-404: the board title in the top-left pill is as wide as its text, between a min and a max (past the max it is clipped with an
// ellipsis), focus never changes its box, and at 390 px the pill, the sync status and the right tray stay apart. Real Chromium, a local board.

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

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const LONG = 'Quarterly planning notes '.repeat(8).trimEnd() + '.'; // 200 characters, no trailing space (the name is trimmed on save)
const SPRINT = 'Sprint planning board';

async function openBoard(viewport: { width: number; height: number }, phone = false): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({ viewport, isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    try {
      await page.goto(base);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('menuitem', { name: 'Blank board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.locator('.board-name').waitFor({ timeout: 25_000 });
      await page.evaluate(() => document.fonts.ready);
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

/** Two frames: the field has re-measured and the browser has laid the pill out. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** A rename the way a person makes it: select the text, type, press Enter. Waits until the field holds the new name. */
async function rename(page: Page, text: string) {
  const name = page.locator('.board-name');
  await name.fill(text);
  await name.press('Enter');
  await page.waitForFunction((t) => document.querySelector<HTMLInputElement>('.board-name')?.value === t, text, { timeout: 25_000 });
  await frames(page);
}

/** Boxes of the name, its pill, the sync status and the right tray, with the name's computed max width, padding and text-overflow. */
function measure(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (!r) throw new Error(`no ${sel}`);
      return { left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const cs = getComputedStyle(document.querySelector('.board-name')!);
    return {
      name: box('.board-name'), pill: box('.top-left'), dot: box('.top-left .sync-status'), tray: box('.top-right'),
      maxWidth: parseFloat(cs.maxWidth), pad: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), overflow: cs.textOverflow,
    };
  });
}

/** The width the text needs in the input's own font, from a span this code does not touch. */
function textWidth(page: Page, text: string) {
  return page.evaluate((t) => {
    const cs = getComputedStyle(document.querySelector('.board-name')!);
    const span = document.createElement('span');
    span.textContent = t;
    Object.assign(span.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, letterSpacing: cs.letterSpacing });
    document.body.append(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width;
  }, text);
}

const size = (m: { name: { width: number; height: number } }) => ({ width: m.name.width, height: m.name.height });

describe.skipIf(!available)('the board title fits its text (TAB-404)', { timeout: 240_000 }, () => {
  it('is narrow for a short name and wider for a long one, and the pill follows as you type', async () => {
    const page = await openBoard(DESKTOP);
    await rename(page, 'Hi');
    const short = await measure(page);
    await rename(page, 'A much longer board title here');
    const long = await measure(page);
    expect(long.name.width).toBeGreaterThan(short.name.width);

    await rename(page, 'Hi');
    await page.locator('.board-name').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' a much longer board title here');
    await frames(page);
    const typed = await measure(page);
    expect(typed.name.width).toBeGreaterThan(short.name.width + 50);
    expect(Math.abs((typed.pill.width - short.pill.width) - (typed.name.width - short.name.width))).toBeLessThanOrEqual(2);

    await rename(page, 'Hi');
    const shrunk = await measure(page);
    expect(Math.abs(shrunk.name.width - short.name.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(shrunk.pill.width - short.pill.width)).toBeLessThanOrEqual(1);
    await page.context().close();
  });

  it('clamps a 200-character name to its max width and clips it with an ellipsis', async () => {
    expect(LONG).toHaveLength(200);
    const page = await openBoard(DESKTOP);
    await rename(page, LONG);
    const m = await measure(page);
    expect(m.name.width).toBeLessThanOrEqual(m.maxWidth + 1);
    expect(m.name.width).toBeGreaterThanOrEqual(m.maxWidth - 1); // the text is far longer, so it reaches the max
    expect(m.overflow).toBe('ellipsis');
    expect(await textWidth(page, LONG) + m.pad).toBeGreaterThan(m.name.width); // the text does not fit, so it is clipped
    await page.context().close();
  });

  it('does not change the name box on focus, while typing, or on blur', async () => {
    const page = await openBoard(DESKTOP);
    await rename(page, SPRINT);
    const before = size(await measure(page));
    await page.locator('.board-name').focus();
    await frames(page);
    expect(size(await measure(page))).toEqual(before);
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('Backspace');
    await frames(page);
    expect(size(await measure(page))).toEqual(before);
    await page.keyboard.press('Enter'); // blurs and saves the same name
    await frames(page);
    expect(size(await measure(page))).toEqual(before);
    await page.context().close();
  });

  it('at 390 px, a short name leaves the pill narrower than the row, and a 200-character name stays clear of the right tray', async () => {
    const page = await openBoard(PHONE, true);
    await rename(page, 'Hi');
    const short = await measure(page);
    expect(short.pill.width).toBeLessThan(PHONE.width - 24);
    await rename(page, LONG);
    const m = await measure(page);
    expect(m.pill.right).toBeLessThanOrEqual(m.tray.left + 0.5);
    const gap = m.dot.left - m.name.right;
    expect(gap).toBeGreaterThanOrEqual(-2);
    expect(gap).toBeLessThanOrEqual(8);
    await page.context().close();
  });

  it('in all five themes, at 1280 and at 390, keeps the sync status within 8 px of the name and the name as wide as its text', async () => {
    const rows: Array<{ theme: string; at: string; gap: number; extra: number; name: number; pill: number }> = [];
    for (const [label, viewport, phone] of [['1280', DESKTOP, false], ['390', PHONE, true]] as const) {
      const page = await openBoard(viewport, phone);
      const ids = await page.evaluate<string[]>(`(async () => { const m = await import('/src/themes.ts'); return m.THEMES.map((t) => t.id); })()`);
      expect(ids).toHaveLength(5);
      for (const [i, id] of ids.entries()) {
        await page.evaluate(`(async () => { const m = await import('/src/themes.ts'); m.setTheme(${JSON.stringify(id)}); })()`);
        // At 390 the pill is only as wide as the room left of the right tray (src/ui/board.ts positionPhoneTray), so the phone name is short.
        const text = `${phone ? 'Sprint' : SPRINT} ${i + 1}`;
        await rename(page, text);
        const m = await measure(page);
        const gap = m.dot.left - m.name.right;
        const extra = m.name.width - (await textWidth(page, text) + m.pad);
        rows.push({ theme: id, at: label, gap, extra, name: m.name.width, pill: m.pill.width });
      }
      await page.context().close();
    }
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => r.gap < -2 || r.gap > 8 || r.extra < 0 || r.extra > 4)).toEqual([]);
  });
});
