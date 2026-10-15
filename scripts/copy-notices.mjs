#!/usr/bin/env node
// Copies the third-party notices into dist/ so a running Tabula serves them at /third-party-notices.txt.
// The relay's MIME table (server/relay.mjs) has .txt as text/plain; a .md file would go out as a download.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs', 'third-party-notices.md');
const target = path.join(root, 'dist', 'third-party-notices.txt');

if (!fs.existsSync(source)) {
  console.error(`copy-notices: ${path.relative(root, source)} is missing. Generate it with \`node scripts/third-party-notices.mjs\` and run the build again.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`Copied ${path.relative(root, source)} to ${path.relative(root, target)}.`);
