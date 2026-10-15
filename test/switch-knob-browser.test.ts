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


// the knob's inset from the pill is the same on all four sides, off and on (the 28x16 pill, a 10px knob that moves 12px)
const MEASURE = () => {
  const out: Record<string, { top: number; bottom: number; left: number; right: number }> = {};
  const read = (el: HTMLElement, name: string) => {
    const k = getComputedStyle(el, '::before');
    const m = /matrix\(([^)]+)\)/.exec(k.transform);
    const tx = m ? parseFloat(m[1].split(',')[4]) : 0;
    const a = getComputedStyle(el, '::after');
    const isInput = el.tagName === 'INPUT';
    const pillTop = isInput ? 0 : parseFloat(a.top);
    const pillH = isInput ? el.clientHeight : el.clientHeight - parseFloat(a.top) - parseFloat(a.bottom);
    const pillW = isInput ? el.clientWidth : el.clientWidth - parseFloat(a.left) - parseFloat(a.right);
    const pillLeft = isInput ? 0 : parseFloat(a.left);
    const kt = parseFloat(k.top), kl = parseFloat(k.left) + tx, kw = parseFloat(k.width), kh = parseFloat(k.height);
    out[name] = { top: kt - pillTop, bottom: pillTop + pillH - (kt + kh), left: kl - pillLeft, right: pillLeft + pillW - (kl + kw) };
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:10px;top:10px;z-index:99999';
  const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch');
  const button = document.createElement('button'); button.setAttribute('role', 'switch'); button.setAttribute('aria-checked', 'false');
  const still = document.createElement('style'); still.textContent = '*,*::before,*::after{transition:none !important}'; // read the end state, not a slide in progress
  host.append(input, button, still); document.body.appendChild(host);
  read(input, 'input off'); read(button, 'button off');
  input.checked = true; button.setAttribute('aria-checked', 'true');
  read(input, 'input on'); read(button, 'button on');
  host.remove();
  return out;
};

describe.skipIf(!available)('switch knob', { timeout: 200_000 }, () => {
  it('sits centred in its pill with an equal inset on all four sides, off and on', async () => {
    const page = await openBoard();
    for (const theme of ['default', 'ayu', 'kanagawa', 'matrix', 'evergreen']) {
      await page.evaluate((id) => document.documentElement.setAttribute('data-theme', id), theme);
      const result = await page.evaluate(MEASURE);
      for (const [name, r] of Object.entries(result)) {
        const on = name.endsWith(' on');
        const travel = 12; // the knob moves 12px: the side it left is 12px wider, the side it reached equals the top and bottom
        expect(Math.abs(r.bottom - r.top), `${theme} ${name} top/bottom`).toBeLessThan(0.51);
        expect(Math.abs((on ? r.right : r.left) - r.top), `${theme} ${name} resting side`).toBeLessThan(0.51);
        expect(Math.abs((on ? r.left : r.right) - r.top - travel), `${theme} ${name} far side`).toBeLessThan(0.51);
      }
    }
  });
});
