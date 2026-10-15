#!/usr/bin/env node
// DEV ONLY. Seeds the throwaway Boards workspace (scripts/dev-seed-boards.mjs), then starts the relay in accounts mode and
// the Vite dev server on fixed ports, and prints a sign-in link for each persona.
//
//   npm run dev:boards-real
//
// App: http://127.0.0.1:5427   relay: http://127.0.0.1:8797   Ctrl+C stops both.
// The script refuses to start when either port is taken. It never kills whatever holds a port.
// Sign-in links are single use. Stop and run the script again to get fresh ones.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_ROOT, OWNER_EMAIL, describeSeed, seed } from './dev-seed-boards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_PORT = 8797;
const VITE_PORT = 5427;
const ORIGIN = `http://127.0.0.1:${VITE_PORT}`;
const LINKS_PATH = path.join(DEV_ROOT, 'sign-in-links.json');
const READY_TIMEOUT_MS = 120_000;

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

for (const port of [RELAY_PORT, VITE_PORT]) {
  if (!(await portFree(port))) {
    console.error(`port ${port} is already in use on 127.0.0.1. Stop whatever holds it, then run this again. Nothing was started or changed.`);
    process.exit(1);
  }
}

const result = seed();
console.log(describeSeed(result));
console.log(`\nmanifest: ${result.manifestPath}`);

// Links are built from the single-use tokens; the smoke token stays out of the printed list (it is for curl checks).
const link = (token) => `${ORIGIN}/#/signin/verify?token=${token}`;
const personas = [
  { key: 'maja', label: 'Maja Holm, owner (admin of Design, Retro, Growth; sees every board)' },
  { key: 'omar', label: 'Omar Haddad, member (owns 4 boards, viewer on Maja\'s Weekly plan)' },
  { key: 'pia', label: 'Pia Larsen, guest (sees only 3 shared boards: viewer, viewer, commenter)' },
];
const links = Object.fromEntries(personas.map((p) => [p.key, link(result.tokens[p.key])]));
fs.mkdirSync(DEV_ROOT, { recursive: true });
fs.writeFileSync(LINKS_PATH, `${JSON.stringify({ origin: ORIGIN, links, smokeToken: result.tokens.smoke }, null, 2)}\n`, { mode: 0o600 });

// Only the TABULA_ and MIRA_ settings below reach the children: an inherited .env or shell setting cannot change this sandbox.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA|MIRA)_/.test(k) && !['DATA_DIR', 'PORT', 'HOST', 'VITE_PORT'].includes(k)));
const relayEnv = {
  ...inherited,
  TABULA_SKIP_DOTENV: '1',
  DATA_DIR: result.dataDir,
  PORT: String(RELAY_PORT),
  HOST: '127.0.0.1',
  TABULA_AUTH: 'on',
  TABULA_OWNER_EMAIL: OWNER_EMAIL,
  TABULA_MAIL: 'log',
  TABULA_BASE_URL: ORIGIN,
};
const viteEnv = { ...inherited, PORT: String(RELAY_PORT), VITE_PORT: String(VITE_PORT) };

const relay = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: root, env: relayEnv, stdio: 'inherit' });
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--strictPort'], {
  cwd: root,
  env: viteEnv,
  stdio: 'inherit',
});
const children = [relay, vite];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const child of children) {
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${child === relay ? 'relay' : 'vite'} exited (${signal ?? `code ${code}`}); stopping the other process`);
    stop(code || 1);
  });
}

console.log(`\nprocesses: this script ${process.pid}, relay ${relay.pid}, vite ${vite.pid}`);
console.log(`stop them with: kill ${relay.pid} ${vite.pid} ${process.pid}`);
console.log(`sign-in links (also in ${LINKS_PATH}); each works once, a new run makes new ones:`);
for (const p of personas) console.log(`  ${p.label}\n    ${links[p.key]}`);

const deadline = Date.now() + READY_TIMEOUT_MS;
let ready = false;
while (!ready && Date.now() < deadline && !stopping) {
  try {
    const res = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(2000) });
    ready = res.ok;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
console.log(ready ? `\nready: ${ORIGIN}` : `\nVite did not answer on ${ORIGIN} within ${READY_TIMEOUT_MS / 1000} s; check the output above`);
