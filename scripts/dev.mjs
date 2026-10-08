// Runs the relay and the Vite dev server together. Vite proxies /sync to the relay.
import { spawn } from 'node:child_process';

// `--accounts` runs the relay in accounts mode against the Vite origin, with sign-in links printed to the console.
// The owner address comes from MIRA_OWNER_EMAIL (also read from .env) and falls back to owner@example.com.
const accounts = process.argv.includes('--accounts');
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}
const accountsEnv = accounts
  ? {
      MIRA_AUTH: 'on',
      MIRA_OWNER_EMAIL: process.env.MIRA_OWNER_EMAIL || 'owner@example.com',
      MIRA_BASE_URL: 'http://localhost:5173',
      MIRA_MAIL: process.env.MIRA_MAIL || 'log',
    }
  : {};
if (accounts) console.log(`accounts mode: sign in at http://localhost:5173 as ${accountsEnv.MIRA_OWNER_EMAIL}; the link is printed below`);

const procs = [
  spawn(process.execPath, ['server/relay.mjs'], { stdio: 'inherit', env: { ...process.env, ...accountsEnv, PORT: '8787' } }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
