// Usage: npm run build:app && node scripts/a11y-flows.mjs --axe /path/to/axe.min.js [--out /tmp/a11y-flows.json] [--scratch /tmp/a11y149] [--widths 1280,390]
// Audits the sign-in, boards, board creation/vote/poll/share flows, and accounts admin screens in headless Chromium.
// The axe file is injected at runtime; it is not a project dependency. Relays and their DATA_DIRs are throwaway.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: {
  axe: { type: 'string' }, out: { type: 'string' }, scratch: { type: 'string' }, widths: { type: 'string' }, repeat: { type: 'string' },
} });
if (!opts.axe || !fs.existsSync(opts.axe)) throw new Error('Pass an existing axe-core file with --axe <file>.');
const SCRATCH = path.resolve(opts.scratch ?? path.join(os.tmpdir(), 'tabula-a11y-flows'));
fs.mkdirSync(SCRATCH, { recursive: true });
const WIDTHS = (opts.widths ?? '1280,390').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 320);
const RUNS = Math.max(1, Number.parseInt(opts.repeat ?? '1', 10) || 1);
const OWNER_EMAIL = 'owner@example.test';
const relays = [];
const browserErrors = [];

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

function relayEnv({ port, dataDir, accounts }) {
  // Keep caller configuration out of the throwaway relay, following scripts/visual-check.mjs.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TABULA_|MIRA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1' });
  if (accounts) Object.assign(env, {
    TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: OWNER_EMAIL,
    TABULA_BASE_URL: `http://127.0.0.1:${port}`, TABULA_CHAT: 'on', TABULA_JOIN_CODES: 'on', TABULA_MCP: 'on',
  });
  return env;
}

async function startRelay(accounts) {
  const dataDir = fs.mkdtempSync(path.join(SCRATCH, 'data-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'server/relay.mjs')], {
    cwd: dataDir, env: relayEnv({ port, dataDir, accounts }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  const relay = { base, dataDir, child, stderr: '' };
  child.stderr.on('data', (chunk) => { relay.stderr += String(chunk); });
  relays.push(relay);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The ${accounts ? 'accounts' : 'open'} relay exited at start: ${relay.stderr.trim()}`);
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return relay;
    await sleep(100);
  }
  throw new Error(`The ${accounts ? 'accounts' : 'open'} relay did not answer: ${relay.stderr.trim()}`);
}

async function stopRelay(relay) {
  if (relay.child.exitCode === null && relay.child.signalCode === null) {
    const exited = new Promise((resolve) => relay.child.once('exit', resolve));
    relay.child.kill();
    await Promise.race([exited, sleep(4000)]);
  }
  fs.rmSync(relay.dataDir, { recursive: true, force: true, maxRetries: 5 });
}

async function jsonRequest(base, route, body, cookie, method = 'POST') {
  const response = await fetch(`${base}/api/${route}`, {
    method,
    headers: { 'x-tabula': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} /api/${route} answered ${response.status}: ${await response.text()}`);
  return response;
}

async function readLoginToken(dataDir) {
  const outbox = path.join(dataDir, 'outbox.jsonl');
  for (let i = 0; i < 120; i++) {
    const last = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).at(-1) : undefined;
    const match = last && /token=([^\s&]+)/.exec(JSON.parse(last).text);
    if (match) return decodeURIComponent(match[1]);
    await sleep(100);
  }
  throw new Error('No sign-in mail reached the throwaway outbox.jsonl.');
}

async function signInOwner(relay) {
  await jsonRequest(relay.base, 'auth/request', { email: OWNER_EMAIL });
  const verified = await jsonRequest(relay.base, 'auth/verify', { token: await readLoginToken(relay.dataDir) });
  const setCookie = verified.headers.getSetCookie?.()[0] ?? verified.headers.get('set-cookie');
  if (!setCookie) throw new Error('The owner sign-in response did not set a session cookie.');
  const cookie = setCookie.split(';')[0].trim();
  await jsonRequest(relay.base, 'me', { name: 'A11y audit owner' }, cookie, 'PATCH');
  return cookie;
}

const INTERACTIVE = `button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[role=radio],[role=slider],[role=combobox],[role=option],[tabindex]:not([tabindex="-1"])`;

async function axe(page) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: path.resolve(opts.axe) });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return result.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.map((n) => ({ selector: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(1, 3).join(' ').trim() })),
    }));
  });
}

async function namesAndStructure(page) {
  return page.evaluate(({ INTERACTIVE }) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    };
    const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const visibleText = (el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"],.btn-reserve').forEach((node) => node.remove());
      return text(clone);
    };
    const labelText = (el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"],.btn-reserve,input,select,textarea,button').forEach((node) => node.remove());
      return text(clone);
    };
    const nameOf = (el) => {
      const by = el.getAttribute('aria-labelledby');
      if (by) { const s = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(' ').trim(); if (s) return { name: s, via: 'aria-labelledby' }; }
      const aria = el.getAttribute('aria-label'); if (aria?.trim()) return { name: aria.trim(), via: 'aria-label' };
      if (el.labels?.length) { const s = [...el.labels].map(text).join(' ').trim(); if (s) return { name: s, via: 'label' }; }
      if (el.tagName === 'INPUT' && ['button','submit'].includes(el.type) && el.value) return { name: el.value, via: 'value' };
      const visibleText = [...el.querySelectorAll('[aria-hidden="true"]')].reduce((s, n) => s.replace(text(n), ''), text(el)).trim();
      return visibleText ? { name: visibleText, via: 'content' } : { name: '', via: 'none' };
    };
    const describe = (el) => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}`;
    };
    const unnamed = [], inputsWithoutLabel = [], labelMismatches = [], weakNames = [];
    const seen = new Map();
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (!visible(el) || el.disabled || el.closest('[aria-hidden="true"],[inert]')) continue;
      const found = nameOf(el); const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const row = { selector: describe(el), role, name: found.name, via: found.via };
      if (!found.name) unnamed.push(row);
      if (['title', 'placeholder'].includes(found.via)) weakNames.push(row);
      if (['input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) && !['aria-label','aria-labelledby','label'].includes(found.via)) inputsWithoutLabel.push(row);
      if (found.via === 'aria-label' && !el.matches('.avatar,.comment-toggle,.chat-toggle')) {
        const shown = el.labels?.length ? [...el.labels].map(labelText).join(' ').trim() : /^(BUTTON|A)$/.test(el.tagName) ? visibleText(el) : el.getAttribute('placeholder') || '';
        if (shown && !found.name.toLowerCase().includes(shown.toLowerCase())) labelMismatches.push({ ...row, visibleText: shown });
      }
      const key = `${role}|${found.name}`; seen.set(key, (seen.get(key) || 0) + 1);
    }
    const dialogs = [...document.querySelectorAll('[role=dialog],dialog')].filter(visible).map((el) => ({ selector: describe(el), role: el.getAttribute('role') || 'dialog', modal: el.getAttribute('aria-modal'), name: nameOf(el).name }));
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].filter(visible).map((el) => `${el.tagName.toLowerCase()}: ${text(el).slice(0, 80)}`);
    const landmarks = {};
    for (const sel of ['main','nav','header','footer','aside','[role=main]','[role=navigation]','[role=banner]','[role=complementary]','[role=region]']) {
      const count = [...document.querySelectorAll(sel)].filter(visible).length;
      if (count) landmarks[sel] = count;
    }
    const liveRegions = [...document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log],[role=timer]')].filter(visible).map((el) => ({ selector: describe(el), role: el.getAttribute('role'), live: el.getAttribute('aria-live') || null, text: text(el).slice(0, 120) }));
    const imageMissingAlt = [...document.querySelectorAll('img:not([alt])')].filter(visible).map(describe);
    const duplicateNames = [...seen].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
    return { unnamed, inputsWithoutLabel, labelMismatches, weakNames, duplicateNames, dialogs, headings, landmarks, liveRegions, imageMissingAlt, title: document.title, lang: document.documentElement.lang };
  }, { INTERACTIVE });
}

async function keyboardSweep(page, max = 180) {
  await page.evaluate(({ INTERACTIVE }) => {
    document.querySelectorAll(INTERACTIVE).forEach((el, i) => {
      if (!el.hasAttribute('data-a11y-sweep-id')) el.setAttribute('data-a11y-sweep-id', String(i));
    });
  }, { INTERACTIVE });
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  const reached = [], noVisibleRing = [];
  const visited = new Set();
  let wrapped = false;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const current = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const aria = el.getAttribute('aria-label') || '';
      const name = aria || el.getAttribute('aria-labelledby') || (el.labels?.length ? [...el.labels].map((x) => x.textContent.trim()).join(' ') : '') || text;
      const ring = el.matches(':focus-visible') && ((cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== 'none' && cs.boxShadow !== ''));
      const sweepId = el.id ? `id:${el.id}` : el.dataset.option ? `option:${el.dataset.option}` : `sweep:${el.getAttribute('data-a11y-sweep-id')}`;
      return { id: sweepId, selector: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`, name: name.trim().slice(0, 100), ring, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth };
    });
    if (!current) { reached.push(null); if (reached.slice(-3).every((x) => x === null) && reached.length > 6) break; continue; }
    const key = current.id;
    if (visited.has(key)) { wrapped = true; break; }
    visited.add(key); reached.push(current);
    if (!current.ring) {
      const style = await page.evaluate(() => {
        const el = document.activeElement, cs = getComputedStyle(el);
        return { focusVisible: el.matches(':focus-visible'), outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, boxShadow: cs.boxShadow };
      });
      noVisibleRing.push({ selector: current.selector, name: current.name, ...style });
    }
  }
  const expected = await page.evaluate(({ INTERACTIVE }) => {
    const radioGroups = new Map();
    for (const el of document.querySelectorAll('input[type="radio"][name]')) {
      const group = radioGroups.get(el.name) ?? [];
      group.push(el);
      radioGroups.set(el.name, group);
    }
    const radioStops = new Set([...radioGroups.values()].map((group) => group.find((el) => el.checked) ?? group[0]));
    return [...document.querySelectorAll(INTERACTIVE)].filter((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const surface = [...document.querySelectorAll('[aria-modal="true"],.popover,.menu')].filter((e) => {
      const b = e.getBoundingClientRect(), s = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }).at(-1);
    const radioStop = el.tagName === 'INPUT' && el.type === 'radio' && el.name ? radioStops.has(el) : true;
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && el.tabIndex >= 0 && !el.disabled && radioStop && !el.closest('[aria-hidden="true"],[inert]') && (!surface || surface.contains(el));
    }).map((el) => {
      const r = el.getBoundingClientRect();
      const sweepId = el.id ? `id:${el.id}` : el.dataset.option ? `option:${el.dataset.option}` : `sweep:${el.getAttribute('data-a11y-sweep-id')}`;
      return { id: sweepId, selector: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
    });
  }, { INTERACTIVE });
  const reachedKeys = new Set(reached.filter(Boolean).map((x) => x.id));
  const missed = expected.filter((x) => !reachedKeys.has(x.id));
  const radioGroups = await page.evaluate(() => [...document.querySelectorAll('input[type="radio"][name]')].filter((el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.disabled;
  }).reduce((out, el) => { const group = out.find((x) => x.name === el.name); if (group) group.size++; else out.push({ name: el.name, size: 1 }); return out; }, []));
  const radioArrows = [];
  for (const group of radioGroups.filter((x) => x.size > 1)) {
    const selector = `input[type="radio"][name=${JSON.stringify(group.name)}]`;
    const radios = page.locator(selector);
    const before = await radios.evaluateAll((els) => els.find((el) => el.checked)?.labels?.[0]?.textContent.trim() || els[0]?.labels?.[0]?.textContent.trim() || '');
    const checked = radios.locator(':checked');
    const start = await checked.count() ? checked.first() : radios.first();
    await start.focus().catch(() => undefined);
    await page.keyboard.press('ArrowDown');
    const after = await page.evaluate((name) => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement && el.type === 'radio' && el.name === name ? el.labels?.[0]?.textContent.trim() || '' : '';
    }, group.name);
    radioArrows.push({ group: 'native radio choices', before, after, moved: Boolean(after && after !== before) });
  }
  return { tabStops: reached.filter(Boolean).length, wrapped, trap: false, missedCount: missed.length, missed: missed.slice(0, 30), noVisibleRing: noVisibleRing.slice(0, 30), sequence: reached.filter(Boolean).slice(0, 100).map((x) => x.name || '(no name)'), radioArrows };
}

async function newPage(browser, base, hash, width, cookie, billingFree = false) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', serviceWorkers: 'block', bypassCSP: true });
  await ctx.route((url) => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', (route) => route.abort());
  if (billingFree) await ctx.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const me = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...me, workspace: { ...me.workspace, billing: false } }) });
  });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('driftboard:theme', 'default'); } catch { /* browser storage can be disabled */ }
  });
  if (cookie) {
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, domain: '127.0.0.1', path: '/' }]);
  }
  const page = await ctx.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') browserErrors.push({ type: 'console', text: msg.text().slice(0, 220), path: hash, width }); });
  page.on('pageerror', (err) => browserErrors.push({ type: 'pageerror', text: String(err.message).slice(0, 220), path: hash, width }));
  await page.goto(`${base}/${hash.startsWith('#/b/') ? '?debug' : ''}${hash}`);
  return { ctx, page };
}

let activeRun = 1;
const results = { startedAt: new Date().toISOString(), widths: WIDTHS, repeat: RUNS, screens: [], interactions: [], escapeChecks: [], errors: [], browserErrors };
async function capture(id, page, width, extra = {}) {
  await page.waitForTimeout(250);
  const violations = await axe(page);
  const structure = await namesAndStructure(page);
  const keyboard = await keyboardSweep(page);
  results.screens.push({ id, width, repeat: activeRun, ...extra, axe: violations, structure, keyboard });
}

async function checkEscape(page, opener, id, modalSelector = '[role=dialog]') {
  try {
    const surface = page.locator(modalSelector).first();
    const opened = await surface.isVisible().catch(() => false);
    const focusOnOpen = await surface.evaluate((el) => el.contains(document.activeElement)).catch(() => false);
    if (opened && !focusOnOpen) await surface.locator('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]').first().focus();
    const focusedInside = await surface.evaluate((el) => el.contains(document.activeElement)).catch(() => false);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const closed = !(await surface.isVisible().catch(() => false));
    const returned = await opener.evaluate((el) => el === document.activeElement).catch(() => false);
    results.escapeChecks.push({ id, opened, focusOnOpen, focusedInside, closed, returned });
  } catch (err) {
    results.escapeChecks.push({ id, error: String(err.message).split('\n')[0] });
  }
}

async function main() {
  if (!WIDTHS.length) throw new Error('No valid widths were supplied.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  let accounts, cookie;
  try {
    accounts = await startRelay(true);
    cookie = await signInOwner(accounts);
    await jsonRequest(accounts.base, 'boards', { id: 'a11y149-admin-board', title: 'Accessibility audit board' }, cookie);
    await jsonRequest(accounts.base, 'teams', { name: 'Accessibility audit team' }, cookie);

    // Sign-in before and after requesting a link; each request uses a unique unknown test address.
    for (let run = 1; run <= RUNS; run++) {
      activeRun = run;
      for (const width of WIDTHS) {
      const { ctx, page } = await newPage(browser, accounts.base, '#/signin', width);
      try {
        await page.getByRole('heading', { name: 'Sign in to Tabula' }).waitFor();
        await capture('Sign-in form', page, width);
        await page.getByLabel('Email', { exact: true }).fill(`reader-${run}-${width}@example.test`);
        await page.getByRole('button', { name: 'Email me a link' }).click();
        await page.getByRole('heading', { name: 'Check your email' }).waitFor();
        await capture('Sign-in confirmation', page, width);
      } catch (err) { results.errors.push({ flow: 'sign-in', width, error: String(err.message).split('\n')[0] }); }
      await ctx.close();

      const home = await newPage(browser, accounts.base, '#/', width, cookie);
      try {
        await home.page.getByRole('heading', { name: 'Boards', exact: true }).waitFor();
        await home.page.locator('.home-groups').waitFor();
        await capture('Boards list', home.page, width);
      } catch (err) { results.errors.push({ flow: 'home', width, error: String(err.message).split('\n')[0] }); }
      await home.ctx.close();

      // The board interactions below run through the built UI, with a separate throwaway board at each width.
      const boardId = `a11y149-flow-${width}-${run}`;
      await jsonRequest(accounts.base, 'boards', { id: boardId, title: `A11y flow ${width}` }, cookie);
      const board = await newPage(browser, accounts.base, `#/b/${boardId}`, width, cookie);
      try {
        await board.page.locator('svg.canvas').waitFor({ timeout: 15000 });
        await board.page.waitForFunction(() => window.__board && (!window.__board.conn.provider || window.__board.conn.provider.synced), null, { timeout: 15000 });
        const canvas = await board.page.locator('svg.canvas').boundingBox();
        if (!canvas) throw new Error('Board canvas has no visible bounds.');
        const spot = (x, y) => ({ x: Math.round(canvas.x + canvas.width * x), y: Math.round(canvas.y + canvas.height * y) });
        const clickSpot = async (x, y) => { const p = spot(x, y); await board.page.mouse.click(p.x, p.y); await board.page.waitForTimeout(180); };
        const finishTextEdit = async (text) => {
          const editor = board.page.locator('textarea.text-editor');
          if (await editor.isVisible().catch(() => false)) { await editor.fill(text); await editor.press('Escape'); }
        };

        await board.page.getByRole('button', { name: 'Sticky note', exact: true }).click();
        await clickSpot(0.48, 0.48);
        await finishTextEdit('Audit sticky');
        results.interactions.push({ id: 'create-sticky', width, repeat: run, created: await board.page.evaluate(() => [...window.__board.store.cache.values()].some((o) => o.type === 'sticky')) });
        await capture('Board: sticky created', board.page, width);

        await board.page.getByRole('button', { name: 'Text', exact: true }).first().click();
        await clickSpot(0.72, 0.38);
        await finishTextEdit('Audit text');
        results.interactions.push({ id: 'create-text', width, repeat: run, created: await board.page.evaluate(() => [...window.__board.store.cache.values()].some((o) => o.type === 'text')) });
        await capture('Board: text created', board.page, width);

        await board.page.getByRole('button', { name: 'Shapes', exact: true }).click();
        await board.page.locator('.drawer.show').waitFor();
        const firstShape = board.page.locator('.drawer.show .tile').first();
        const shapeName = await firstShape.getAttribute('aria-label');
        await firstShape.click();
        await clickSpot(0.68, 0.58);
        await finishTextEdit('Audit shape');
        results.interactions.push({ id: 'create-shape', width, repeat: run, label: shapeName, created: await board.page.evaluate(() => [...window.__board.store.cache.values()].some((o) => o.type === 'shape')) });
        await capture('Board: shape created', board.page, width);

        await board.page.getByRole('button', { name: 'Connector', exact: true }).click();
        const start = spot(0.20, 0.70), end = spot(0.35, 0.70);
        await board.page.mouse.move(start.x, start.y); await board.page.mouse.down();
        await board.page.mouse.move(end.x, end.y, { steps: 4 }); await board.page.mouse.up();
        await board.page.waitForTimeout(200);
        results.interactions.push({ id: 'create-connector', width, repeat: run, created: await board.page.evaluate(() => [...window.__board.store.cache.values()].some((o) => o.type === 'connector')) });
        await capture('Board: connector created', board.page, width);

        const commentTool = board.page.locator('.rail-btn[aria-label="Comment"]');
        await commentTool.click();
        await clickSpot(0.83, 0.72);
        const comment = board.page.locator('.comment-card[role=dialog]');
        await comment.waitFor();
        await capture('Board: new comment composer', board.page, width);
        await checkEscape(board.page, commentTool, `comment composer ${width}`, '.comment-card');
        // Reopen through a pointer action, then post the comment and reply in the thread.
        await commentTool.click();
        await clickSpot(0.83, 0.72);
        const compose = board.page.locator('.comment-card');
        await compose.getByRole('textbox', { name: 'Add a comment' }).fill('Audit comment');
        await compose.getByRole('button', { name: 'Comment', exact: true }).click();
        await compose.getByRole('textbox', { name: 'Reply' }).fill('Audit reply');
        await compose.getByRole('button', { name: 'Reply', exact: true }).click();
        await capture('Board: comment thread and reply', board.page, width);
        await compose.getByRole('button', { name: 'Close', exact: true }).click();

        await board.page.getByRole('button', { name: 'Start a dot vote', exact: true }).click();
        await board.page.getByRole('heading', { name: 'What can be voted on?' }).waitFor();
        await capture('Board: dot vote setup', board.page, width);
        await checkEscape(board.page, board.page.getByRole('button', { name: 'Start a dot vote', exact: true }), `dot vote setup ${width}`, '.vote-setup');
        await board.page.getByRole('button', { name: 'Start a dot vote', exact: true }).click();
        await board.page.getByRole('button', { name: 'Start vote', exact: true }).click();
        await board.page.locator('.flowbar.show').waitFor();
        await capture('Board: dot vote facilitator bar', board.page, width);
        await clickSpot(0.48, 0.48);
        await board.page.waitForTimeout(650);
        const dotCount = await board.page.evaluate(() => ({
          buttonName: document.querySelector('.votes-left')?.getAttribute('aria-label') ?? '',
          announcement: document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent?.trim() ?? '',
        }));
        results.interactions.push({ id: 'dot-vote-count', width, repeat: run, ...dotCount, announced: /1 dot placed/.test(dotCount.announcement) });
        await capture('Board: dot vote count announced', board.page, width);
        await board.page.getByRole('button', { name: 'Reveal votes', exact: true }).click();
        await capture('Board: dot vote revealed', board.page, width);
        await board.page.getByRole('button', { name: 'Finish', exact: true }).click().catch(() => undefined);

        await board.page.getByRole('button', { name: 'Start a quick poll', exact: true }).click();
        const pollPop = board.page.locator('.poll-pop');
        await pollPop.waitFor();
        await capture('Board: quick poll composer', board.page, width);
        await checkEscape(board.page, board.page.getByRole('button', { name: 'Start a quick poll', exact: true }), `quick poll composer ${width}`, '.poll-pop');
        await board.page.getByRole('button', { name: 'Start a quick poll', exact: true }).click();
        await pollPop.getByRole('textbox', { name: 'Question', exact: true }).fill('Audit poll question');
        await pollPop.getByRole('textbox', { name: 'Option 1', exact: true }).fill('Yes');
        await pollPop.getByRole('textbox', { name: 'Option 2', exact: true }).fill('No');
        await pollPop.getByRole('button', { name: 'Start poll', exact: true }).click();
        await board.page.locator('.poll-card:not([hidden])').waitFor();
        await board.page.locator('.flowbar.show').waitFor();
        await capture('Board: quick poll card and facilitator bar', board.page, width);
        await board.page.locator('.poll-card input[type=radio]').first().check();
        await capture('Board: quick poll answered', board.page, width);
        await board.page.getByRole('button', { name: 'Reveal results', exact: true }).click();
        await capture('Board: quick poll revealed', board.page, width);

        const share = board.page.getByRole('button', { name: 'Share', exact: true });
        await share.click();
        const shareDialog = board.page.getByRole('dialog', { name: 'Share this board' });
        await shareDialog.waitFor();
        await shareDialog.getByRole('region', { name: 'Join code' }).waitFor();
        await capture('Board: Share dialog and join-code section', board.page, width);
        await checkEscape(board.page, share, `share dialog ${width}`);
        await share.click();
        const shareAgain = board.page.getByRole('dialog', { name: 'Share this board' });
        await shareAgain.getByRole('button', { name: 'Create code', exact: true }).click();
        await shareAgain.locator('.join-code-created').waitFor();
        await capture('Board: Share dialog with a created join code', board.page, width);

        // Follow the code as an actual guest to verify the owner-only profile menu entry is absent.
        const joinCode = await shareAgain.locator('.join-code-value').inputValue();
        const guest = await newPage(browser, accounts.base, `#/join?c=${encodeURIComponent(joinCode)}`, width);
        try {
          await guest.page.getByLabel('Display name').fill(`Guest ${run} ${width}`);
          await guest.page.getByRole('button', { name: 'Join board', exact: true }).click();
          await guest.page.locator('svg.canvas').waitFor({ timeout: 15000 });
          await guest.page.getByRole('button', { name: 'Menu', exact: true }).click();
          await guest.page.locator('.menu').waitFor();
          const profileItemCount = await guest.page.locator('.menu-item').filter({ hasText: 'Your name and colour' }).count();
          results.interactions.push({ id: 'guest-profile-menu-hidden', width, repeat: run, hidden: profileItemCount === 0 });
          if (profileItemCount > 0) results.errors.push({ flow: 'guest profile menu', width, error: 'The unavailable profile action is still offered to guests.' });
          await capture('Board: guest menu', guest.page, width);
        } catch (err) { results.errors.push({ flow: 'guest profile menu', width, error: String(err.message).split('\n')[0] }); }
        await guest.ctx.close();
      } catch (err) {
        results.errors.push({ flow: 'board', width, error: String(err.message).split('\n')[0] });
      }
      await board.ctx.close();

      // Admin pages share the owner session and the pre-seeded board/team. Audit every requested section.
      for (const tab of ['members', 'teams', 'tokens', 'ai', 'backups', 'audit', 'overview']) {
        const admin = await newPage(browser, accounts.base, `#/admin/${tab}`, width, cookie, tab === 'overview');
        try {
          await admin.page.locator('.admin-panel h2').waitFor({ timeout: 10000 });
          await admin.page.waitForTimeout(350);
          const heading = (await admin.page.locator('.admin-panel h2').textContent())?.trim() ?? tab;
          await capture(`Admin: ${heading}`, admin.page, width, { tab });
          if (tab === 'overview') {
            const billingHeading = admin.page.getByRole('heading', { name: 'Billing', exact: true });
            await billingHeading.waitFor({ timeout: 5000 });
            const billingText = await billingHeading.evaluate((el) => el.parentElement?.innerText ?? '');
            await capture('Admin: Billing text', admin.page, width, { billingText });
          }
          if (tab === 'tokens') {
            const tokenOpener = admin.page.getByRole('button', { name: 'Create a token', exact: true });
            await tokenOpener.click();
            const tokenDialog = admin.page.getByRole('dialog', { name: 'AI tool access' });
            await tokenDialog.getByRole('button', { name: 'New token', exact: true }).waitFor();
            await capture('Admin: Access token dialog', admin.page, width);
            await checkEscape(admin.page, tokenOpener, `access token dialog ${width} run ${run}`);
            await tokenOpener.click();
            const reopened = admin.page.getByRole('dialog', { name: 'AI tool access' });
            await reopened.getByRole('button', { name: 'New token', exact: true }).click();
            await reopened.getByRole('textbox', { name: /^Token name/ }).waitFor();
            await capture('Admin: New access token form', admin.page, width);
            await checkEscape(admin.page, tokenOpener, `new access token form ${width} run ${run}`);
          }
        } catch (err) { results.errors.push({ flow: `admin ${tab}`, width, error: String(err.message).split('\n')[0] }); }
        await admin.ctx.close();
      }
      }
    }
  } finally {
    await browser.close();
    for (const relay of relays.reverse()) await stopRelay(relay);
  }
  results.finishedAt = new Date().toISOString();
  const output = JSON.stringify(results, null, 2);
  if (opts.out) fs.writeFileSync(opts.out, output);
  else console.log(output);
  if (results.errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
