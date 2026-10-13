// Re-creates docs/images/readme-hero.png: the seeded sprint retro board and the Q4 delivery kanban side by side, canvas only, default theme.
// The two halves are shots of the visual harness (states readme-hero-retro and readme-hero-kanban in scripts/visual-check.mjs, 1282 x 1000 each),
// put next to each other with a thin divider. Usage: npm run build:app && node scripts/readme-hero.mjs [--out docs/images/readme-hero.png]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: { out: { type: 'string' } } });
const out = path.resolve(opts.out ?? path.join(root, 'docs', 'images', 'readme-hero.png'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-hero-'));

const run = spawnSync(process.execPath, [
  path.join(root, 'scripts', 'visual-check.mjs'), '--id', 'hero', '--states', 'readme-hero-retro,readme-hero-kanban',
  '--themes', 'default', '--widths', '1282', '--no-build', '--out', work,
], { cwd: root, env: { ...process.env, VISUAL_HEIGHT: '1000' }, stdio: 'inherit' });
if (run.status !== 0) throw new Error('the visual harness failed');

const shot = (name) => `data:image/png;base64,${fs.readFileSync(path.join(work, 'hero', `${name}-default-1282.png`)).toString('base64')}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 2564, height: 1000 } });
  await page.setContent(`<body style="margin:0;display:flex;background:#fff">
    <img src="${shot('readme-hero-retro')}" width="1282" height="1000">
    <div style="width:2px;background:#d8d6d0"></div>
    <img src="${shot('readme-hero-kanban')}" width="1282" height="1000" style="margin-left:-2px"></body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 2564, height: 1000 } });
} finally {
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`readme-hero: ${path.relative(root, out)}`);
