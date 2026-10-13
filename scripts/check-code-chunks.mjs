#!/usr/bin/env node
// Build-output check for the code highlighter (docs/code-blocks.md): no WebAssembly anywhere in the build (the JavaScript regex engine needs none, so the CSP
// needs no wasm-unsafe-eval), the worker is its own chunk, and every shipped theme and grammar is a chunk of its own, not folded into the worker or the app.
// Usage: node scripts/check-code-chunks.mjs [distDir] [--require]   (--require fails when the build has no highlighter at all)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_LANGS } from '../shared/code-langs.mjs';

const args = process.argv.slice(2);
const dist = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const require = args.includes('--require');
const assets = path.join(dist, 'assets');
const problems = [];
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name));
    else files.push(path.join(dir, e.name));
  }
};
walk(dist);

for (const f of files) {
  if (f.endsWith('.wasm')) problems.push(`WebAssembly file in the build: ${path.relative(dist, f)}`);
  else if (/\.(?:m?js|html)$/.test(f) && /WebAssembly|\.wasm\b/.test(fs.readFileSync(f, 'utf8'))) problems.push(`WebAssembly reference in ${path.relative(dist, f)}`);
}

const chunks = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
const worker = chunks.find((f) => f.startsWith('code-highlight.worker-'));
if (!worker) {
  if (require) problems.push('no code-highlight.worker chunk in the build');
  else console.log('note: this build does not include the highlighter (nothing imports src/code-highlight.ts yet)');
} else {
  const size = fs.statSync(path.join(assets, worker)).size;
  if (size > 300_000) problems.push(`worker chunk is ${size} bytes: grammars or themes were folded into it`);
  const sized = (name) => chunks.some((f) => f.startsWith(`${name}-`) && fs.statSync(path.join(assets, f)).size > 500);
  const themes = ['github-light', 'ayu-dark', 'kanagawa-wave', 'vitesse-black'];
  const grammarFiles = { bash: 'shellscript' };
  const grammars = [...new Set(CODE_LANGS.filter((l) => l.shiki).map((l) => l.shiki))];
  for (const t of themes) if (!sized(t)) problems.push(`no chunk of its own for theme ${t}`);
  for (const g of grammars) if (!sized(grammarFiles[g] ?? g)) problems.push(`no chunk of its own for grammar ${g}`);
  const index = chunks.filter((f) => f.startsWith('index-')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('');
  if (/"scopeName":"source\.|scopeName:"source\./.test(index)) problems.push('a grammar is inside the main entry chunk');
  console.log(`worker chunk ${worker} (${size} bytes); ${themes.length} themes and ${grammars.length} grammars each in their own chunk`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('code highlighter build check passed');
