// Fails when a production build (dist/) holds a dev-only stub: the Boards home's "Move to…" and drag between sections are compiled out
// with import.meta.env.DEV until the server has the move route (src/ui/home.ts). Usage: node scripts/check-no-dev-stubs.mjs [dist-folder]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Strings that exist only in the dev stubs; none may appear in a build. */
export const DEV_STUB_STRINGS = ['dev stub', 'not saved on the server yet', 'DEV STUB', 'devMoves'];

/** The files under `dir` (js, css, html, json, map excluded) that contain a stub string, as `{ file, text }`. */
export function findDevStubs(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|mjs|css|html|json)$/.test(entry.name)) {
        const body = fs.readFileSync(p, 'utf8');
        for (const text of DEV_STUB_STRINGS) if (body.includes(text)) found.push({ file: path.relative(dir, p), text });
      }
    }
  };
  walk(dir);
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(process.argv[2] ?? 'dist');
  if (!fs.existsSync(dist)) { console.error(`check-no-dev-stubs: ${dist} does not exist (run npm run build first)`); process.exit(2); }
  const found = findDevStubs(dist);
  if (found.length) { for (const f of found) console.error(`dev stub in the build: "${f.text}" in ${f.file}`); process.exit(1); }
  console.log(`check-no-dev-stubs: ${dist} has none of ${DEV_STUB_STRINGS.length} dev-stub strings`);
}
