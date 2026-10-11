#!/usr/bin/env node
// Tracker slice 5 integration check (two-way sync of linked kanbans) in a throwaway accounts workspace with TABULA_TRACKER=on.
// Usage: node scripts/qa-tracker-s5.mjs [--widths 1280,390] [--out <folder>]. Needs `npm run build:app`.
// (header reused from qa-tracker-dogfood.mjs)
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

const options = { ui: false, widths: [1280, 390], out: null, stages: [] };
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
    TABULA_BASE_URL: base, TABULA_TRACKER: 'on', TABULA_CHAT: 'on', TABULA_JOIN_CODES: 'on', TABULA_MCP: 'on',
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



/** Runs inside the page: a kanban with an unmapped fourth lane ("Review") and 6 cards in the three mapped lanes. */
function seedKanban({ id }) {
  const app = window.__board;
  const store = app.store;
  if (store.get(id)) return false;
  const body = store.getMeta().bodyFont;
  const heading = store.getMeta().headingFont;
  const z = store.topZ();
  const base = { rotation: 0, z, createdBy: 'qa-s5', updatedAt: Date.now() };
  const lanes = [
    { id: `${id}-todo`, name: 'To do', stage: 'todo' },
    { id: `${id}-doing`, name: 'Doing', stage: 'doing' },
    { id: `${id}-done`, name: 'Done', stage: 'done' },
    { id: `${id}-extra`, name: 'Extra' },
  ];
  const keys = ['a0', 'a1', 'a2', 'a3', 'a4'];
  const objs = [{ ...base, id, type: 'container', layout: 'kanban', name: `Board ${id}`, x: 0, y: 0, w: 1100, h: 520, font: heading }];
  lanes.forEach((l, i) => objs.push({ ...base, ...l, type: 'lane', parent: id, rank: `${keys[i]}@${id}`, x: 0, y: 0, w: 260, h: 200, font: body }));
  const per = [3, 1, 2, 0];
  let n = 0;
  lanes.forEach((l, li) => {
    for (let i = 0; i < per[li]; i++) {
      n++;
      const card = { ...base, id: `${id}-c${n}`, type: 'card', text: `Card ${n} of ${id}`, parent: l.id, rank: `${keys[i]}@${l.id}`, x: 0, y: 0, w: 244, h: 0, font: body };
      card.h = window.__kanban.cardContentHeight(card, 244);
      objs.push(card);
    }
  });
  store.transact(() => objs.forEach((o) => store.create(o)));
  return true;
}

const screenOf = (page, id, fx, fy) => page.evaluate(({ id, fx, fy }) => {
  const app = window.__board;
  const o = app.store.getPlaced(id);
  const s = app.r.toScreen({ x: o.x + o.w * fx, y: o.y + o.h * fy });
  const box = app.r.svg.getBoundingClientRect();
  return { x: box.left + s.x, y: box.top + s.y };
}, { id, fx, fy });

async function s5Stage() {
  const olive = await signIn('olive@example.test');
  await call(olive, 'PATCH', '/api/me', { name: 'Olive Owner' });
  const team = (await call(olive, 'POST', '/api/teams', { name: 'Delivery' })).json;
  const invite = (await call(olive, 'POST', `/api/teams/${team.id}/invites`, { role: 'member', days: 1 })).json;
  const ana = await signIn('ana@example.test', invite.token);
  await call(ana, 'PATCH', '/api/me', { name: 'Ana Member' });
  const boardId = 's5-board';
  await call(olive, 'POST', '/api/boards', { id: boardId, title: 'Slice 5 board', teamId: team.id });
  const code = (await call(olive, 'POST', `/api/boards/${boardId}/join-codes`, { role: 'editor' })).json;
  const joined = code?.code ? await call(null, 'POST', '/api/join', { code: code.code, name: 'Guest Gale' }) : null;
  const guest = joined?.headers?.getSetCookie ? { cookie: joined.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') } : null;
  const team2 = (await call(olive, 'POST', '/api/teams', { name: 'Observers' })).json;
  const invite2 = (await call(olive, 'POST', `/api/teams/${team2.id}/invites`, { role: 'member', days: 1 })).json;
  const vic = await signIn('vic@example.test', invite2.token);
  await call(vic, 'PATCH', '/api/me', { name: 'Vic Viewer' });
  await call(olive, 'POST', `/api/boards/${boardId}/shares`, { principalType: 'user', principalId: vic.user.id, role: 'viewer' });
  const mcpToken = (await call(olive, 'POST', '/api/me/tokens', { name: 'qa s5', scope: 'write', boardIds: [boardId], days: 1 })).json?.token;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const cookieList = (person) => person.cookie.split('; ').map((pair) => { const [name, ...rest] = pair.split('='); return { name, value: rest.join('='), url: base }; });
  const shot = async (page, name) => { if (options.out) { fs.mkdirSync(options.out, { recursive: true }); await page.screenshot({ path: path.join(options.out, `${name}.png`) }); } };
  const openBoard = async (person, width) => {
    const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 } });
    await context.addCookies(cookieList(person));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/?debug#/b/${boardId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__board && window.__kanban, null, { timeout: 20_000 });
    await page.waitForFunction(() => { const p = window.__board.conn.provider; return !p || p.synced; }, null, { timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };
  const parentOf = (page, id) => page.evaluate((cid) => window.__board.store.get(cid)?.parent ?? null, id);
  const startLog = (page, id) => page.evaluate((cid) => { window.__log = []; window.__logTimer = setInterval(() => { const p = window.__board.store.get(cid)?.parent ?? null; const l = window.__log; if (l[l.length - 1] !== p) l.push(p); }, 20); }, id);
  const stopLog = async (page) => page.evaluate(() => { clearInterval(window.__logTimer); return window.__log; });
  const toastText = (page) => page.evaluate(() => { const t = document.querySelector('.toast'); return t && t.classList.contains('show') ? t.textContent ?? '' : ''; });
  const ticketBy = async (key) => (await call(olive, 'GET', `/api/tracker/tickets/${key}`)).json?.ticket;
  const cardKey = (page, id) => page.evaluate((cid) => window.__board.store.get(cid)?.extKey ?? null, id);

  try {
    for (const width of options.widths) {
      const tag = `${width}`;
      const kid = `k${width}`;
      const O = await openBoard(olive, width);
      await O.page.evaluate(seedKanban, { id: kid });
      await sleep(1500);
      const sug = (await call(olive, 'GET', `/api/tracker/links/suggest?boardId=${boardId}&kanbanId=${kid}`)).json;
      const mapping = Object.fromEntries(Object.entries(sug?.mapping ?? {}).filter(([lane]) => !lane.endsWith('-extra')));
      const linked = await call(olive, 'POST', '/api/tracker/links', { boardId, kanbanId: kid, mapping, createTickets: true, idempotencyKey: `s5-link-${tag}-xx` });
      check(`${tag}: setup: the kanban is linked with 6 cards (Extra lane unmapped)`, linked.status === 201 && linked.json?.link?.cardCount === 6, `status ${linked.status}`);
      await sleep(1500);
      const A = await openBoard(ana, width);
      await sleep(800);
      await O.page.evaluate(() => window.__board.zoomToFit?.());
      await A.page.evaluate(() => window.__board.zoomToFit?.());
      await sleep(400);

      // 1. drag to another mapped lane
      const c1 = `${kid}-c1`;
      const key1 = await cardKey(O.page, c1);
      await startLog(A.page, c1);
      const from = await screenOf(O.page, c1, 0.5, 0.5);
      const to = await screenOf(O.page, `${kid}-doing`, 0.5, 0.9);
      await O.page.mouse.move(from.x, from.y);
      await O.page.mouse.down();
      await O.page.mouse.move(to.x, to.y, { steps: 10 });
      await O.page.mouse.up();
      await sleep(2500);
      const log1 = await stopLog(A.page);
      const t1 = await ticketBy(key1);
      check(`${tag}: dragging a card to the Doing lane moves the ticket`, t1?.state?.key === 'in_progress', `${key1}: ${t1?.state?.key}`);
      check(`${tag}: the observer sees the card only ever in To do then Doing`, log1.every((p) => p === `${kid}-todo` || p === `${kid}-doing`) && log1.at(-1) === `${kid}-doing`, JSON.stringify(log1));
      await shot(O.page, `s5-moved-${tag}`);

      // 2. drag into the unmapped lane: undone with a toast
      const c2 = `${kid}-c2`;
      const from2 = await screenOf(O.page, c2, 0.5, 0.5);
      const to2 = await screenOf(O.page, `${kid}-extra`, 0.5, 0.9);
      await O.page.mouse.move(from2.x, from2.y);
      await O.page.mouse.down();
      await O.page.mouse.move(to2.x, to2.y, { steps: 10 });
      await O.page.mouse.up();
      const toastSeen = [];
      let box = null;
      for (let i = 0; i < 40; i++) { const t = await toastText(O.page); if (t) { toastSeen.push([i * 250, t]); if (!box) box = await O.page.evaluate(() => { const el = document.querySelector('.toast.show'); if (!el) return null; const r = el.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(el).lineHeight) || 18; return { w: Math.round(r.width), h: Math.round(r.height), lines: Math.round(r.height / lh) }; }); } await sleep(250); if (!t && toastSeen.length) break; }
      const back = await parentOf(O.page, c2);
      check(`${tag}: a drag into the unmapped lane is undone`, back === `${kid}-todo`, `parent ${back}`);
      const lane = toastSeen.find(([, t]) => /isn't linked to a tracker state/.test(t));
      check(`${tag}: the undo shows the "lane isn't linked" toast`, Boolean(lane), toastSeen[0]?.[1] ?? 'no toast');
      if (toastSeen.length) {
        const seconds = (toastSeen.at(-1)[0] - toastSeen[0][0]) / 1000 + 0.25;
        check(`${tag}: the notice toast stays about 6 s`, seconds >= 4.5 && seconds <= 8, `${seconds.toFixed(1)} s`);
      }
      if (box) check(`${tag}: the notice toast does not wrap to four lines`, box.lines <= 3, JSON.stringify(box));
      await shot(O.page, `s5-unmapped-toast-${tag}`);
      await sleep(7000);

      // 3. title edit commits to the ticket
      const c3 = `${kid}-c3`;
      const key3 = await cardKey(O.page, c3);
      const startAt = Date.now();
      await O.page.evaluate((id) => { const app = window.__board; app.store.transact(() => app.store.update(id, { text: 'Renamed on the board' })); }, c3);
      let title = '';
      let at = 0;
      for (let i = 0; i < 30 && title !== 'Renamed on the board'; i++) { await sleep(150); title = (await ticketBy(key3))?.title ?? ''; at = Date.now() - startAt; }
      check(`${tag}: a title edit on the card commits to the ticket after about 0.4 to 2 s`, title === 'Renamed on the board' && at >= 300 && at <= 2600, `${title} after ${at} ms`);

      // 4. new card in a mapped lane gets a ticket
      const before = (await call(olive, 'GET', '/api/tracker/tickets?limit=50')).json?.tickets?.length ?? 0;
      await O.page.evaluate((id) => { const app = window.__board; const body = app.store.getMeta().bodyFont; const card = { id: `${id}-new`, type: 'card', text: 'Brand new card', parent: `${id}-todo`, rank: 'm0@' + id + '-todo', x: 0, y: 0, w: 244, h: 0, rotation: 0, z: app.store.topZ(), createdBy: 'qa-s5', updatedAt: Date.now(), font: body }; card.h = window.__kanban.cardContentHeight(card, 244); app.store.transact(() => app.store.create(card)); }, kid);
      let newKey = null;
      for (let i = 0; i < 20 && !newKey; i++) { await sleep(300); newKey = await cardKey(O.page, `${kid}-new`); }
      const after = (await call(olive, 'GET', '/api/tracker/tickets?limit=50')).json?.tickets ?? [];
      check(`${tag}: a new card in a mapped lane gets a ticket`, Boolean(newKey) && after.length === before + 1 && after.some((t) => t.key === newKey && t.title === 'Brand new card'), `key ${newKey}, tickets ${before} -> ${after.length}`);

      // 5. delete a card: ticket stays, card unlinked; undo re-links
      const c4 = `${kid}-c4`;
      const key4 = await cardKey(O.page, c4);
      const linksBefore = (await call(olive, 'GET', `/api/tracker/links?boardId=${boardId}&kanbanId=${kid}`)).json?.links?.[0];
      await O.page.evaluate((id) => { const app = window.__board; app.setSelection([id]); app.deleteSelection(); }, c4);
      await sleep(2000);
      const keep = await ticketBy(key4);
      const linksAfter = (await call(olive, 'GET', `/api/tracker/links?boardId=${boardId}&kanbanId=${kid}`)).json?.links?.[0];
      check(`${tag}: deleting a card keeps its ticket and unlinks the card`, Boolean(keep) && !keep.archivedAt && (linksAfter?.cardCount ?? 99) === (linksBefore?.cardCount ?? 0) - 1, `ticket ${keep?.key}, cards ${linksBefore?.cardCount} -> ${linksAfter?.cardCount}`);
      await O.page.evaluate(() => window.__board.store.undo.undo());
      await sleep(2500);
      const linksUndo = (await call(olive, 'GET', `/api/tracker/links?boardId=${boardId}&kanbanId=${kid}`)).json?.links?.[0];
      const keyBack = await cardKey(O.page, c4);
      check(`${tag}: undoing the delete re-links the card to the same ticket`, keyBack === key4 && linksUndo?.cardCount === linksBefore?.cardCount, `key ${keyBack}, cards ${linksUndo?.cardCount}`);

      // 6. delete of a mapped lane is blocked
      const laneId = `${kid}-done`;
      await O.page.evaluate((id) => { const app = window.__board; app.store.transact(() => app.store.remove([id])); }, laneId);
      await sleep(2500);
      const laneBack = await O.page.evaluate((id) => Boolean(window.__board.store.get(id)), laneId);
      const laneToast = await toastText(O.page);
      check(`${tag}: deleting a mapped lane is undone`, laneBack, `lane back: ${laneBack}`);
      check(`${tag}: the undo says to unlink the kanban first`, /Unlink the kanban first/.test(laneToast), laneToast || 'no toast');
      await shot(O.page, `s5-lane-delete-${tag}`);

      // 7. card dialog: owner, due, labels read-only; Edit in tracker
      await O.page.evaluate((id) => window.__board.openCardDialog(id), c3);
      const dlg = O.page.locator('.k-card-form').first();
      const dlgShown = await dlg.waitFor({ timeout: 6000 }).then(() => true, () => false);
      check(`${tag}: the card dialog opens for a linked card`, dlgShown);
      if (dlgShown) {
        const info = await O.page.evaluate(() => {
          const f = document.querySelector('.k-card-form');
          const editableInputs = [...f.querySelectorAll('input:not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]):not([readonly])')].map((e) => `${e.tagName.toLowerCase()}:${e.getAttribute('aria-label') || e.name || e.type}`);
          return { editableInputs, readonly: f.querySelectorAll('.k-link-readonly').length, editInTracker: Boolean(document.querySelector('.k-open-tracker')), text: f.innerText.replace(/\s+/g, ' ').slice(0, 260) };
        });
        check(`${tag}: the linked card's dialog shows "Edit in tracker" and read-only tracker fields`, info.editInTracker && info.readonly >= 3, JSON.stringify({ editInTracker: info.editInTracker, readonly: info.readonly }));
        const ownerEditable = info.editableInputs.some((x) => /owner|due|label/i.test(x));
        check(`${tag}: owner, due and labels cannot be edited in the dialog`, !ownerEditable, info.editableInputs.join(', '));
        await shot(O.page, `s5-card-dialog-${tag}`);
        await O.page.keyboard.press('Escape');
        await sleep(400);
      }

      // 8. a guest cannot move linked cards (forbidden and revert, observer sees nothing)
      if (guest) {
        const G = await openBoard(guest, width);
        await sleep(800);
        const cg = `${kid}-c5`;
        const parentBefore = await parentOf(A.page, cg);
        await startLog(A.page, cg);
        await G.page.evaluate(({ id, lane }) => { const app = window.__board; app.store.transact(() => app.store.update(id, { parent: lane, rank: 'z9@' + lane })); }, { id: cg, lane: `${kid}-todo` });
        await sleep(3000);
        const gParent = await parentOf(G.page, cg);
        const gToast = await toastText(G.page);
        const logG = await stopLog(A.page);
        check(`${tag}: a guest's move of a linked card is reverted`, gParent === parentBefore, `guest sees ${gParent}, expected ${parentBefore}`);
        check(`${tag}: the observer never saw the guest's forbidden move`, logG.every((p) => p === parentBefore), JSON.stringify(logG));
        check(`${tag}: the guest gets the "can't change linked cards" notice`, /can't change linked cards/.test(gToast), gToast || 'no toast');
        await shot(G.page, `s5-guest-${tag}`);
        await G.context.close();
      } else skip(`${tag}: guest move`, 'no guest session');

      // 9. MCP board writers are refused on linked cards
      if (mcpToken) {
        const rpc = async (name, args) => { const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcpToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }); const text = await r.text(); return { status: r.status, text }; };
        const mv = await rpc('move_kanban_card', { boardId, kanbanId: kid, cardId: `${kid}-c5`, laneId: `${kid}-doing` });
        check(`${tag}: MCP move_kanban_card on a linked card is refused, naming the tracker tools`, /transition_ticket|update_ticket|tracker|linked/i.test(mv.text) && /isError|error/i.test(mv.text), mv.text.replace(/\s+/g, ' ').slice(0, 200));
        const up = await rpc('update_kanban_card', { boardId, kanbanId: kid, cardId: `${kid}-c5`, title: 'Changed by an agent' });
        check(`${tag}: MCP update_kanban_card text on a linked card is refused`, /update_ticket|tracker|linked/i.test(up.text) && /isError|error/i.test(up.text), up.text.replace(/\s+/g, ' ').slice(0, 200));
        const stillLane = await parentOf(O.page, `${kid}-c5`);
        check(`${tag}: the refused MCP move left the card where it was`, stillLane === `${kid}-done`, `parent ${stillLane}`);
      } else skip(`${tag}: MCP`, 'no token');


      // 10. restore a board version: the card removed by the restore says so in the ticket history
      if (width >= 600) {
        const named = await call(olive, 'POST', `/api/boards/${boardId}/versions`, { label: `qa before late ${tag}` });
        check(`${tag}: a named version is saved`, named.status < 300, `status ${named.status}`);
        await O.page.evaluate((id) => { const app = window.__board; const body = app.store.getMeta().bodyFont; const card = { id: `${id}-late`, type: 'card', text: 'Late card', parent: `${id}-todo`, rank: 'n0@' + id + '-todo', x: 0, y: 0, w: 244, h: 0, rotation: 0, z: app.store.topZ(), createdBy: 'qa-s5', updatedAt: Date.now(), font: body }; card.h = window.__kanban.cardContentHeight(card, 244); app.store.transact(() => app.store.create(card)); }, kid);
        let lateKey = null;
        for (let i = 0; i < 20 && !lateKey; i++) { await sleep(300); lateKey = await cardKey(O.page, `${kid}-late`); }
        check(`${tag}: the late card got a ticket before the restore`, Boolean(lateKey), `key ${lateKey}`);
        await O.page.getByRole('button', { name: 'Menu', exact: true }).click();
        await O.page.getByText('Version history', { exact: true }).first().click();
        const row = O.page.locator('.history-panel').getByText(`qa before late ${tag}`).first();
        const rowShown = await row.waitFor({ timeout: 10_000 }).then(() => true, () => false);
        check(`${tag}: the named version is listed in Version history`, rowShown);
        if (rowShown) {
          await row.click();
          await O.page.getByRole('button', { name: 'Restore this version' }).click({ timeout: 8000 }).catch(() => {});
          await O.page.locator('.modal-actions button', { hasText: /^Restore$/ }).first().click({ timeout: 8000 }).catch(() => {});
          await sleep(4000);
          await shot(O.page, `s5-restore-${tag}`);
          const gone = await O.page.evaluate((id) => !window.__board.store.get(id), `${kid}-late`);
          check(`${tag}: the restore removed the late card from the board`, gone);
          const ev = (await call(olive, 'GET', `/api/tracker/tickets/${lateKey}`)).json;
          const unlinked = (ev?.events ?? []).filter((e) => e.eventType === 'unlinked');
          check(`${tag}: the ticket history has an "unlinked" event from the restore`, unlinked.length >= 1, JSON.stringify((ev?.events ?? []).map((e) => e.eventType)));
          const stillThere = await ticketBy(lateKey);
          check(`${tag}: the ticket of the removed card is kept`, Boolean(stillThere) && !stillThere.archivedAt);
          const P = await openBoard(olive, width);
          await P.page.goto(`${base}/t/${lateKey}`, { waitUntil: 'domcontentloaded' });
          const text = await P.page.getByText('Card removed from board by a restore').first().waitFor({ timeout: 12_000 }).then(() => true, () => false);
          check(`${tag}: the ticket page shows "Card removed from board by a restore"`, text);
          await shot(P.page, `s5-ticket-history-${tag}`);
          await P.context.close();
        }
      }
      await O.context.close();
      await A.context.close();
    }
  } finally { await browser.close(); }
}

let exit = 1;
try {
  await startRelay();
  await s5Stage();
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
