import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitePort = Number(process.env.VITE_PORT) || 5173;
// Keep Tauri's webview URL aligned with the Vite port selected for this dev session.
const config = JSON.stringify({ build: { devUrl: `http://localhost:${vitePort}` } });
const executable = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
const child = spawn(executable, ['dev', '--config', config, ...process.argv.slice(2)], {
  cwd: path.join(root, 'desktop'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`desktop:dev could not start Tauri: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
