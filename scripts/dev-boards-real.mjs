#!/usr/bin/env node
// DEV ONLY. Seeds the throwaway Boards workspace (scripts/dev-seed-boards.mjs), then starts the relay in accounts mode and
// the Vite dev server on fixed ports, and prints a sign-in link for each persona.
//
//   npm run dev:boards-real
//
// App: http://127.0.0.1:5427   relay: http://127.0.0.1:8797   Ctrl+C stops both.
// The script refuses to start when either port is taken. It never kills whatever holds a port.
// Sign-in links are single use. Stop and run the script again to get fresh ones.
//
// The relay serves the board previews of the production routes (docs/board-previews.md): the Boards cards show a picture of each board.
// A second copy for testing: DEV_BOARDS_RELAY_PORT, DEV_BOARDS_VITE_PORT and DEV_BOARDS_DATA_DIR (a directory inside .dev-data).
// Its sign-in links go into that directory, and its Vite cache beside it, so the copy never touches the demo's files.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATA_DIR, DEV_ROOT, OWNER_EMAIL, describeSeed, seedAll } from './dev-seed-boards.mjs';
import { warmBoardPictures } from './dev-board-warm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_PORT = Number(process.env.DEV_BOARDS_RELAY_PORT) || 8797;
const VITE_PORT = Number(process.env.DEV_BOARDS_VITE_PORT) || 5427;
const ORIGIN = `http://127.0.0.1:${VITE_PORT}`;
const CUSTOM_DATA_DIR = process.env.DEV_BOARDS_DATA_DIR ? path.resolve(process.env.DEV_BOARDS_DATA_DIR) : null;
const DATA_DIR = CUSTOM_DATA_DIR ?? DEFAULT_DATA_DIR;
const LINKS_PATH = CUSTOM_DATA_DIR ? path.join(CUSTOM_DATA_DIR, 'sign-in-links.json') : path.join(DEV_ROOT, 'sign-in-links.json');
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

const result = await seedAll({ dataDir: DATA_DIR });
console.log(describeSeed(result));
console.log(`\ncontent: ${result.content.length} boards with a template`);

// Links are built from the single-use tokens; the smoke token stays out of the printed list (it is for curl checks).
const link = (token) => `${ORIGIN}/#/signin/verify?token=${token}`;
const personas = [
  { key: 'maja', label: 'Maja Holm, owner (admin of Design, Retro, Growth; sees every board)' },
  { key: 'omar', label: 'Omar Haddad, member (owns 4 boards, viewer on Maja\'s Weekly plan)' },
  { key: 'pia', label: 'Pia Larsen, guest (sees only 3 shared boards: viewer, viewer, commenter)' },
];
const links = Object.fromEntries(personas.map((p) => [p.key, link(result.tokens[p.key])]));
fs.mkdirSync(path.dirname(LINKS_PATH), { recursive: true });
fs.writeFileSync(LINKS_PATH, `${JSON.stringify({ origin: ORIGIN, links, smokeToken: result.tokens.smoke }, null, 2)}\n`, { mode: 0o600 });

// Only the TABULA_ and MIRA_ settings below reach the children: an inherited .env or shell setting cannot change this sandbox.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA|MIRA|DEV_BOARDS)_/.test(k) && !['DATA_DIR', 'PORT', 'HOST', 'VITE_PORT', 'VITE_CACHE_DIR'].includes(k)));
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
// A copy with its own data dir gets its own Vite cache too: two dev servers on one cache can delete each other's dependencies.
const viteEnv = {
  ...inherited,
  PORT: String(RELAY_PORT),
  VITE_PORT: String(VITE_PORT),
  ...(CUSTOM_DATA_DIR ? { VITE_CACHE_DIR: path.join(CUSTOM_DATA_DIR, 'vite-cache') } : {}),
};

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

// The seeded boards get their pictures now: each is opened and left as its owner, through the app's own upload (scripts/dev-board-warm.mjs).
// DEV_BOARDS_SKIP_WARM=1 leaves that out; the boards then show the quiet tile until they are opened and left.
if (ready && process.env.DEV_BOARDS_SKIP_WARM !== '1') {
  const relayUp = await (async () => {
    const until = Date.now() + 60_000;
    while (Date.now() < until && !stopping) {
      try {
        if ((await fetch(`http://127.0.0.1:${RELAY_PORT}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true;
      } catch { /* not yet */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  })();
  if (relayUp) {
    console.log(`\nwarming the pictures of ${result.content.length} seeded boards (open and leave each, as its owner)...`);
    try {
      const warm = await warmBoardPictures({ origin: ORIGIN, token: result.tokens.smoke, boardIds: result.content.map((c) => c.id), log: (line) => console.log(line) });
      if (warm.skipped) console.log(warm.skipped);
    } catch (err) {
      console.log(`the picture warm-up stopped: ${err.message}`);
    }
  }
}
