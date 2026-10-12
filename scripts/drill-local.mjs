#!/usr/bin/env node
// TAB-94: the restore drill of the ops runbook (section 8), rehearsed locally against relays, the fake S3 of the
// backup tests and the off-site puller. Runs test/drill/*.drill.test.ts with vitest.drill.config.ts (they are never part
// of `npm test`), reads vitest's JSON report, and prints a checklist of the runbook boxes and a filled drill record.
//
//   npm run drill:local
//
// Exits 1 when any box failed. docs/backups.md, "Rehearsing a restore locally".
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from '../server/directory.mjs';

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
  { id: '8.3.dir-backup', label: 'A dir-target relay seals a board edit and writes its first manifest' },
  { id: '8.3.export-auth', label: 'Export requires the pull token and hides keys outside objects and manifests' },
  { id: '8.3.pull', label: 'The puller downloads sealed files and writes state and metrics' },
  { id: '8.3.pull-incremental', label: 'Unchanged pulls fetch nothing; a later edit fetches only new files' },
  { id: '8.3.restore-check', label: 'The pulled store passes keyed and structure-only restore checks' },
  { id: '8.3.decrypt-restore', label: 'An empty dir-target relay restores the newest pulled manifest' },
  { id: '8.3.no-secret', label: 'Relay logs, puller logs, metrics and state contain no backup or pull credentials' },
  { id: '8.3.purge', label: 'Deleted workspaces expire after grace; an operator purge erases a copy at once' },
  { id: '8.1.adopt-copy', label: '8.1 local analogue: a copied data directory on a new Fly volume id is adopted' },
];

export const TRACKER_BOXES = [
  { id: 'seed', label: 'Seed tracker data and two linked boards' },
  { id: 'barrier_backup', label: 'Barrier backup has matching counts and no findings' },
  { id: 'restore_workspace', label: 'Restore the earlier whole-workspace snapshot' },
  { id: 'lost_keys_not_reissued', label: 'Lost ticket keys are not issued again' },
  { id: 'gate_cycle', label: 'Restore gate clears after recovery' },
  { id: 'reconcile_boards', label: 'Both linked boards reconcile from SQL' },
  { id: 'search_rebuilt', label: 'Search works after restore' },
  { id: 'hosted_floor_available', label: 'Hosted key floor is available on a new machine' },
  { id: 'hosted_floor_unknown', label: 'Unknown floor stays gated until the owner jumps the epoch' },
  { id: 'board_copy_stripped', label: 'Board copy contains no tracker identity' },
  { id: 'history_restore', label: 'History restore removes a card without a duplicate ticket' },
  { id: 'key_rotation', label: 'Previous key restores; missing key is refused' },
  { id: 'damaged_search', label: 'Damaged search index is rebuilt during recovery' },
  { id: 'missing_room_file', label: 'Missing room file is reconciled after restore' },
  { id: 'schema_too_new', label: 'Newer directory schema is refused without changes' },
  { id: 'no_text_in_logs', label: 'Ticket and comment text stay out of logs and reports' },
  { id: 'slice8_secrets_ciphertext', label: 'Slice 8 secret ciphertext', note: 'not present (slice 8)' },
  { id: 'slice8_inbound_recovered', label: 'Slice 8 inbound event recovery', note: 'not present (slice 8)' },
  { id: 'slice8_delivery_retry_safe', label: 'Slice 8 delivery retry safety', note: 'not present (slice 8)' },
  { id: 'slice8_connection_health', label: 'Slice 8 connection health', note: 'not present (slice 8)' },
];

const TITLE_ID = /^\[(tracker\.[a-z0-9_]+|[0-9.]+\.[a-z-]+|setup\.[a-z-]+)\]/;

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
  const rows = [...setups, ...BOXES].map((box) => {
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
  return [
    ...rows,
    ...TRACKER_BOXES.map((box) => {
      const id = 'tracker.' + box.id;
      const own = byId.get(id) ?? [];
      if (!own.length) return { ...box, id, status: box.note ? 'noted' : 'missing', ms: 0, problems: [], ran: false };
      const failed = own.filter((t) => t.status === 'failed');
      const skipped = own.some((t) => t.status === 'skipped' || t.status === 'pending' || t.status === 'todo');
      return {
        ...box,
        id,
        status: failed.length ? 'failed' : skipped ? 'skipped' : 'passed',
        ms: own.reduce((n, t) => n + (t.duration ?? 0), 0),
        problems: failed.map((t) => t.title + ': ' + (t.failureMessages?.[0] ?? '').split('\n')[0]),
        ran: own.some((t) => !['skipped', 'pending', 'todo'].includes(t.status)),
      };
    }),
  ];
}

const mark = { passed: '[x]', failed: '[!]', skipped: '[-]', noted: '[-]', missing: '[!]' };

export function render(rows, measured, { date = new Date() } = {}) {
  const lines = ['', 'Restore drill, local rehearsal (runbook section 8)', ''];
  let trackerSection = false;
  for (const r of rows) {
    if (r.id.startsWith('tracker.') && !trackerSection) {
      trackerSection = true;
      lines.push('', 'Tracker restore drill', '');
    }
    const what = r.status === 'noted' ? r.note : r.status === 'missing' ? 'failed: no test ran for this box' : `${r.status} in ${(r.ms / 1000).toFixed(1)} s`;
    lines.push(`${mark[r.status]} ${r.id.padEnd(22)} ${r.label}`);
    lines.push(`    ${what}`);
  }
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'missing'
    || (r.id.startsWith('tracker.') && r.status === 'skipped'));
  const differed = rows.filter((r) => r.status === 'noted' || r.status === 'skipped').map((r) => `${r.id}: ${r.note ?? 'skipped'}`);
  const fmt = (v, unit) => (v === undefined ? 'not measured' : `${v} ${unit}`);
  lines.push(
    '',
    'Drill record',
    '  Drill type:               local',
    `  Date:                     ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '  Who:                      local script (npm run drill:local)',
    '  Workspace / app / bucket: local relays, fake S3 and off-site puller store',
    `  Data age at restore:      ${fmt(measured.dataAgeAtRestoreSeconds, 's')} (local only, not representative)`,
    `  Time to restore:          whole ${fmt(measured.wholeRestoreSeconds, 's')}, disaster ${fmt(measured.disasterRestoreSeconds, 's')} (local only, not representative)`,
    '  Steps that differed:      relays, control plane, S3 and pull host are local; puller HTTPS is rewritten to relay HTTP;',
    '                            settle is short; whole and disaster restores use the newest retained manifest; wrong key,',
    '                            damaged and full-disk branches use a copy of the bucket' + (differed.length ? '; ' : ''),
    ...differed.map((d) => `                            ${d}`),
    `  Problems found:           ${failed.length ? '' : 'none'}`,
    ...failed.flatMap((r) => (r.problems.length ? r.problems : [`${r.id}: no test ran`]).map((p) => `    - ${p}`)),
    `  Result:                   ${failed.length ? 'failed' : 'passed'}`,
    '',
  );
  return lines.join('\n');
}

/** The local-only record pasted to POST /api/admin/tracker/drill-record. */
export function buildTrackerDrillRecord(rows, measured = {}, { at = Date.now() } = {}) {
  const trackerRows = new Map(rows.filter((row) => row.id.startsWith('tracker.')).map((row) => [row.id, row]));
  if (![...trackerRows.values()].some((row) => row.ran)) return null;
  const boxes = TRACKER_BOXES.map((box) => {
    if (box.note) return { id: box.id, result: 'not_present' };
    const row = trackerRows.get('tracker.' + box.id);
    return { id: box.id, result: row?.status === 'passed' ? 'pass' : 'fail' };
  });
  return {
    at,
    kind: 'local',
    schema: MIGRATIONS.length,
    restoreSeconds: measured.trackerRestoreSeconds ?? 0,
    dataLossSeconds: measured.trackerDataAgeAtRestoreSeconds ?? 0,
    boxes,
    overall: boxes.every((box) => box.result === 'pass' || box.result === 'not_present') ? 'pass' : 'fail',
  };
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
  const trackerRecord = buildTrackerDrillRecord(rows, measured);
  if (trackerRecord) console.log(JSON.stringify(trackerRecord, null, 2));
  console.log(`Total drill time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const bad = rows.some((r) => r.status === 'failed' || r.status === 'missing'
    || (r.id.startsWith('tracker.') && r.status === 'skipped')) || code !== 0;
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
