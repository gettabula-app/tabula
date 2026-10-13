import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
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

describe.skipIf(!available)('status pills', { timeout: 120_000 }, () => {
  it('hug an icon and a label with equal padding, a 6px gap and one height, in the admin and elsewhere', async () => {
    const page = await browser!.newPage({ viewport: { width: 900, height: 600 } });
    await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="app"></div>' }));
    await page.goto(`${base}__blank`);
    await page.addScriptTag({
      type: 'module',
      content: `
        import '/src/styles.css'; import '/src/ui/admin.css'; import '/src/ui/backups.css'; import '/src/ui/home.css';
        const { icon } = await import('/src/ui/dom.ts');
        const root = document.getElementById('app');
        root.className = 'admin';
        const make = (cls, text, ic) => {
          const el = document.createElement('span'); el.className = cls; el.dataset.pill = text;
          if (ic) el.appendChild(icon(ic, 12));
          const label = document.createElement('span'); label.textContent = text; el.appendChild(label);
          root.appendChild(el); root.appendChild(document.createElement('br'));
        };
        make('admin-badge backups-badge backups-check-state tag tag-red bad', 'Fail', 'close');
        make('admin-badge backups-badge backups-check-state tag tag-green', 'Pass', 'check');
        make('admin-badge backups-badge backups-check-state tag tag-yellow', 'Unknown', 'timer');
        make('admin-badge tag tag-blue', 'Not applicable');
        make('admin-badge tag tag-yellow', 'Disabled');
        make('badge tag tag-blue', 'Can comment');
        window.__ready = true;
      `,
    });
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 60_000 });
    const pills = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-pill]')].map((pill) => {
      const box = pill.getBoundingClientRect();
      const ico = pill.querySelector('.ico')?.getBoundingClientRect();
      const label = pill.lastElementChild!.getBoundingClientRect();
      const style = getComputedStyle(pill);
      return {
        name: pill.dataset.pill, height: Math.round(box.height), display: style.display,
        left: Math.round(((ico ?? label).left - box.left) * 10) / 10, right: Math.round((box.right - label.right) * 10) / 10,
        gap: ico ? Math.round((label.left - ico.right) * 10) / 10 : null,
        iconSize: ico ? Math.round(ico.width) : null,
        iconCentre: ico ? Math.abs((ico.top + ico.height / 2) - (label.top + label.height / 2)) : null,
      };
    }));
    expect(pills.length).toBe(6);
    for (const pill of pills) {
      expect(pill.display).toBe('inline-flex');
      // the pill hugs its content with equal padding on both sides
      expect(Math.abs(pill.left - pill.right)).toBeLessThanOrEqual(1);
      expect(pill.left).toBeGreaterThanOrEqual(9);
    }
    const withIcon = pills.filter((pill) => pill.gap !== null);
    expect(withIcon.length).toBe(3);
    for (const pill of withIcon) {
      expect(Math.abs((pill.gap ?? 0) - 6)).toBeLessThanOrEqual(1);
      expect(pill.iconSize).toBe(12);
      expect(pill.iconCentre ?? 99).toBeLessThanOrEqual(1.5);
    }
    expect(new Set(pills.map((pill) => pill.height)).size).toBe(1);
    await page.close();
  });
});
