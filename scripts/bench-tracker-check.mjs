// Not part of the test suite. Builds a throwaway directory.sqlite with N tickets and 5N events and times
// checkTrackerData on it (docs/tracker-s7.md, 4.1). Usage: node scripts/bench-tracker-check.mjs [tickets] [events]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { openDirectory } from '../server/directory.mjs';
import { checkTrackerData } from '../server/tracker/backup-check.mjs';
import { CHECK_JOB } from '../server/tracker/backup-check-worker.mjs';

const tickets = Number(process.argv[2] ?? 100_000);
const events = Number(process.argv[3] ?? 500_000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-bench-'));
const file = path.join(dir, 'directory.sqlite');
try {
  openDirectory(file).close();
  const db = new DatabaseSync(file);
  const state = db.prepare('SELECT id FROM ticket_states ORDER BY position LIMIT 1').get().id;
  db.exec('PRAGMA foreign_keys = ON; BEGIN');
  const addTicket = db.prepare(`INSERT INTO tickets (id, prefix, number, key, title, state_id, tracker_id, created_at, updated_at, created_by_type, updated_seq)
    VALUES (?, 'TAB', ?, ?, ?, ?, 'trk_default', 1, 1, 'user', ?)`);
  const addEvent = db.prepare(`INSERT INTO ticket_events (ticket_id, event_type, schema_version, actor_type, source, created_at) VALUES (?, 'updated', 1, 'user', 'bench', 1)`);
  for (let i = 1; i <= tickets; i++) addTicket.run(`t${i}`, i, `TAB-${i}`, `title ${i}`, state, 1);
  for (let i = 0; i < events; i++) addEvent.run(`t${(i % tickets) + 1}`);
  const addAlias = db.prepare("INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, created_at) VALUES (?, ?, 'linear', ?, ?, 1)");
  for (let i = 1; i <= Math.floor(tickets / 5); i++) addAlias.run(`a${i}`, `t${i}`, `ext-${i}`, `OLD-${i}`);
  db.exec(`UPDATE tickets SET updated_seq = (SELECT MAX(id) FROM ticket_events WHERE ticket_id = tickets.id)`);
  db.exec(`UPDATE ticket_counters SET next_number = ${tickets + 1} WHERE prefix = 'TAB'`);
  db.exec('COMMIT');
  db.close();
  const ro = new DatabaseSync(file, { readOnly: true });
  try {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const start = process.hrtime.bigint();
      const result = checkTrackerData(ro);
      runs.push(Number(process.hrtime.bigint() - start) / 1e6);
      if (i === 0) console.log(`tickets=${result.summary?.tickets} events=${result.summary?.events} findings=${JSON.stringify(result.findings)}`);
    }
    console.log(`checkTrackerData ms per run: ${runs.map((ms) => ms.toFixed(0)).join(', ')} (first run is cold)`);
    // The same check as backup.mjs runs it: in a one-shot worker. How long the main thread's event loop stalls meanwhile.
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const t = performance.now();
      worst = Math.max(worst, t - last - 10);
      last = t;
    }, 10);
    const started = performance.now();
    await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../server/tracker/backup-check-worker.mjs', import.meta.url), {
        workerData: { job: CHECK_JOB, file, at: Date.now() }, env: {}, execArgv: ['--disable-warning=ExperimentalWarning'],
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    clearInterval(tick);
    console.log(`in a worker: ${(performance.now() - started).toFixed(0)} ms wall, worst main-thread event loop stall ${Math.max(0, worst).toFixed(0)} ms`);
  } finally {
    ro.close();
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
