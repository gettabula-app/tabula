import { chromium, devices } from 'playwright'; import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
// Regression sweep (section 5 of docs/v5-acceptance.md) on a LOCAL build: comments, chat, Share, exports and every Admin tab that exists in
// a self-run workspace, at 1280 (mouse) and 390 and 360 (Pixel 7 touch emulation). Build first, then:
//   npm run build:app && node scripts/qa-regression-sweep.mjs        (own relay on a free port, accounts mode with chat and MCP on; exits 1 on any FAIL)
// Not covered here, because a local relay cannot show them: the Settings tab and billing text of a hosted workspace, backups against a real bucket.
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Console errors that are expected and not a failure; everything else on the console or a page error fails the run. */
const EXPECTED_CONSOLE_ERRORS = [
  /401/, // /api/me before sign-in
  /fontshare|ERR_FAILED/, // the font host is blocked in the harness
  /409/, // the backup status of a workspace with no backup configured
];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-')); const PORT = await new Promise((r) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p0 = sv.address().port; sv.close(() => r(p0)); }); }); const base = `http://127.0.0.1:${PORT}`; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(k))); Object.assign(env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1', TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: 'owner@example.test', TABULA_BASE_URL: base, TABULA_CHAT: 'on', TABULA_MCP: 'on' });
const relay = spawn(process.execPath, [path.join(root, 'server/relay.mjs')], { cwd: dataDir, env, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break; await sleep(200); }
const H = { 'content-type': 'application/json', 'x-tabula': '1', origin: base };
await fetch(`${base}/api/auth/request`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'owner@example.test' }) }); await sleep(900);
const line = fs.readFileSync(path.join(dataDir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean).at(-1); const token = decodeURIComponent(/token=([^\s&]+)/.exec(JSON.parse(line).text)[1]);
const v = await fetch(`${base}/api/auth/verify`, { method: 'POST', headers: H, body: JSON.stringify({ token }) }); const cookie = v.headers.getSetCookie()[0].split(';')[0];
await fetch(`${base}/api/me`, { method: 'PATCH', headers: { ...H, cookie }, body: JSON.stringify({ name: 'Sweep Owner' }) });
const results = []; const rec = (w, name, ok, note = '') => { results.push({ w, name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${w}] ${name}${note ? '  -- ' + note : ''}`); };
const browser = await chromium.launch();
for (const [w, h, touch] of [[1280, 800, false], [390, 780, true], [360, 740, true]]) {
  const ctx = await browser.newContext(touch ? { ...devices['Pixel 7'], viewport: { width: w, height: h }, acceptDownloads: true } : { viewport: { width: w, height: h }, acceptDownloads: true });
  await ctx.addCookies([{ name: 'tabula_session', value: cookie.split('=')[1], url: base }]); const p = await ctx.newPage(); const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(m.text()))) errs.push(m.text().slice(0, 140)); }); p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  const bid = `sw${w}`; await fetch(`${base}/api/boards`, { method: 'POST', headers: { ...H, cookie }, body: JSON.stringify({ id: bid, title: `Sweep ${w}` }) });
  await p.goto(`${base}/?debug#/b/${bid}`); await p.waitForFunction(() => window.__board); await sleep(1200);
  const tap = (loc) => (touch ? loc.tap() : loc.click());
  // sticky + comment + reply + resolve
  await p.evaluate(() => { const b = window.__board; b.store.transact(() => b.store.create({ id: 's1', type: 'sticky', x: 120, y: 200, w: 160, h: 160, rotation: 0, z: 'a1', text: 'Sweep åäö 😀', color: 'yellow' })); b.zoomTo(1); b.r.flyToCenter({ x: 200, y: 280 }, 1); }); await sleep(600);
  const pos = await p.evaluate(() => { const b = window.__board; const o = b.store.getPlaced('s1'); const s = b.r.toScreen({ x: o.x + 80, y: o.y + 80 }); const r = b.r.svg.getBoundingClientRect(); return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y) }; });
  try {
    await tap(p.getByRole('button', { name: 'Comment', exact: true }).first()); await (touch ? p.touchscreen.tap(pos.x, pos.y) : p.mouse.click(pos.x, pos.y)); await sleep(500);
    await p.locator('textarea:visible').first().fill('Sweep comment åäö'); await p.keyboard.press('Enter'); await sleep(900);
    const card = p.locator('.comment-card'); const haveCard = await card.count();
    if (haveCard) { await card.locator('textarea[aria-label="Reply"]').fill('A reply'); await card.getByRole('button', { name: 'Reply', exact: true }).click(); await sleep(700); await card.getByRole('button', { name: /resolve/i }).click(); await sleep(700); }
    const counts = await p.evaluate(() => { const t = [...window.__board.comments?.threads?.values?.() ?? []]; return t.length; }).catch(() => null);
    rec(w, 'comment, reply, resolve', haveCard > 0, `thread card=${haveCard} threads=${counts}`);
  } catch (e) { rec(w, 'comment, reply, resolve', false, e.message.split('\n')[0]); }
  await p.keyboard.press('Escape');
  // chat
  try {
    await tap(p.locator('.chat-toggle').first()); await sleep(700);
    const box = p.getByRole('combobox', { name: 'Message' }); await box.click(); await box.fill('Hej världen åäö 😀'); await p.keyboard.press('Enter'); await sleep(1200);
    const shown = await p.locator('.side-tray').innerText(); rec(w, 'chat message with åäö and an emoji', /Hej världen åäö/.test(shown) && shown.includes('😀'));
    await tap(p.getByRole('button', { name: /close/i }).first()).catch(() => {});
  } catch (e) { rec(w, 'chat message with åäö and an emoji', false, e.message.split('\n')[0]); }
  // share
  try { await tap(p.getByRole('button', { name: /^Share/ }).first()); await sleep(600); const t = await p.locator('[role=dialog]').first().innerText(); rec(w, 'Share dialog opens with people list', /Share this board/.test(t) && /PEOPLE WITH ACCESS/i.test(t)); await p.keyboard.press('Escape'); } catch (e) { rec(w, 'Share dialog opens', false, e.message.split('\n')[0]); }
  // export
  for (const [label, re] of [['PNG', /^PNG image/], ['board file', /^Board file/]]) {
    try { await tap(p.getByRole('button', { name: 'Menu', exact: true })); await sleep(400); const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }), tap(p.getByRole('button', { name: re }).first())]); const f = await dl.path(); rec(w, `export ${label}`, !!f && fs.statSync(f).size > 500, dl.suggestedFilename()); } catch (e) { rec(w, `export ${label}`, false, e.message.split('\n')[0]); await p.keyboard.press('Escape'); }
  }
  // admin tabs (desktop and phone)
  await p.goto(`${base}/#/admin`); await sleep(1500);
  // (the Settings tab exists on hosted workspaces only, so it is not in this list)
  for (const tab of ['Overview', 'Members', 'Teams', 'Boards', 'Sessions', 'Access tokens', 'AI', 'Chat', 'Backups', 'Audit log']) {
    try { const t = p.locator('.admin-tab', { hasText: new RegExp(`${tab}$`) }).first(); await tap(t); await sleep(900); const label = await p.locator('.admin-panel').first().getAttribute('aria-label'); const body = (await p.locator('.admin-panel').first().innerText().catch(() => '')).length; rec(w, `Admin: ${tab} opens`, label === tab && body > 15, `panel=${label} len=${body}`); } catch (e) { rec(w, `Admin: ${tab} opens`, false, e.message.split('\n')[0]); }
  }
  const health = await (await fetch(`${base}/api/health`)).json(); rec(w, 'health ok', health.ok === true);
  rec(w, 'no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}
await browser.close(); relay.kill(); await sleep(400); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length}/${results.length} passed`, bad.length ? 'FAILED: ' + bad.map((b) => `[${b.w}] ${b.name}`).join('; ') : '');
process.exit(bad.length ? 1 : 0);
