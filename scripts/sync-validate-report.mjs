#!/usr/bin/env node
// Runs the sync validator (server/sync-validate.mjs) over every board the repo can build and prints a table of violation
// codes and counts per fixture, no content. It shows what the real client writes, so a legitimate field the validator
// flags means the allow-list is wrong, not the client.
//
// Fixtures (test/sync-validate-fixtures.ts): one object of every type, shape kind, relation and UML element built by the
// client's own code; the demo board seed; every built-in template, directly and through the custom-template insert; Mermaid
// imports; an AI-proposed sticky; and a delete-then-undo of somebody else's object. There are no .drift files in the repository and
// docs/images holds only PNGs, so there is nothing else to load. The client code is TypeScript, so it is loaded through a
// Vite server in SSR mode (no browser, no network).
//
// Usage: node scripts/sync-validate-report.mjs [--json]
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');

const vite = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const { allFixtures } = await vite.ssrLoadModule('/test/sync-validate-fixtures.ts');
  const { validateChangedKeys, countCodes } = await vite.ssrLoadModule('/server/sync-validate.mjs');
  const rows = [];
  const total = {};
  const byKind = {};
  for (const fixture of allFixtures()) {
    const ctx = {
      writer: fixture.writer,
      isBoardMember: () => true,
      canEditObject: () => true,
      isAgentOwner: () => false,
      ...fixture.ctx,
    };
    const result = validateChangedKeys(fixture.changes, ctx);
    const violations = result.ok ? [] : result.violations;
    const counts = countCodes(violations);
    for (const [code, n] of Object.entries(counts)) total[code] = (total[code] ?? 0) + n;
    // code + kind + field, for the cases that need a closer look; never the value
    const where = {};
    for (const x of violations) {
      const k = `${x.code} ${x.kind}:${x.path.replace(/\[\d+\]/g, '[]')}`;
      where[k] = (where[k] ?? 0) + 1;
      byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
    }
    rows.push({ name: fixture.name, changes: fixture.changes.length, violations: violations.length, counts, where });
  }
  if (json) {
    console.log(JSON.stringify({ rows, total }, null, 2));
  } else {
    const codes = Object.keys(total).sort();
    console.log(`${'fixture'.padEnd(46)} ${'keys'.padStart(5)} ${'viol'.padStart(5)}  codes`);
    for (const r of rows) {
      const detail = Object.entries(r.counts).map(([c, n]) => `${c}=${n}`).join(' ');
      console.log(`${r.name.padEnd(46)} ${String(r.changes).padStart(5)} ${String(r.violations).padStart(5)}  ${detail || '-'}`);
    }
    console.log('');
    const sum = rows.reduce((a, r) => ({ changes: a.changes + r.changes, violations: a.violations + r.violations }), { changes: 0, violations: 0 });
    console.log(`${rows.length} fixtures, ${sum.changes} keys checked, ${sum.violations} violations`);
    console.log(`by code: ${codes.map((c) => `${c}=${total[c]}`).join(' ') || 'none'}`);
    const places = new Map();
    for (const r of rows) for (const [k, n] of Object.entries(r.where)) places.set(k, (places.get(k) ?? 0) + n);
    if (places.size) {
      console.log('where (code kind:field = count, all fixtures):');
      for (const [k, n] of [...places].sort((a, b) => b[1] - a[1])) console.log(`  ${k} = ${n}`);
    }
  }
} finally {
  await vite.close();
}
