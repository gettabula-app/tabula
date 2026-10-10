import { chromium } from 'playwright'; import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
// QA: opening the sign-in link inside the already-open page verifies the token ONCE (a hash change fires hashchange and popstate).
//   npm run build:app && node scripts/qa-signin-verify.mjs      (starts its own relay on a free port, exits 1 on a double verify)
import net from 'node:net'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-')); const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); }); const base = `http://127.0.0.1:${PORT}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(k))); Object.assign(env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1', TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: 'owner@example.test', TABULA_BASE_URL: base });
const relay = spawn(process.execPath, [path.join(root, 'server/relay.mjs')], { cwd: dataDir, env, stdio: 'ignore' }); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break; await sleep(200); }
const browser = await chromium.launch(); const p = await (await browser.newContext()).newPage(); const verifies = []; p.on('response', (r) => { if (r.url().endsWith('/api/auth/verify')) verifies.push(r.status()); });
await p.goto(base + '/'); await p.waitForTimeout(1200); await p.locator('input[type=email], input[name=email]').first().fill('owner@example.test'); await p.getByRole('button', { name: /email me a link/i }).click(); await sleep(1500);
const line = fs.readFileSync(path.join(dataDir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean).at(-1); const token = decodeURIComponent(/token=([^\s&]+)/.exec(JSON.parse(line).text)[1]);
await p.evaluate((t) => { location.hash = `#/signin/verify?token=${encodeURIComponent(t)}`; }, token); await p.waitForTimeout(2500);
console.log('verify calls:', JSON.stringify(verifies), '| page:', (await p.locator('body').innerText()).replace(/\n+/g, ' ').slice(0, 90));
await browser.close(); relay.kill(); process.exit(verifies.length === 1 ? 0 : 1);
