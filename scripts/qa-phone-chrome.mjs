#!/usr/bin/env node
// Phone top chrome check (one 52 px row at <= 480 px): people chip, comments badge, Share icon, themes, notch, desktop metrics.
// Usage: node scripts/qa-phone-chrome.mjs [--out <folder>] [--metrics <file.json>]. Needs `npm run build:app`.
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

const options = { desktopOnly: false,  ui: false, widths: [1280, 390], out: null, stages: ['shell', 'ticket', 'inbox'] };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--ui') options.ui = true;
  else if (arg === '--widths') options.widths = String(process.argv[++i] ?? '').split(',').map(Number);
  else if (arg === '--stages') options.stages = String(process.argv[++i] ?? '').split(',');
  else if (arg === '--desktop-only') options.desktopOnly = true;
  else if (arg === '--metrics') options.metrics = path.resolve(process.argv[++i] ?? '');
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
    TABULA_BASE_URL: base, TABULA_TRACKER: 'on', TABULA_CHAT: 'on', TABULA_JOIN_CODES: 'on',
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


const THEMES = ['default', 'ayu', 'kanagawa', 'matrix', 'evergreen'];
const PHONES = [[360, 780], [375, 812], [390, 844], [412, 915]];
const LONG_TITLE = 'Quarterly planning workshop for the platform and infrastructure teams, second session';
const NAMES = ['Ana Member', 'Bartholomew Montgomery-Featherstonehaugh', 'Cat Coder'];

async function measure(page) {
  return page.evaluate(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) }; };
    const left = document.querySelector('.top-left');
    const right = document.querySelector('.top-right');
    const rail = document.querySelector('.rail');
    const railFirst = rail?.querySelector('button');
    const small = [];
    for (const el of document.querySelectorAll('.top-left button, .top-right button, .phone-people')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (b.width < 44 || b.height < 44) small.push(`${(el.getAttribute('aria-label') || el.textContent || el.className).trim().slice(0, 20)} ${Math.round(b.width)}x${Math.round(b.height)}`);
    }
    const title = [...document.querySelectorAll('.top-left *')].find((e) => e.children.length === 0 && (e.textContent || '').includes('Quarterly') || (e.tagName === 'INPUT' && /Quarterly/.test(e.value)));
    const phoneChip = document.querySelector('.phone-people');
    const chipVisible = phoneChip ? getComputedStyle(phoneChip).display !== 'none' && phoneChip.getBoundingClientRect().width > 0 : false;
    const peopleRow = document.querySelector('.people');
    const peopleVisible = peopleRow ? getComputedStyle(peopleRow).display !== 'none' && peopleRow.getBoundingClientRect().width > 0 : false;
    const overlap = (a, b) => a && b && !(a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y);
    return {
      width: innerWidth, height: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      left: r(left), right: r(right), rail: r(rail), railFirst: r(railFirst),
      leftRightOverlap: overlap(r(left), r(right)),
      chromeRailOverlap: overlap(r(left), r(rail)) || overlap(r(right), r(rail)),
      small,
      titleTruncated: title ? title.scrollWidth > title.clientWidth + 1 || getComputedStyle(title).textOverflow === 'ellipsis' : null,
      titleBox: r(title),
      chipVisible, peopleRowVisible: peopleVisible,
      chipText: phoneChip ? (phoneChip.textContent || '').trim() : null,
      chipAvatars: phoneChip ? phoneChip.querySelectorAll('.phone-avatar').length : 0,
      commentsBadge: [...document.querySelectorAll('.top-right [aria-label*=omment], .top-right button')].map((b) => ({ label: b.getAttribute('aria-label'), text: (b.textContent || '').trim() })).filter((x) => /omment/i.test(x.label || '')),
    };
  });
}

async function chromeStage() {
  const olive = await signIn('olive@example.test');
  await call(olive, 'PATCH', '/api/me', { name: 'Olive Owner' });
  const team = (await call(olive, 'POST', '/api/teams', { name: 'Delivery' })).json;
  const others = [];
  for (const [i, name] of NAMES.entries()) {
    const inv = (await call(olive, 'POST', `/api/teams/${team.id}/invites`, { role: 'member', days: 1 })).json;
    const m = await signIn(`m${i}@example.test`, inv.token);
    await call(m, 'PATCH', '/api/me', { name });
    others.push(m);
  }
  const boardId = 'chrome-board';
  await call(olive, 'POST', '/api/boards', { id: boardId, title: LONG_TITLE, teamId: team.id });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const cookies = (p) => p.cookie.split('; ').map((pair) => { const [name, ...rest] = pair.split('='); return { name, value: rest.join('='), url: base }; });
  const shot = async (page, name) => { if (options.out) { fs.mkdirSync(options.out, { recursive: true }); await page.screenshot({ path: path.join(options.out, `${name}.png`) }); } };
  const open = async (person, w, h) => {
    const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 600 });
    await context.addCookies(cookies(person));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/?debug#/b/${boardId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__board, null, { timeout: 20_000 });
    await page.waitForFunction(() => { const p = window.__board.conn.provider; return !p || p.synced; }, null, { timeout: 15_000 });
    await sleep(800);
    return { context, page, errors };
  };
  const metrics = {};
  try {
    // desktop metrics at 1280 (compared with the baseline build by the caller)
    {
      const D = await open(olive, 1280, 800);
      metrics.desktop = await measure(D.page);
      await shot(D.page, 'desktop-1280');
      await D.context.close();
    }
    if (options.desktopOnly) { if (options.metrics) fs.writeFileSync(options.metrics, JSON.stringify(metrics.desktop, null, 2)); await browser.close(); return; }
    // keep the others connected so the people chip has company
    const companions = [];
    for (const [w, h] of PHONES) {
      for (const count of [1, 2, 4]) {
        const tag = `${w}x${h} ${count} ${count === 1 ? 'person' : 'people'}`;
        for (const c of companions.splice(0)) await c.context.close();
        for (let i = 0; i < count - 1; i++) companions.push(await open(others[i], 390, 800));
        const O = await open(olive, w, h);
        await O.page.evaluate((t) => window.__board.store.setMeta({ name: t }), LONG_TITLE);
        await sleep(2000);
        const m = await measure(O.page);
        metrics[tag] = m;
        await shot(O.page, `phone-${w}-${count}`);
        check(`${tag}: the top chrome is one row of 52 px or less`, m.left && m.left.h <= 56 && m.right && m.right.h <= 56 && Math.abs(m.left.y - m.right.y) <= 4, JSON.stringify({ left: m.left, right: m.right }));
        check(`${tag}: the tool rail starts below the chrome (rail top ${m.rail?.y} vs chrome bottom ${Math.max(m.left?.b ?? 0, m.right?.b ?? 0)})`, m.rail && m.rail.y >= Math.max(m.left.b, m.right.b) + 4, '');
        check(`${tag}: nothing in the chrome overlaps the tool rail or itself`, !m.leftRightOverlap && !m.chromeRailOverlap, JSON.stringify({ lr: m.leftRightOverlap, rail: m.chromeRailOverlap }));
        check(`${tag}: no horizontal scroll`, !m.overflowX);
        check(`${tag}: every button target is at least 44 px`, m.small.length === 0, m.small.join(', '));
        check(`${tag}: the long board title is truncated, not wrapped over other controls`, m.titleTruncated !== false && m.titleBox && m.titleBox.h <= 48, JSON.stringify(m.titleBox));
        if (count === 1) check(`${tag}: the people chip is hidden when you are alone`, !m.chipVisible && !m.peopleRowVisible, `chip ${m.chipVisible}, row ${m.peopleRowVisible}`);
        else {
          check(`${tag}: the people chip shows (up to 2 avatars${count > 2 ? ' + a count' : ''})`, m.chipVisible && m.chipAvatars >= 1 && m.chipAvatars <= 2 && (count <= 2 || /\d/.test(m.chipText ?? '')), JSON.stringify({ avatars: m.chipAvatars, text: m.chipText }));
          const chip = O.page.locator('.phone-people').first();
          await chip.tap().catch(() => chip.click({ force: true }));
          await sleep(500);
          const list = await O.page.evaluate(() => { const l = document.querySelector('.phone-people-list'); if (!l) return null; const b = l.getBoundingClientRect(); return { names: [...l.querySelectorAll('.phone-person-name')].map((e) => e.textContent), top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), vh: innerHeight, vw: innerWidth }; });
          check(`${tag}: tapping the chip opens the list of everyone`, Boolean(list) && list.names.length === count && list.bottom <= list.vh && list.right <= list.vw + 1 && list.left >= -1, JSON.stringify(list));
          await shot(O.page, `phone-${w}-${count}-people-list`);
          await O.page.keyboard.press('Escape');
          await sleep(300);
        }
        // Share icon opens the share dialog
        const share = O.page.locator('.top-right button[aria-label="Share"], .top-right [aria-label=Share]').first();
        const shareBox = await share.boundingBox().catch(() => null);
        await share.tap().catch(() => share.click({ force: true }).catch(() => {}));
        const dlg = await O.page.locator('.modal').first().waitFor({ timeout: 6000 }).then(() => true, () => false);
        check(`${tag}: the Share icon opens the share dialog`, dlg, JSON.stringify(shareBox));
        if (count === 1) await shot(O.page, `phone-${w}-share-dialog`);
        await O.page.keyboard.press('Escape');
        await sleep(300);
        await O.page.evaluate(() => document.querySelectorAll('.modal-back').forEach((e) => e.remove()));
        // comments with unread (once per viewport, with the last count)
        if (count === 4) {
          const A = companions[0];
          await A.page.evaluate(() => { const app = window.__board; const user = app.user; app.comments.addThread({ id: user.id, name: user.name, color: user.color }, { x: 10, y: 10 }, 'Please look at this one'); });
          await sleep(2500);
          const after = await measure(O.page);
          const badge = after.commentsBadge.map((b) => b.text).join('|');
          check(`${tag}: an unread comment shows a badge on the comments icon`, after.commentsBadge.some((b) => /\d/.test(b.text)), JSON.stringify(after.commentsBadge));
          const stillClear = !after.chromeRailOverlap && !after.leftRightOverlap && after.small.length === 0;
          check(`${tag}: the chrome is still clean with the badge showing`, stillClear, badge);
          await shot(O.page, `phone-${w}-unread`);

          if (!process.env.NO_CHAT) {
          // chat: below 380 px it lives in the board menu, with a dot on the menu button when there is unread
          const narrow = w < 380;
          const chatToggle = await O.page.evaluate(() => { const b = document.querySelector('.top-right > .chat-toggle'); return b ? { display: getComputedStyle(b).display, w: Math.round(b.getBoundingClientRect().width) } : null; });
          check(`${tag}: ${narrow ? 'the Chat toggle has left the top bar' : 'the Chat toggle is still in the top bar'}`, narrow ? (!chatToggle || chatToggle.display === 'none' || chatToggle.w === 0) : Boolean(chatToggle && chatToggle.display !== 'none' && chatToggle.w > 0), JSON.stringify(chatToggle));
          const boardChat = `/api/chat/board/${boardId}/messages`;
          const posted = await call(others[0], 'POST', boardChat, { clientId: `qa-chrome-${w}-1`, text: 'Hello from Ana' });
          check(`${tag}: a message is posted in the board chat`, posted.status < 300, `status ${posted.status}`);
          await sleep(2500);
          const dot = await O.page.evaluate(() => { const b = document.querySelector('.top-right > button[aria-label="Menu"]'); if (!b) return null; const a = getComputedStyle(b, '::after'); return { content: a.content, w: a.width, h: a.height, bg: a.backgroundColor, countShown: Boolean(document.querySelector('.chat-count.show')) }; });
          const hasDot = Boolean(dot && dot.content !== 'none' && dot.content !== 'normal' && parseFloat(dot.w) >= 6);
          check(`${tag}: ${narrow ? 'an unread chat shows a dot on the menu button' : 'no menu dot at 380+ (the Chat toggle carries the unread count)'}`, narrow ? hasDot : (!hasDot && dot?.countShown !== false), JSON.stringify(dot));
          await shot(O.page, `phone-${w}-chat-unread`);
          await O.page.getByRole('button', { name: 'Menu', exact: true }).tap().catch(() => O.page.getByRole('button', { name: 'Menu', exact: true }).click());
          await sleep(400);
          const itemInfo = await O.page.evaluate(() => { const i = document.querySelector('.menu-chat-narrow'); if (!i) return null; const b = i.getBoundingClientRect(); const pop = i.closest('.popover')?.getBoundingClientRect(); const first = i.closest('.popover')?.querySelector('.menu-item, button'); return { display: getComputedStyle(i).display, h: Math.round(b.height), w: Math.round(b.width), top: Math.round(b.top), popTop: pop ? Math.round(pop.top) : null, firstIsChat: first === i, inView: b.bottom <= innerHeight && b.top >= 0 }; });
          if (narrow) {
            check(`${tag}: the board menu has a Chat item right at the top (after User guide), at least 44 px tall`, Boolean(itemInfo) && itemInfo.display !== 'none' && itemInfo.h >= 44 && itemInfo.top - itemInfo.popTop <= 64 && itemInfo.inView, JSON.stringify(itemInfo));
            await shot(O.page, `phone-${w}-menu-chat`);
            await O.page.evaluate(() => document.querySelector('.menu-chat-narrow').click());
            await sleep(1500);
            const tray = await O.page.evaluate(() => { const t = document.querySelector('.side-tray, [aria-label=Chat]'); const msgs = [...document.querySelectorAll('.chat-msg, .chat-message, [class*=chat-msg]')].map((e) => (e.textContent || '').trim().slice(0, 40)); return { open: Boolean(document.querySelector('.chat-panel, .chat-list, .chat-composer, textarea[aria-label*=hat], [aria-label="Chat messages"]')), msgs, tab: [...document.querySelectorAll('[role=tab][aria-selected=true]')].map((e) => e.textContent.trim()), t: Boolean(t) }; });
            check(`${tag}: the Chat item opens chat (the same tray tab)`, tray.open || tray.tab.some((x) => /Chat/.test(x)), JSON.stringify(tray));
            await shot(O.page, `phone-${w}-chat-open`);
            await sleep(2000);
            const cleared = await O.page.evaluate(() => { const b = document.querySelector('.top-right > button[aria-label="Menu"]'); const a = getComputedStyle(b, '::after'); return { content: a.content, w: a.width, countShown: Boolean(document.querySelector('.chat-count.show')) }; });
            check(`${tag}: the unread dot clears once chat is read`, cleared.content === 'none' || cleared.content === 'normal' || !cleared.countShown, JSON.stringify(cleared));
            await O.page.keyboard.press('Escape').catch(() => {});
          } else {
            check(`${tag}: the menu has no Chat item at 380+ (hidden)`, !itemInfo || itemInfo.display === 'none' || itemInfo.h === 0, JSON.stringify(itemInfo));
            await O.page.keyboard.press('Escape').catch(() => {});
          }
          await sleep(300);
          // short board title ("Sprint retro") with everyone present
          await O.page.evaluate(() => window.__board.store.setMeta({ name: 'Sprint retro' }));
          await sleep(800);
          const sm = await measure(O.page);
          check(`${tag}: "Sprint retro" with 4 people: chrome clean, targets 44 px`, !sm.chromeRailOverlap && !sm.leftRightOverlap && sm.small.length === 0 && !sm.overflowX, JSON.stringify({ small: sm.small, left: sm.left }));
          const titleText = await O.page.evaluate(() => { const l = document.querySelector('.top-left'); return { text: (l?.innerText || '').replace(/\s+/g, ' ').trim(), w: Math.round(l?.getBoundingClientRect().width || 0) }; });
          console.log(`INFO  ${tag}: left tray text "${titleText.text}" (${titleText.w} px)`);
          await shot(O.page, `phone-${w}-sprint-retro`);
          const chip2 = O.page.locator('.phone-people').first();
          await chip2.tap().catch(() => chip2.click({ force: true }));
          await sleep(400);
          const list2 = await O.page.evaluate(() => document.querySelectorAll('.phone-people-list .phone-person-name').length);
          check(`${tag}: the people chip still opens its list`, list2 === 4, `${list2} names`);
          await O.page.keyboard.press('Escape');
          await sleep(300);
          }
          // themes
          for (const theme of THEMES) {
            await O.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
            await sleep(200);
            const tm = await measure(O.page);
            check(`${tag}: theme ${theme}: chrome clean`, !tm.chromeRailOverlap && !tm.leftRightOverlap && tm.small.length === 0 && !tm.overflowX, JSON.stringify(tm.small));
            await shot(O.page, `phone-${w}-theme-${theme}`);
          }
          await O.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'default'));
          // notch
          await O.page.evaluate(() => { const s = document.documentElement.style; s.setProperty('--safe-top', '47px'); s.setProperty('--safe-left', '0px'); s.setProperty('--safe-right', '0px'); });
          await sleep(300);
          const nm = await measure(O.page);
          check(`${tag}: with a 47 px notch the chrome moves below it and still clears the rail`, nm.left && nm.left.y >= 44 && nm.rail && nm.rail.y >= Math.max(nm.left.b, nm.right.b) + 2, JSON.stringify({ left: nm.left, rail: nm.rail }));
          await shot(O.page, `phone-${w}-notch`);
          await O.page.evaluate(() => { document.documentElement.style.removeProperty('--safe-top'); });
        }
        check(`${tag}: no uncaught page errors`, O.errors.length === 0, O.errors[0] ?? '');
        await O.context.close();
      }
    }
    for (const c of companions) await c.context.close();
  } finally { await browser.close(); }
  if (options.metrics) fs.writeFileSync(options.metrics, JSON.stringify(metrics.desktop, null, 2));
}

let exit = 1;
try {
  await startRelay();
  await chromeStage();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${results.some((r) => r.skipped) ? ` (${results.filter((r) => r.skipped).length} skipped)` : ''}`);
  exit = failed.length ? 1 : 0;
} catch (error) {
  console.error(`FAIL  ${error.stack ?? error.message}`);
  exit = 1;
} finally {
  await stopRelay();
}
process.exit(exit);
