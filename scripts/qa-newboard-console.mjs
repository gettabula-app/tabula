// QA: opening a new board in Firefox logs no websocket errors (a double route used to open and tear down a first connection).
//   npm run build:app && node scripts/qa-newboard-console.mjs      (own relay on a free port, accounts mode; exits 1 on any websocket console error)
import { firefox } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-newboard-'));
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA_|MIRA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(k)));
Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1', TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: 'owner@example.test', TABULA_BASE_URL: base });
const relay = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: dataDir, env, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break; await sleep(200); }
const headers = { 'content-type': 'application/json', 'x-tabula': '1', origin: base };
await fetch(`${base}/api/auth/request`, { method: 'POST', headers, body: JSON.stringify({ email: 'owner@example.test' }) });
let token = '';
for (let i = 0; i < 50 && !token; i++) {
  await sleep(200);
  const outbox = path.join(dataDir, 'outbox.jsonl');
  const line = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).at(-1) : '';
  const m = line && /token=([^\s&]+)/.exec(JSON.parse(line).text);
  if (m) token = decodeURIComponent(m[1]);
}
const verified = await fetch(`${base}/api/auth/verify`, { method: 'POST', headers, body: JSON.stringify({ token }) });
const cookie = verified.headers.getSetCookie()[0].split(';')[0];
const browser = await firefox.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addCookies([{ name: 'tabula_session', value: cookie.split('=')[1], url: base }]);
let bad = 0;
for (let run = 0; run < 3; run++) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/`);
  await sleep(1500);
  await page.getByRole('button', { name: /new board/i }).first().click();
  await sleep(3000);
  const ws = errors.filter((e) => /websocket|establish a connection|interrupted/i.test(e));
  if (ws.length) bad++;
  console.log(`${ws.length ? 'FAIL' : 'PASS'}  new board ${run + 1}: ${ws.length} websocket console errors`, ws[0] ? `-- ${ws[0].slice(0, 120)}` : '');
  await page.close();
}
await browser.close();
relay.kill();
await sleep(500);
fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(bad ? 'FAILED' : 'all checks passed');
process.exit(bad ? 1 : 0);
