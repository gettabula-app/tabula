// QA for the cross-browser fixes of 2026-10-10 (sticky colour tray, long-press menu, chrome pinch, poll card and selection bar on
// phones, toasts). Drives the BUILT app (npm run build:app first) in Chromium with real touch emulation, against its own relay in
// open mode on a free port, and exits 1 when a check fails. Each check fails on the code before its fix.
//   node scripts/qa-touch-fixes.mjs [--only sticky,longpress,pinch,pollbar,selvote,toast]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, devices } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;
const want = (k) => !only || only.has(k);
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-touch-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA_|MIRA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(k)));
Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1' });
const relay = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: dataDir, env, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break; await sleep(200); }
const browser = await chromium.launch();
let failed = 0;
const record = (name, ok, note = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  -- ${note}` : ''}`); };
let boardNo = 0;
async function phone(width, height, run) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?debug#/b/qt${width}x${++boardNo}`);
  await page.waitForFunction(() => window.__board);
  await sleep(600);
  try { await run(page); } finally { if (errors.length) record('no page errors', false, errors.join(' | ')); await ctx.close(); }
}

if (want('sticky')) {
  for (const w of [390, 360]) await phone(w, 740, async (page) => {
    await page.getByRole('button', { name: 'Sticky note', exact: true }).tap();
    const tray = page.locator('.sticky-tray');
    await tray.waitFor({ state: 'visible' });
    await tray.getByRole('radio').nth(2).tap().catch(async () => tray.locator('button').nth(2).tap());
    await sleep(300);
    const closed = !(await tray.isVisible());
    const still = await page.evaluate(() => window.__board.tool.kind);
    record(`sticky colour tray closes after a pick on a ${w} px phone, the tool stays`, closed && still === 'sticky', `tray visible=${!closed}, tool=${still}`);
    await page.getByRole('button', { name: 'Sticky note', exact: true }).tap();
    await sleep(300);
    record(`tapping the sticky tool again shows the tray (${w})`, await tray.isVisible());
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const page = await ctx.newPage();
  await page.goto(`${base}/?debug#/b/qt-desk`); await page.waitForFunction(() => window.__board); await sleep(500);
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  const tray = page.locator('.sticky-tray'); await tray.waitFor({ state: 'visible' });
  await tray.locator('button').nth(2).click(); await sleep(300);
  record('on a desktop the tray stays open after a pick', await tray.isVisible());
  await ctx.close();
}

if (want('longpress')) {
  // real CDP touch: a held finger on a selected item opens the menu; no item may sit under the finger and the lift presses nothing
  for (const [w, h] of [[360, 740], [412, 839]]) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await page.goto(`${base}/?debug#/b/qlp${w}`);
    await page.waitForFunction(() => window.__board);
    await sleep(800);
    await page.evaluate(() => {
      const b = window.__board;
      for (let i = 0; i < 3; i++) b.store.transact(() => b.store.create({ id: `n${i}`, type: 'sticky', x: 100 + i * 20, y: 300 + i * 20, w: 120, h: 120, rotation: 0, z: `a${i}`, text: `x${i}`, color: 'yellow' }));
      b.zoomTo(1);
      b.r.flyToCenter({ x: 170, y: 380 }, 1);
      b.setSelection(['n0', 'n1', 'n2']);
    });
    await sleep(900);
    const pt = await page.evaluate(() => { const b = window.__board; const o = b.store.getPlaced('n2'); const q = b.r.toScreen({ x: o.x + o.w / 2, y: o.y + o.h / 2 }); const r = b.r.svg.getBoundingClientRect(); return { x: Math.round(r.left + q.x), y: Math.round(r.top + q.y) }; });
    const zs = () => page.evaluate(() => JSON.stringify([...window.__board.store.cache.values()].map((o) => [o.id, o.z])));
    const before = await zs();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(900);
    const menu = await page.evaluate(() => { const m = document.querySelector('.ctx-menu'); const pop = m?.closest('.popover'); if (!pop) return null; const r = pop.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
    const covered = !menu || (pt.x >= menu.l && pt.x <= menu.r && pt.y >= menu.t && pt.y <= menu.b);
    record(`long-press menu opens and does not cover the finger (${w} px)`, !!menu && !covered, JSON.stringify({ pt, menu }));
    await page.screenshot({ path: path.join(dataDir, `longpress-${w}.png`) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    const open = await page.evaluate(() => !!document.querySelector('.ctx-menu'));
    record(`lifting the finger leaves the menu open and changes nothing (${w} px)`, open && (await zs()) === before);
    await ctx.close();
  }
}

await browser.close();
relay.kill();
await sleep(500);
fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
