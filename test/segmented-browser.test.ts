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
      await page.getByRole('menuitem', { name: 'Blank board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('button', { name: 'Menu' }).waitFor({ timeout: 25_000 });
      return page;
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

const SCAN = () => [...document.querySelectorAll('.segmented')].map((group) => {
  const g = getComputedStyle(group);
  const buttons = [...group.querySelectorAll('button')].map((b) => {
    const c = getComputedStyle(b);
    return { border: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth].join(' '), radius: c.borderTopLeftRadius, transform: c.textTransform };
  });
  // one marker only: it sits exactly on the selected button (no stub past its edge), and the track has no rule drawn under it
  const marker = group.querySelector('.segmented-marker')?.getBoundingClientRect();
  const on = group.querySelector('button.on')?.getBoundingClientRect();
  const fit = marker && on ? { dx: Math.abs(marker.left - on.left), dw: Math.abs(marker.width - on.width) } : null;
  return { padding: parseFloat(g.paddingTop), radius: parseFloat(g.borderTopLeftRadius), border: g.borderTopWidth, backgroundImage: g.backgroundImage, fit, buttons };
});

describe.skipIf(!available)('every segmented control has one anatomy', { timeout: 200_000 }, () => {
  it('has a container with no border of its own, borderless buttons with one radius, and no upper-casing', async () => {
    const page = await openBoard();
    await page.getByRole('button', { name: 'Stickers' }).click();
    await page.locator('.sticker-sets .segmented').first().waitFor();
    const groups = await page.evaluate(SCAN);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.border).toBe('0px');
      expect(group.backgroundImage).toBe('none');
      expect(group.fit?.dx ?? 0).toBeLessThan(1.5);
      expect(group.fit?.dw ?? 0).toBeLessThan(1.5);
      for (const button of group.buttons) {
        expect(button.border).toBe('0px 0px 0px 0px');
        expect(button.transform).toBe('none');
      }
      expect(new Set(group.buttons.map((button) => button.radius)).size).toBe(1);
      // concentric: the container's radius is the thumb's plus a little, never smaller
      expect(group.radius).toBeGreaterThanOrEqual(parseFloat(group.buttons[0].radius));
    }
  });

  it('keeps the marker exactly on the selected button: unequal widths, a resize, a label change, rtl, fonts', async () => {
    const page = await openBoard();
    // a real control from the sticker panel, made unequal on purpose: the marker must follow the button's own box, not an equal share
    await page.getByRole('button', { name: 'Stickers' }).click();
    await page.locator('.sticker-sets .segmented').first().waitFor();
    await page.evaluate(() => {
      const row = document.querySelector('.sticker-sets .segmented') as HTMLElement;
      row.id = 'seg-host';
      row.parentElement!.id = 'seg-parent';
      row.querySelectorAll('button').forEach((b, i) => { (b as HTMLElement).style.cssText = `flex:0 0 auto;padding-inline:${8 + i * 14}px`; });
    });
    const off = () => page.evaluate(() => {
      const row = document.querySelector('#seg-host')!;
      const m = row.querySelector('.segmented-marker')!.getBoundingClientRect();
      const b = row.querySelector('button.on')!.getBoundingClientRect();
      return { dx: Math.abs(m.left - b.left), dw: Math.abs(m.width - b.width), dy: Math.abs(m.top - b.top), dh: Math.abs(m.height - b.height) };
    });
    const flat = async () => { await page.waitForTimeout(350); return off(); };
    const close = (o: { dx: number; dw: number; dy: number; dh: number }) => { for (const v of Object.values(o)) expect(v).toBeLessThan(1.01); };
    await page.evaluate(() => document.fonts.ready);
    close(await flat());                                              // after fonts, unequal widths
    await page.evaluate(() => { (document.getElementById('seg-parent') as HTMLElement).style.width = '300px'; });
    close(await flat());                                              // after a resize
    await page.evaluate(() => { document.querySelector('#seg-host button.on .seg-label')!.textContent = 'Loading, an even much longer label'; });
    close(await flat());                                              // after a label change
    await page.evaluate(() => { document.querySelectorAll<HTMLButtonElement>('#seg-host button')[2].click(); });
    close(await flat());                                              // after picking another segment
    await page.evaluate(() => { const p = document.getElementById('seg-parent')!; p.dir = 'rtl'; p.style.width = '320px'; }); // direction is set before a page is laid out; the width change stands for that re-layout
    close(await flat());                                              // rtl
    await page.keyboard.press('Shift'); // a key makes the next focus a keyboard focus, so :focus-visible applies
    await page.locator('#seg-host button').first().focus();
    const ring = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#seg-host button')!); return { w: s.outlineWidth, o: s.outlineOffset }; });
    expect(ring.o).toBe('2px');                                       // the ring is the button's box plus 2px: the marker's box
  });
});
