#!/usr/bin/env node
// TAB-94: the restore drill of the ops runbook (section 8), rehearsed locally against relays and the fake S3 of the
// backup tests. Runs test/drill/*.drill.test.ts with vitest.drill.config.ts (they are never part of `npm test`), reads
// vitest's JSON report, and prints a checklist of the runbook boxes and a filled drill record (section 9).
//
//   npm run drill:local
//
// Exits 1 when any box failed. docs/backups.md, "Rehearsing a restore locally".
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

/** The runbook boxes in runbook order. `note` is printed for a box that has no test here. */
export const BOXES = [
  { id: '8.2.backup-runs', label: 'A backup runs by itself; keys in the bucket are opaque' },
  { id: '8.2.backup-shutdown', label: 'An edit, then a graceful stop: the backup is in the bucket' },
  { id: '8.2.access', label: 'A workspace admin who is not the owner is refused on every backup route' },
  { id: '8.2.board-copy', label: 'Restore a board as a copy (and the deleted-team case)' },
  { id: '8.2.restore-whole', label: 'Whole restore: 202, maintenance, exit 75, restart, signed out, backup data' },
  { id: '8.2.retention', label: 'Old data kept 7 days, or until the next successful backup on a full disk' },
  { id: '8.2.restoring-screen', label: 'The Restoring… screen in a browser', note: 'not done (headless Chromium shot not built in this pass)' },
  { id: '8.2.disaster', label: 'Data directory lost: empty server, same bucket and key, restore the newest' },
  { id: '8.2.wrong-key', label: 'Another key: every backup unreadable with the reason, nothing restored' },
  { id: '8.2.damaged', label: 'One flipped byte: the restore refuses before changing anything' },
  { id: '8.2.key-rotation', label: 'KEY + KEY_PREVIOUS: new key id, full upload, old backups readable' },
  { id: '8.2.no-secret', label: 'No key, S3 secret or signature in logs, audit log or status' },
  { id: '8.2.verify-repair', label: 'A missing object: the prune reports it, the next run repairs it' },
  { id: '8.2.verify-deep', label: 'Daily deep verify finds a damaged object', note: 'not rehearsed locally (no trigger without a new hook)' },
  { id: '8.1.adopt-copy', label: '8.1 local analogue: a copied data directory on a new Fly volume id is adopted' },
];

const TITLE_ID = /^\[([0-9.]+\.[a-z-]+|setup\.[a-z-]+)\]/;

/**
 * The checklist rows from a vitest JSON report: per box the tests whose title starts with its id, passed only when all
 * of them passed; a box with no test prints its note. `setup.*` rows come first.
 * @param {{ testResults: { assertionResults: { title: string, status: string, duration?: number, failureMessages?: string[] }[] }[] }} report
 */
export function checklist(report) {
  const tests = report.testResults.flatMap((f) => f.assertionResults);
  const byId = new Map();
  for (const t of tests) {
    const m = TITLE_ID.exec(t.title);
    if (!m) continue;
    if (!byId.has(m[1])) byId.set(m[1], []);
    byId.get(m[1]).push(t);
  }
  const setups = [...byId.keys()].filter((id) => id.startsWith('setup.')).map((id) => ({ id, label: 'Seed the workspace' }));
  return [...setups, ...BOXES].map((box) => {
    const own = byId.get(box.id) ?? [];
    if (!own.length) return { ...box, status: box.note ? 'noted' : 'missing', ms: 0, problems: [] };
    const failed = own.filter((t) => t.status === 'failed');
    const skipped = own.every((t) => t.status === 'skipped' || t.status === 'pending' || t.status === 'todo');
    return {
      ...box,
      status: failed.length ? 'failed' : skipped ? 'skipped' : 'passed',
      ms: own.reduce((n, t) => n + (t.duration ?? 0), 0),
      problems: failed.map((t) => `${t.title}: ${(t.failureMessages?.[0] ?? '').split('\n')[0]}`),
    };
  });
}

const mark = { passed: '[x]', failed: '[!]', skipped: '[-]', noted: '[-]', missing: '[!]' };

export function render(rows, measured, { date = new Date() } = {}) {
  const lines = ['', 'Restore drill, local rehearsal (runbook section 8)', ''];
  for (const r of rows) {
    const what = r.status === 'noted' ? r.note : r.status === 'missing' ? 'failed: no test ran for this box' : `${r.status} in ${(r.ms / 1000).toFixed(1)} s`;
    lines.push(`${mark[r.status]} ${r.id.padEnd(22)} ${r.label}`);
    lines.push(`    ${what}`);
  }
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'missing');
  const differed = rows.filter((r) => r.status === 'noted' || r.status === 'skipped').map((r) => `${r.id}: ${r.note ?? 'skipped'}`);
  const fmt = (v, unit) => (v === undefined ? 'not measured' : `${v} ${unit}`);
  lines.push(
    '',
    'Drill record',
    '  Drill type:               local',
    `  Date:                     ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '  Who:                      local script (npm run drill:local)',
    '  Workspace / app / bucket: local relay + fake S3',
    `  Data age at restore:      ${fmt(measured.dataAgeAtRestoreSeconds, 's')} (local only, not representative)`,
    `  Time to restore:          whole ${fmt(measured.wholeRestoreSeconds, 's')}, disaster ${fmt(measured.disasterRestoreSeconds, 's')} (local only, not representative)`,
    '  Steps that differed:      relays and S3 are local; settle 1 s; the whole restore goes back to the newest backup',
    '                            (retention keeps one per hour); wrong key, damaged and the full-disk branch use a',
    '                            copy of the bucket' + (differed.length ? '; ' : ''),
    ...differed.map((d) => `                            ${d}`),
    `  Problems found:           ${failed.length ? '' : 'none'}`,
    ...failed.flatMap((r) => (r.problems.length ? r.problems : [`${r.id}: no test ran`]).map((p) => `    - ${p}`)),
    `  Result:                   ${failed.length ? 'failed' : 'passed'}`,
    '',
  );
  return lines.join('\n');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-drill-run-'));
  const reportFile = path.join(tmp, 'vitest.json');
  const measuredFile = path.join(tmp, 'measured.json');
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [vitestBin, 'run', '--config', 'vitest.drill.config.ts', '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`], {
      cwd: root,
      env: { ...process.env, DRILL_REPORT_FILE: measuredFile },
      stdio: 'inherit',
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    console.error(`drill:local: vitest wrote no report (exit ${code})`);
    process.exit(1);
  }
  let measured = {};
  try {
    measured = JSON.parse(fs.readFileSync(measuredFile, 'utf8'));
  } catch {
    /* nothing measured: the record says so */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const rows = checklist(report);
  console.log(render(rows, measured));
  console.log(`Total drill time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const bad = rows.some((r) => r.status === 'failed' || r.status === 'missing') || code !== 0;
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
