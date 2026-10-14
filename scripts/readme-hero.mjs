// Re-creates docs/images/readme-hero.png: the Q4 delivery kanban, canvas only, default theme, 1600 x 760, large enough that the card text reads
// when the README shows the picture at about 800 px wide. The shot is the visual harness state readme-hero-kanban (scripts/visual-check.mjs).
// Usage: npm run build:app && node scripts/readme-hero.mjs [--out docs/images/readme-hero.png]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: { out: { type: 'string' } } });
const out = path.resolve(opts.out ?? path.join(root, 'docs', 'images', 'readme-hero.png'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-hero-'));

const run = spawnSync(process.execPath, [
  path.join(root, 'scripts', 'visual-check.mjs'), '--id', 'hero', '--states', 'readme-hero-kanban',
  '--themes', 'default', '--widths', '1600', '--no-build', '--out', work,
], { cwd: root, env: { ...process.env, VISUAL_HEIGHT: '760' }, stdio: 'inherit' });
if (run.status !== 0) throw new Error('the visual harness failed');
fs.copyFileSync(path.join(work, 'hero', 'readme-hero-kanban-default-1600.png'), out);
fs.rmSync(work, { recursive: true, force: true });
console.log(`readme-hero: ${path.relative(root, out)}`);
