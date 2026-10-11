// Runs checkTrackerData on a database file in a one-shot worker thread, so a large tracker never blocks the relay's
// event loop (scripts/bench-tracker-check.mjs measures it). Only Node's own modules and ./backup-check.mjs are imported.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { checkTrackerData } from './backup-check.mjs';

export const CHECK_JOB = 'tabula-tracker-check';

if (!isMainThread && parentPort && workerData?.job === CHECK_JOB) {
  let result;
  let db = null;
  try {
    db = new DatabaseSync(workerData.file, { readOnly: true });
    result = checkTrackerData(db, { at: workerData.at });
  } catch {
    result = { present: true, summary: null, findings: [{ code: 'check_failed', count: 1 }] };
  } finally {
    try { db?.close(); } catch { /* read-only */ }
  }
  parentPort.postMessage({ result });
}
