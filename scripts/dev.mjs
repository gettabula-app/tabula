// Runs the relay and the Vite dev server together. Vite proxies /sync to the relay.
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['server/relay.mjs'], { stdio: 'inherit', env: { ...process.env, PORT: '8787' } }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
