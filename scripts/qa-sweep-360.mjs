// 360 px sweep of the board UI that has no `npm run visual` state of its own (TAB-239 to TAB-246): the session bar in each step mode
// (write, timer, vote, private writing, poll), the steps list, the top menu, the share and shortcuts dialogs, the quick-action bar
// with one and several items, and the shapes, icons, templates and comments drawers, in the default and Matrix themes. After each
// state it lists every visible element that sits past the screen edge or has its content cut off, and takes a screenshot.
//
//   node scripts/qa-sweep-360.mjs <out-folder>     (needs `npm run build:app` and `npx playwright install chromium` once)
//
// It starts its own relay in open mode on a free port with a throwaway data folder, and stops it. The lines `theme state: ok` or
// the list are printed, and findings.txt in the folder repeats them. Nothing here is part of `npm test` or CI.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
const freePort = () => new Promise((r, j) => { const s = net.createServer(); s.once('error', j); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const dataDir = fs.mkdtempSync(path.join(WORK, 'data-')); const port = await freePort();
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA_|MIRA_|ANTHROPIC_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(k)));
Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1' });
const relay = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: dataDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })).ok) break; } catch { /* wait */ } await sleep(100); }
const browser = await chromium.launch({ headless: true, env: { PATH: process.env.PATH, HOME: WORK, TMPDIR: WORK } });
const NOTES = [['n1', 'Fast feedback', -300, -150, '#FFE16B'], ['n2', 'Tests early', -100, -150, '#BCE88C'], ['n3', 'Pairing helped', 100, -150, '#8FE3CA'], ['n4', 'Too many meetings', -200, 60, '#FFA3C4']];
const found = [];
const DETECT = () => {
  const W = window.innerWidth, out = [];
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const label = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('svg') || e.closest('.canvas, #canvas, [data-canvas]')) continue;
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.right > W + 1 || r.left < -1) out.push(`off-screen ${Math.round(r.left)}..${Math.round(r.right)} ${label(e)}`);
    const cs = getComputedStyle(e);
    if (e.scrollWidth > e.clientWidth + 2 && /hidden|clip/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis' && e.clientWidth > 20 && !e.matches('input,textarea,select')) out.push(`clipped ${e.scrollWidth}>${e.clientWidth} ${label(e)}`);
  }
  if (document.documentElement.scrollWidth > W + 1) out.push(`page scrolls sideways ${document.documentElement.scrollWidth}>${W}`);
  return [...new Set(out)].slice(0, 25);
};
async function newPage(theme) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await ctx.addInitScript(({ theme }) => { localStorage.setItem('driftboard:theme', theme); localStorage.setItem('driftboard:user', JSON.stringify({ id: 'ana', name: 'Ana', color: '#2F6FED' })); localStorage.setItem('driftboard:fontshare-catalogue', JSON.stringify({ at: Date.now(), fonts: [] })); }, { theme });
  await ctx.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); if (u.hostname.endsWith('fontshare.com')) return route.fulfill({ status: 200, contentType: u.pathname.endsWith('fonts') ? 'application/json' : 'text/css', body: u.pathname.endsWith('fonts') ? '{"fonts":[]}' : '' }); return route.abort(); });
  return { ctx, page: await ctx.newPage() };
}
async function board(theme, id) {
  const { ctx, page } = await newPage(theme);
  await page.goto(`http://127.0.0.1:${port}/?debug#/b/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__board?.conn?.provider ? window.__board.conn.provider.synced : !!window.__board, null, { timeout: 20000 });
  await page.evaluate((notes) => { const app = window.__board, s = app.store, font = s.getMeta().bodyFont, zs = s.topZs(notes.length); s.transact(() => { s.setMeta({ name: 'Sweep board' }); notes.forEach(([id, text, x, y, fill], i) => s.create({ id, type: 'sticky', x, y, w: 192, h: 192, rotation: 0, z: zs[i], createdBy: 'ana', updatedAt: Date.now(), font, fontSize: 18, fill, text })); }); app.setSelection([]); app.zoomToFit(); }, NOTES);
  await sleep(500);
  return { ctx, page };
}
async function state(theme, name, page, fn) {
  try { await fn(); await sleep(450); } catch (e) { found.push(`${theme} ${name}: could not drive (${String(e).split('\n')[0].slice(0, 90)})`); }
  const issues = await page.evaluate(DETECT);
  await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
  console.log(`${theme} ${name}: ${issues.length ? issues.join(' || ') : 'ok'}`);
  if (issues.length) found.push(`${theme} ${name}: ${issues.join(' || ')}`);
  await page.keyboard.press('Escape').catch(() => {}); await sleep(150);
}
for (const theme of ['default', 'matrix']) {
  const { ctx, page } = await board(theme, `sweep-${theme}`);
  await state(theme, 'top-menu', page, () => page.getByRole('button', { name: 'Menu', exact: true }).click());
  await state(theme, 'share', page, () => page.getByRole('button', { name: 'Share', exact: true }).click());
  await page.keyboard.press('Escape');
  await state(theme, 'shortcuts', page, async () => { await page.mouse.click(250, 400); await page.keyboard.press('Shift+?'); });
  await state(theme, 'flow-steps-ready', page, () => page.evaluate(() => window.__board.flow.setSteps([{ id: 'a', title: 'Brainstorm on sticky notes', instructions: 'Write as many ideas as you can.', mode: 'write', durationSec: 300 }, { id: 'b', title: 'Vote on the best ideas', instructions: 'Place your dots.', mode: 'vote', votesPerPerson: 3 }, { id: 'c', title: 'Private writing', instructions: 'Write alone.', mode: 'private-write' }])));
  await state(theme, 'flow-running-step', page, () => page.evaluate(() => window.__board.flow.start()));
  await state(theme, 'flow-timer', page, () => page.evaluate(() => window.__board.flow.startTimer(300)));
  await state(theme, 'flow-steps-list', page, () => page.locator('.flow-step').first().click());
  await page.keyboard.press('Escape');
  await state(theme, 'flow-vote-step', page, () => page.evaluate(() => window.__board.flow.next()));
  await state(theme, 'flow-vote-dots-menu', page, () => page.getByRole('button', { name: /dots|limit|No limit|left/i }).first().click());
  await page.keyboard.press('Escape');
  await state(theme, 'flow-private-step', page, () => page.evaluate(() => window.__board.flow.next()));
  await state(theme, 'flow-end', page, () => page.evaluate(() => window.__board.flow.end()));
  await ctx.close();
  // quick poll
  const p2 = await board(theme, `sweep-poll-${theme}`);
  await state(theme, 'poll-running', p2.page, () => p2.page.evaluate(() => window.__board.flow.quickPoll({ question: 'Which day should we ship the next release on?', options: ['Monday morning', 'Wednesday afternoon', 'Friday, after lunch'], multiple: false, anonymous: false })));
  await state(theme, 'poll-reveal', p2.page, () => p2.page.evaluate(() => window.__board.flow.reveal()));
  await p2.ctx.close();
  // popovers and panels on a selection
  const p3 = await board(theme, `sweep-pop-${theme}`);
  await state(theme, 'selection-bar', p3.page, () => p3.page.evaluate(() => window.__board.setSelection(['n1'])));
  await state(theme, 'selection-multi', p3.page, () => p3.page.evaluate(() => window.__board.setSelection(['n1', 'n2', 'n3'])));
  await state(theme, 'text-options', p3.page, () => p3.page.getByRole('button', { name: /Text options|text/i }).first().click());
  await p3.page.keyboard.press('Escape');
  await state(theme, 'rail-shapes', p3.page, () => p3.page.getByRole('button', { name: /Shapes/i }).first().click());
  await state(theme, 'rail-icons', p3.page, () => p3.page.getByRole('button', { name: /Icons/i }).first().click());
  await state(theme, 'rail-templates', p3.page, () => p3.page.getByRole('button', { name: /Templates/i }).first().click());
  await state(theme, 'rail-comments', p3.page, () => p3.page.getByRole('button', { name: 'Comments', exact: true }).click());
  await state(theme, 'ai-bar', p3.page, async () => { await p3.page.goto(`http://127.0.0.1:${port}/?debug#/b/sweep-pop-${theme}`); await sleep(800); });
  await p3.ctx.close();
}
await browser.close(); relay.kill('SIGTERM'); await sleep(400); fs.rmSync(WORK, { recursive: true, force: true });
fs.writeFileSync(`${OUT}/findings.txt`, found.join('\n'));
console.log(`\nFINDINGS ${found.length}`);
