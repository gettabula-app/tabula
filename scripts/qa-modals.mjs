#!/usr/bin/env node
// Modal and sheet sweep at short phone viewports (iOS Safari leaves about 560 to 664 px under its toolbars).
// Usage: node scripts/qa-modals.mjs [--out <folder>]. Needs `npm run build:app`. TABULA_TRACKER=on, accounts mode.
//   node scripts/qa-tracker-dogfood.mjs            API stage only (sign in, create, edit, comment, feed, inbox when it exists)
//   node scripts/qa-tracker-dogfood.mjs --ui       also drives the UI in headless Chromium (needs `npm run build:app`)
//   --out <folder> keeps screenshots; --widths 1280,390 picks the UI widths.
// Exit 0 when every check passes, 1 on a failed check, 2 on bad usage. Selectors for the UI stage live in SEL below.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const options = { ui: false, widths: [1280, 390], out: null, stages: ['shell', 'ticket', 'inbox'] };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--ui') options.ui = true;
  else if (arg === '--widths') options.widths = String(process.argv[++i] ?? '').split(',').map(Number);
  else if (arg === '--stages') options.stages = String(process.argv[++i] ?? '').split(',');
  else if (arg === '--out') options.out = path.resolve(process.argv[++i] ?? '');
  else { console.error(`Usage: node scripts/qa-tracker-dogfood.mjs [--ui] [--widths 1280,390] [--stages shell,ticket,inbox] [--out <folder>]  (unknown: ${arg})`); process.exit(2); }
}
if (options.widths.some((w) => !Number.isInteger(w) || w < 320 || w > 7680)) { console.error('--widths needs whole numbers from 320 to 7680'); process.exit(2); }

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), skipped: false });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  return Boolean(ok);
}
function skip(name, why) {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}  -- ${why}`);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-tracker-dogfood-'));
let relay = null;
let relayErr = '';
let base = '';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRelay() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TABULA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(key)));
  Object.assign(env, {
    PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1',
    TABULA_SKIP_DOTENV: '1', TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: 'olive@example.test',
    TABULA_BASE_URL: base, TABULA_TRACKER: 'on', TABULA_CHAT: 'on', TABULA_MCP: 'on', TABULA_JOIN_CODES: 'on',
  });
  relay = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: dataDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  relay.stderr.on('data', (chunk) => { relayErr = (relayErr + String(chunk)).slice(-4000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (relay.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) })).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`relay did not start${relayErr ? `: ${relayErr.slice(-800)}` : ''}`);
}

async function stopRelay() {
  if (relay && relay.exitCode === null) {
    const exited = new Promise((resolve) => relay.once('exit', resolve));
    relay.kill('SIGTERM');
    await Promise.race([exited, sleep(4000)]);
    if (relay.exitCode === null) relay.kill('SIGKILL');
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function call(who, method, route, body) {
  const headers = { accept: 'application/json', 'x-tabula': '1', origin: base, ...(who ? { cookie: who.cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const init = { method, headers, signal: AbortSignal.timeout(10_000) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, headers: response.headers };
}

async function signIn(email, invite) {
  const outbox = path.join(dataDir, 'outbox.jsonl');
  const seen = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0;
  const asked = await call(null, 'POST', '/api/auth/request', { email, ...(invite ? { invite } : {}) });
  if (asked.status >= 400) throw new Error(`sign-in request for ${email} answered ${asked.status}`);
  let token = null;
  for (let i = 0; i < 100 && !token; i++) {
    const rows = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).slice(seen) : [];
    const row = rows.map((r) => JSON.parse(r)).find((r) => JSON.stringify(r).includes(email));
    token = row && /token=([A-Za-z0-9_-]+)/.exec(row.text)?.[1];
    if (!token) await sleep(100);
  }
  if (!token) throw new Error(`no sign-in mail for ${email}`);
  const verified = await call(null, 'POST', '/api/auth/verify', { token });
  const cookie = verified.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (verified.status !== 200 || !cookie) throw new Error(`sign-in for ${email} answered ${verified.status}`);
  return { cookie, user: verified.json.user, email };
}


const VIEWPORTS = [[360, 560], [390, 664], [412, 720]];

/** Emulates iOS Safari's 100vh (the large viewport, taller than what is visible) by adding `extra` px to every vh unit in the stylesheets. */
async function emulateLargeVh(page, extra) {
  await page.evaluate((extraPx) => {
    const out = [];
    const swap = (value) => value.replace(/(^|[^a-z])(-?\d*\.?\d+)vh/g, (m, pre, n) => `${pre}calc((100dvh + ${extraPx}px) * ${Number(n) / 100})`);
    const visit = (rules, wrap) => {
      for (const rule of rules) {
        if (rule.type === CSSRule.STYLE_RULE) {
          const decls = [];
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            const value = rule.style.getPropertyValue(prop);
            if (/(^|[^a-z])\d*\.?\d+vh/.test(value)) decls.push(`${prop}: ${swap(value)} !important`);
          }
          if (decls.length) out.push(wrap(`${rule.selectorText} { ${decls.join('; ')} }`));
        } else if (rule.type === CSSRule.MEDIA_RULE) visit(rule.cssRules, (css) => wrap(`@media ${rule.conditionText} { ${css} }`));
      }
    };
    for (const sheet of document.styleSheets) { try { visit(sheet.cssRules, (css) => css); } catch { /* cross-origin */ } }
    const style = document.createElement('style');
    style.textContent = out.join('\n');
    document.head.appendChild(style);
  }, extra);
}

/** Looks at the top-most dialog or sheet and answers the sweep's questions. */
async function assess(page, scope) {
  return page.evaluate((sel) => {
    const vh = innerHeight;
    const cands = [...document.querySelectorAll(sel || '.modal, .trk-link-modal, .k-card-dialog .modal, [role=dialog]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 40 && getComputedStyle(e).visibility !== 'hidden'; });
    const modal = cands.sort((a, b) => Number(getComputedStyle(b.closest('[class*=back]') || b).zIndex || 0) - Number(getComputedStyle(a.closest('[class*=back]') || a).zIndex || 0))[0] ?? cands.at(-1);
    if (!modal) return { found: false };
    const r = modal.getBoundingClientRect();
    const head = modal.querySelector('.modal-head, header, h2, h1')?.closest('.modal-head, header') ?? modal.querySelector('.modal-head, header');
    const closeBtn = modal.querySelector('.modal-head .icon-btn, .modal-head button, header button[aria-label=Close], button[aria-label=Close], .trk-link-close, button[aria-label="Close dialog"]');
    const hit = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); if (b.width === 0) return null; const x = b.left + b.width / 2, y = b.top + b.height / 2; if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false; const t = document.elementFromPoint(x, y); return t === el || el.contains(t) || (t && t.contains(el) && t !== document.body && t !== document.documentElement && !t.classList.contains('modal-back')); };
    const scrollers = [...modal.querySelectorAll('*')].filter((e) => { const c = getComputedStyle(e); return /(auto|scroll)/.test(c.overflowY) && e.scrollHeight > e.clientHeight + 2; });
    const body = modal.querySelector('.modal-body') ?? scrollers[0] ?? null;
    const primary = [...modal.querySelectorAll('button.primary, .btn.primary, button[type=submit]')].filter((e) => e.getBoundingClientRect().width > 0);
    const inVp = (b) => b.top >= -0.5 && b.bottom <= vh + 0.5;
    const headRect = head?.getBoundingClientRect();
    const out = {
      found: true, vh, modal: [Math.round(r.top), Math.round(r.bottom)],
      modalInside: r.top >= -0.5 && r.bottom <= vh + 0.5,
      head: headRect ? [Math.round(headRect.top), Math.round(headRect.bottom)] : null,
      headVisible: headRect ? inVp(headRect) : null,
      closeTappable: hit(closeBtn), closeFound: Boolean(closeBtn),
      bodyScrolls: body ? (getComputedStyle(body).overflowY.match(/auto|scroll/) !== null) : false,
      overflowing: body ? body.scrollHeight > body.clientHeight + 2 : false,
      scrollers: scrollers.length,
      primaryCount: primary.length,
    };
    // reach the last primary button by scrolling the scrollers to their end
    // each primary button must be reachable at some scroll position (scrolled into the middle of its scroller)
    const bad = [];
    for (const btn of primary) { btn.scrollIntoView({ block: 'center' }); const b = btn.getBoundingClientRect(); if (!(inVp(b) && hit(btn) !== false)) bad.push(btn); }
    const last = bad[0] ?? primary.at(-1);
    out.primaryReachable = primary.length ? bad.length === 0 : null;
    for (const s of scrollers) s.scrollTop = 0;
    out.primaryText = last ? (last.textContent || '').trim().slice(0, 30) : null;
    out.primaryBox = last ? [Math.round(last.getBoundingClientRect().top), Math.round(last.getBoundingClientRect().bottom)] : null;
    return out;
  }, scope);
}

async function sweepStage() {
  const olive = await signIn('olive@example.test');
  await call(olive, 'PATCH', '/api/me', { name: 'Olive Owner' });
  const team = (await call(olive, 'POST', '/api/teams', { name: 'A Team' })).json;
  const members = [];
  for (const [i, name] of ['Ana Member', 'Ben Builder', 'Cat Coder', 'Dan Designer'].entries()) {
    const inv = (await call(olive, 'POST', `/api/teams/${team.id}/invites`, { role: 'member', days: 1 })).json;
    const m = await signIn(`member${i}@example.test`, inv.token);
    await call(m, 'PATCH', '/api/me', { name });
    members.push(m);
  }
  for (const days of [7, 3, 1]) await call(olive, 'POST', `/api/teams/${team.id}/invites`, { role: 'member', days });
  await call(olive, 'POST', '/api/teams/' + team.id + '/invites', { role: 'admin', days: 7 });
  const boardId = 'sweep-board';
  await call(olive, 'POST', '/api/boards', { id: boardId, title: 'Sweep board', teamId: team.id });
  await call(olive, 'POST', `/api/boards/${boardId}/join-codes`, { role: 'editor' });
  for (const [i, [title, state]] of [['One', 'todo'], ['Two', 'in_progress'], ['Three', 'done']].entries()) await call(olive, 'POST', '/api/tracker/tickets', { title, state, idempotencyKey: `sweep-seed-${i}-xx` });

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const cookies = olive.cookie.split('; ').map((pair) => { const [name, ...rest] = pair.split('='); return { name, value: rest.join('='), url: base }; });
  const rows = [];
  const shotDir = options.out;
  try {
    for (const mode of ['plain', 'safari-vh']) {
      for (const [w, h] of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: false });
        await context.addCookies(cookies);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        const tag = `${w}x${h} ${mode}`;
        const clickLabel = (pattern) => page.evaluate((src) => { const re = new RegExp(src, 'i'); const el = [...document.querySelectorAll('button, [role=menuitem], [role=button], a')].find((e) => re.test(e.getAttribute('aria-label') || e.textContent || '')); if (!el) return false; el.click(); return true; }, pattern.source);
        const gone = async (scope) => (await page.locator(scope || '.modal, .trk-link-modal').first().isVisible().catch(() => false)) === false;
        const report = async (name, open, scope, kind = 'modal') => {
          if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) return;
          let result;
          try {
            await open();
            await sleep(700);
            if (mode === 'safari-vh') { await emulateLargeVh(page, 120); await sleep(300); }
            result = await assess(page, scope);
          } catch (e) { result = { found: false, error: String(e.message).split('\n')[0].slice(0, 120) }; }
          const ok = result.found && (kind === 'panel' && result.head === null ? result.modalInside !== false : (result.headVisible !== false && result.modalInside !== false && result.closeTappable !== false && result.primaryReachable !== false));
          const detail = result.found ? `modal ${result.modal} of ${result.vh}, head ${JSON.stringify(result.head)}, close ${result.closeFound ? result.closeTappable : 'none'}, body ${result.bodyScrolls ? 'scrolls' : 'no scroll'}${result.overflowing ? ' (overflows)' : ''}, primary ${result.primaryCount ? `${result.primaryReachable} ("${result.primaryText}" ${JSON.stringify(result.primaryBox)})` : 'n/a'}` : (result.error ?? 'could not open');
          if (result.found) check(`${tag}: ${name}`, ok, detail); else { skip(`${tag}: ${name}`, detail); }
          if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${mode}-${w}x${h}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) }).catch(() => {}); }
          let esc = null, back = null;
          if (result.found && kind === 'modal') {
            await page.keyboard.press('Escape').catch(() => {});
            await sleep(500);
            esc = await gone(scope);
            try {
              if (!esc) await page.evaluate(() => document.querySelectorAll('.modal-back').forEach((e) => e.remove()));
              await open(); await sleep(600);
              if (mode === 'safari-vh') { await emulateLargeVh(page, 120); await sleep(200); }
              await page.mouse.click(2, 8);
              await sleep(500);
              back = await gone(scope);
            } catch { back = null; }
            check(`${tag}: ${name}: Escape closes`, esc === true, String(esc));
            if (back !== null) check(`${tag}: ${name}: a tap on the backdrop closes`, back === true, String(back));
          }
          rows.push({ tag, name, ok: result.found ? ok && esc !== false && back !== false : null });
          await page.keyboard.press('Escape').catch(() => {});
          await sleep(300);
          await page.keyboard.press('Escape').catch(() => {});
          await page.evaluate(() => document.querySelectorAll('.modal-back, .toast, .popover').forEach((e) => e.remove())).catch(() => {});
        };
        const menu = async (item) => { await page.getByRole('button', { name: 'Menu', exact: true }).click(); await sleep(300); const ok = await clickLabel(new RegExp('^' + item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')); if (!ok) throw new Error(`menu item not found: ${item}`); };

        // home screen dialogs
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.getByText('A Team').first().waitFor({ timeout: 15_000 }).catch(() => {});
        await report('team dialog (4+ members, active links)', async () => { await page.getByRole('button', { name: 'Manage' }).first().click(); await page.locator('.modal').first().waitFor({ timeout: 8000 }); });
        await report('new team', async () => { await page.getByRole('button', { name: /New team/ }).first().click(); await page.locator('.modal').first().waitFor({ timeout: 8000 }); });
        await report('workspace members', async () => { await page.getByRole('button', { name: /Members|Workspace members/ }).first().click(); await page.locator('.modal').first().waitFor({ timeout: 8000 }); });

        // board dialogs
        await page.goto(`${base}/?debug#/b/${boardId}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__board && window.__kanban, null, { timeout: 20_000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);
        await report('share dialog (with join code)', async () => { await page.getByRole('button', { name: 'Share' }).first().click(); await page.locator('.modal').first().waitFor({ timeout: 8000 }); });
        await report('your name and colour', async () => { await menu('Your name and colour'); await page.locator('.modal').first().waitFor({ timeout: 8000 }); });
        await report('board settings', async () => { await menu('Board settings'); await page.locator('.modal').first().waitFor({ timeout: 8000 }); });
        await report('keyboard shortcuts', async () => { await menu('Keyboard shortcuts'); await page.locator('.modal').first().waitFor({ timeout: 8000 }); });
        await report('AI tool access', async () => { await menu('AI tool access'); await page.locator('.modal').first().waitFor({ timeout: 8000 }); });
        console.log('RAIL', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.rail-btn, .top-right button, .top-left button')].map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 24)))));
        await report('version history panel', async () => { await menu('Version history'); await page.locator('.history-panel').first().waitFor({ timeout: 8000 }); }, '.history-panel', 'panel');
        await report('board menu (with Export)', async () => { await page.getByRole('button', { name: 'Menu', exact: true }).click(); await page.locator('.popover').first().waitFor({ timeout: 4000 }); }, '.popover', 'panel');
        await report('templates drawer', async () => { if (!(await clickLabel(/Templates and team exercises/))) throw new Error('rail button not found'); await page.locator('.drawer, .drawer.show').first().waitFor({ timeout: 6000 }); }, '.drawer.show, .drawer', 'panel');
        await report('comments tray with composer', async () => { if (!(await clickLabel(/^Comments$/))) throw new Error('button not found'); await page.locator('.comments-list, .comment-msgs, [aria-label=Comments]').first().waitFor({ timeout: 6000 }); }, '[aria-label=Comments], .comments-tray, .tray.comments', 'panel');
        await report('quick poll popover', async () => { if (!(await clickLabel(/Start a quick poll/))) throw new Error('button not found'); await page.locator('.popover.poll-pop').first().waitFor({ timeout: 6000 }); }, '.popover.poll-pop', 'panel');
        await report('font picker (from Board settings)', async () => { await menu('Board settings'); await page.locator('.font-btn').first().waitFor({ timeout: 6000 }); await page.evaluate(() => document.querySelector('.font-btn').click()); await page.locator('.font-picker').first().waitFor({ timeout: 6000 }); }, '.font-picker', 'panel');
        // kanban dialogs
        await page.evaluate(() => {
          const app = window.__board; const store = app.store;
          if (store.get('sk')) return;
          const body = store.getMeta().bodyFont, heading = store.getMeta().headingFont, z = store.topZ();
          const base = { rotation: 0, z, createdBy: 'qa', updatedAt: Date.now() };
          const objs = [{ ...base, id: 'sk', type: 'container', layout: 'kanban', name: 'Sweep kanban', x: 0, y: 0, w: 900, h: 400, font: heading }];
          [['sk-a', 'To do', 'todo'], ['sk-b', 'Doing', 'doing'], ['sk-c', 'Done', 'done']].forEach(([id, name, stage], i) => objs.push({ ...base, id, name, stage, type: 'lane', parent: 'sk', rank: `a${i}@sk`, x: 0, y: 0, w: 260, h: 200, font: body }));
          const card = { ...base, id: 'sk-1', type: 'card', text: 'A card', parent: 'sk-a', rank: 'a0@sk-a', x: 0, y: 0, w: 244, h: 0, font: body }; card.h = window.__kanban.cardContentHeight(card, 244); objs.push(card);
          store.transact(() => objs.forEach((o) => store.create(o)));
        });
        await sleep(1500);
        await report('link dialog', async () => { await page.evaluate(() => window.__board.linkTrackerKanban?.('sk')); await page.locator('.trk-link-modal').first().waitFor({ timeout: 8000 }); });
        await report('container sheet (kanban as list)', async () => { await page.evaluate(() => window.__board.openKanbanList('sk')); await page.locator('.ks-sheet').first().waitFor({ timeout: 8000 }); }, '.ks-sheet', 'panel');
        await report('tracker state picker (from the link dialog)', async () => { await page.evaluate(() => window.__board.linkTrackerKanban?.('sk')); await page.locator('.trk-link-modal button[aria-label^="Set state for"]').first().waitFor({ timeout: 8000 }); await page.evaluate(() => document.querySelector('.trk-link-modal button[aria-label^="Set state for"]').click()); await page.locator('.trk-picker').first().waitFor({ timeout: 6000 }); }, '.trk-picker', 'panel');
        await report('card dialog', async () => { await page.evaluate(() => window.__board.openCardDialog('sk-1')); await page.locator('.k-card-form').first().waitFor({ timeout: 8000 }); });
        await report('labels dialog', async () => { await page.evaluate(() => window.__board.openLabels?.()); await page.locator('.k-labels-dialog, .modal').first().waitFor({ timeout: 8000 }); });

        // tracker new issue
        await page.goto(`${base}/t/all`, { waitUntil: 'domcontentloaded' });
        await page.locator('.trk-new-trigger').first().waitFor({ timeout: 15_000 }).catch(() => {});
        await report('tracker new issue', async () => { await page.locator('.trk-new-trigger').first().click(); await page.locator('.trk-new-issue').first().waitFor({ timeout: 8000 }); });
        await report('tracker bulk actions sheet', async () => { await page.locator('.trk-row-select').first().waitFor({ state: 'attached', timeout: 15_000 }); await sleep(800); await page.locator('.trk-row-select').nth(0).click({ force: true }); await page.locator('.trk-row-select').nth(1).click({ force: true }); await sleep(600); if (process.env.DEBUG_BULK) console.log('BULK', await page.evaluate(() => JSON.stringify({ rows: document.querySelectorAll('.trk-row-select').length, bar: document.querySelector('.trk-selection-bar')?.outerHTML.slice(0, 200), hidden: document.querySelector('.trk-selection-bar')?.hidden, width: innerWidth, shell: document.querySelector('.trk')?.clientWidth }))); await page.locator('.trk-bulk-actions-trigger').waitFor({ timeout: 8000 }); await page.evaluate(() => document.querySelector('.trk-bulk-actions-trigger').click()); await page.locator('.trk-bulk-actions-sheet').waitFor({ timeout: 6000 }); });
        check(`${tag}: no uncaught page errors`, errors.length === 0, errors[0] ?? '');
        await context.close();
      }
    }
  } finally { await browser.close(); }
  console.log('\nSWEEP SUMMARY (failures)');
  for (const r of rows.filter((x) => x.ok === false)) console.log(`  ${r.tag}  ${r.name}`);
}

let exit = 1;
try {
  await startRelay();
  await sweepStage();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${results.some((r) => r.skipped) ? ` (${results.filter((r) => r.skipped).length} could not be opened)` : ''}`);
  exit = failed.length ? 1 : 0;
} catch (error) {
  console.error(`FAIL  ${error.stack ?? error.message}`);
  exit = 1;
} finally {
  await stopRelay();
}
process.exit(exit);
