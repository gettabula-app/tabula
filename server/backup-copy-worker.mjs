// The consistent copy of a SQLite database for the backups (docs/backups.md, When it runs). The engine starts this file
// as a worker thread, so the two slow steps (VACUUM INTO, then the second pass on the copy) do not stop the event loop
// of the server. copyDatabase() is also what the engine runs in its own thread when a worker cannot be started, and what
// the tests compare the worker's output with. Only Node's own modules are imported here: the file runs as it is.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';

export const COPY_JOB = 'tabula-backup-copy';
const ERRNO_RE = /^[A-Z0-9_]{2,40}$/;
const SQLITE_TEXT_RE = /^[A-Za-z0-9 ,.'()-]{1,100}$/;

/**
 * `VACUUM INTO tmp` from the live database, then the engine's own rows are removed from the copy and the copy is
 * vacuumed again, so an unchanged database stays unchanged (the status and audit rows of every run would make the next
 * copy differ). The chat database has none of those tables and is copied as it is.
 * @param {string} source
 * @param {string} tmp
 * @param {string} statusKey the settings key that holds the engine's status
 */
export async function copyDatabase(source, tmp, statusKey) {
  const { DatabaseSync } = await import('node:sqlite');
  const live = new DatabaseSync(source);
  try {
    live.exec('PRAGMA busy_timeout = 5000');
    live.prepare('VACUUM INTO ?').run(tmp);
  } finally {
    live.close();
  }
  const copy = new DatabaseSync(tmp);
  try {
    const has = (table) => copy.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    copy.exec('PRAGMA journal_mode = DELETE');
    if (has('settings')) copy.prepare('DELETE FROM settings WHERE key = ?').run(statusKey);
    if (has('audit')) {
      copy.exec("DELETE FROM audit WHERE action IN ('backup.run', 'backup.failed')");
      if (has('sqlite_sequence')) copy.exec("UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM audit) WHERE name = 'audit'");
    }
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
}

/** What the main thread may learn of a failure: a short code and, for SQLite itself, its own fixed wording. Never a path. */
function failure(err) {
  const code = typeof err?.code === 'string' && ERRNO_RE.test(err.code) ? err.code : 'ERROR';
  const detail = code === 'ERR_SQLITE_ERROR' && typeof err.errstr === 'string' && SQLITE_TEXT_RE.test(err.errstr) ? err.errstr : undefined;
  return { ok: false, code, ...(detail ? { detail } : {}) };
}

if (!isMainThread && parentPort && workerData?.job === COPY_JOB) {
  const port = parentPort;
  // Both database handles are closed before the answer is sent, so the main thread may use (and delete) the file at once.
  copyDatabase(workerData.source, workerData.tmp, workerData.statusKey).then(
    () => port.postMessage({ ok: true }),
    (err) => port.postMessage(failure(err)),
  );
}
