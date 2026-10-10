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

if (want('pollbar')) {
  // a running poll on a small phone: the card sits above the session bar and covers none of its buttons
  for (const [w, h] of [[360, 740], [390, 664], [360, 640]]) await phone(w, h, async (page) => {
    await page.evaluate(() => window.__board.flow.quickPoll({ question: 'Which of these is the best option for the team?', options: ['Option number 1', 'Option number 2', 'Option number 3', 'Option number 4'], multiple: false, anonymous: false }));
    await sleep(1500);
    const r = await page.evaluate(() => { const rect = (sel) => { const e = document.querySelector(sel); if (!e || getComputedStyle(e).display === 'none') return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom) }; }; const bar = document.querySelector('.flowbar.show'); const btns = [...bar.querySelectorAll('button')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => Math.round(x.getBoundingClientRect().top)); return { card: rect('.poll-card:not([hidden])'), bar: rect('.flowbar.show'), buttonTops: btns }; });
    const clear = r.card && r.bar && r.card.b <= r.bar.t + 1;
    record(`poll card does not cover the session bar (${w}x${h})`, !!clear, JSON.stringify(r));
    const top = await page.evaluate(() => { const bar = document.querySelector('.flowbar.show'); const hit = [...bar.querySelectorAll('button')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => { const b = x.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.poll-card') ? x.textContent.trim() || x.getAttribute('aria-label') : null; }).filter(Boolean); return hit; });
    record(`every session bar button is reachable under the poll card (${w}x${h})`, top.length === 0, top.join(', '));
  });
}

if (want('selvote')) {
  // iPad portrait: a tall selection, then a dot vote: the quick bar must not sit over the session bar
  const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
  const page = await ctx.newPage();
  await page.goto(`${base}/?debug#/b/qselvote`);
  await page.waitForFunction(() => window.__board);
  await sleep(800);
  await page.evaluate(() => {
    const b = window.__board;
    // one note near the top of the board and one low down: the selection is tall, so the bar has no room above it
    for (let i = 0; i < 2; i++) b.store.transact(() => b.store.create({ id: `v${i}`, type: 'sticky', x: 200 + i * 140, y: i === 0 ? 100 : 760, w: 120, h: 120, rotation: 0, z: `a${i}`, text: `v${i}`, color: 'yellow' }));
    b.zoomTo(1);
    b.r.flyToCenter({ x: 330, y: 480 }, 1);
    b.setSelection(['v0', 'v1']);
    b.flow.quickVote(Infinity);
  });
  await sleep(1500);
  const r = await page.evaluate(() => { const q = document.querySelector('.quickbar.show')?.getBoundingClientRect(); const f = document.querySelector('.flowbar.show')?.getBoundingClientRect(); const box = (x) => x && { l: Math.round(x.left), t: Math.round(x.top), r: Math.round(x.right), b: Math.round(x.bottom) }; return { q: box(q), f: box(f), vh: innerHeight }; });
  const hit = r.q && r.f && r.q.l < r.f.r && r.q.r > r.f.l && r.q.t < r.f.b && r.q.b > r.f.t;
  record('iPad portrait: the quick bar does not cover the vote bar', !!r.q && !!r.f && !hit, JSON.stringify(r));
  await ctx.close();
}

if (want('toast')) {
  // the "Dot vote started" and "Poll started" toasts appear while the session bar opens: they must sit above it, never over its buttons
  for (const [w, h] of [[1280, 800], [1024, 700]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(`${base}/?debug#/b/qtoast${w}`);
    await page.waitForFunction(() => window.__board);
    await sleep(800);
    await page.getByRole('button', { name: 'Start a dot vote' }).click();
    await page.getByRole('button', { name: 'Start on everything' }).evaluate((e) => e.click());
    await sleep(350);
    const r = await page.evaluate(() => { const t = document.querySelector('.toast.show')?.getBoundingClientRect(); const f = document.querySelector('.flowbar.show')?.getBoundingClientRect(); const box = (x) => x && { l: Math.round(x.left), t: Math.round(x.top), r: Math.round(x.right), b: Math.round(x.bottom) }; return { toast: box(t), bar: box(f) }; });
    const hit = r.toast && r.bar && r.toast.l < r.bar.r && r.toast.r > r.bar.l && r.toast.t < r.bar.b && r.toast.b > r.bar.t;
    record(`the dot-vote toast does not sit over the session bar (${w}x${h})`, !!r.toast && !!r.bar && !hit, JSON.stringify(r));
    // a quick poll: the toast must not hide the foot of the poll card either
    await page.getByRole('button', { name: 'Finish' }).first().click().catch(() => {});
    await sleep(300);
    await page.getByRole('button', { name: /quick poll/i }).first().click();
    const pop = page.locator('.poll-pop');
    const inputs = pop.locator('input[type=text], input:not([type]), textarea');
    await inputs.nth(0).fill('Q?');
    await inputs.nth(1).fill('Ja');
    await inputs.nth(2).fill('Nej');
    await pop.getByRole('button', { name: /start poll/i }).click();
    await sleep(500);
    const pr = await page.evaluate(() => { const t = document.querySelector('.toast.show')?.getBoundingClientRect(); const c = document.querySelector('.poll-card:not([hidden])')?.getBoundingClientRect(); const f = document.querySelector('.flowbar.show')?.getBoundingClientRect(); const box = (x) => x && { t: Math.round(x.top), b: Math.round(x.bottom), l: Math.round(x.left), r: Math.round(x.right) }; return { toast: box(t), card: box(c), bar: box(f) }; });
    const over = (a2, b2) => a2 && b2 && a2.l < b2.r && a2.r > b2.l && a2.t < b2.b && a2.b > b2.t;
    record(`the poll toast covers neither the poll card nor the session bar (${w}x${h})`, !!pr.toast && !!pr.card && !over(pr.toast, pr.card) && !over(pr.toast, pr.bar), JSON.stringify(pr));
    await ctx.close();
  }
}

if (want('votebar')) {
  // the compact phone vote bar is one row down to 320 px wide, for a quick vote and for a vote that is a session step
  for (const w of [390, 360, 320]) for (const kind of ['quick', 'steps']) await phone(w, 640, async (page) => {
    await page.evaluate((k) => {
      const f = window.__board.flow;
      if (k === 'steps') { f.setSteps([{ id: 'a', title: 'Vote', instructions: 'x', mode: 'vote' }, { id: 'b', title: 'Discuss', instructions: '', mode: 'discuss' }]); f.goto(0); } else f.quickVote(Infinity);
    }, kind);
    await sleep(900);
    const r = await page.evaluate(() => { const bar = document.querySelector('.flowbar.vote-compact'); if (!bar) return null; const b = bar.getBoundingClientRect(); const kids = [...bar.children].filter((e) => getComputedStyle(e).display !== 'none' && !e.hidden).map((e) => e.getBoundingClientRect()); return { rows: new Set(kids.map((k) => Math.round(k.top / 4))).size, out: kids.filter((k) => k.right > b.right + 0.5).length, minSide: Math.round(Math.min(...kids.map((k) => Math.min(k.width, k.height)))) }; });
    record(`vote bar is one row, nothing outside it, 44 px targets (${kind}, ${w} px)`, !!r && r.rows === 1 && r.out === 0 && r.minSide >= 44, JSON.stringify(r));
  });
}

if (want('tipregion')) {
  // the tooltip portal sits under <body>, outside every landmark: it is hidden from the reading order and still described by aria-describedby
  //   node scripts/qa-touch-fixes.mjs --only tipregion [--axe path/to/axe.min.js]   (axe is optional; it is not a dependency)
  const axeArg = process.argv.indexOf('--axe');
  const axeSrc = axeArg > 0 ? fs.readFileSync(process.argv[axeArg + 1], 'utf8') : null;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: Boolean(axeSrc) });
  const page = await ctx.newPage();
  await page.goto(`${base}/?debug#/b/qtip`);
  await page.waitForFunction(() => window.__board);
  await sleep(800);
  await page.getByRole('button', { name: 'Hand', exact: true }).hover();
  await sleep(1200);
  const facts = await page.evaluate(() => { const tip = document.querySelector('[role=tooltip]'); const target = document.querySelector('[aria-describedby]'); return { hidden: tip?.getAttribute('aria-hidden'), described: !!target && (target.getAttribute('aria-describedby') || '').includes(tip?.id ?? '#'), visible: !!tip && getComputedStyle(tip).visibility !== 'hidden' && tip.getBoundingClientRect().width > 0 }; });
  record('tooltip is aria-hidden and still the description of its target while it shows', facts.hidden === 'true' && facts.described, JSON.stringify(facts));
  if (axeSrc) {
    await page.addScriptTag({ content: axeSrc });
    const bad = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ['region'] } }); return r.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' '))).filter((t) => /tip/.test(t)); });
    record('axe region: the tooltip is not reported outside a landmark', bad.length === 0, bad.join(' | '));
  }
  await ctx.close();
}

await browser.close();
relay.kill();
await sleep(500);
fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
