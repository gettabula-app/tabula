import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.mjs';

export const spoolDir = (lakeDir) => path.join(lakeDir, 'spool');
export const spoolLock = (lakeDir) => path.join(lakeDir, 'spool', '.lock');
export const lakeLock = (lakeDir) => path.join(lakeDir, '.lake-lock');

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const spoolPath = (lakeDir, ms) => path.join(spoolDir(lakeDir), `ingest-${dayOf(ms)}.ndjson`);

/** Append rows as one write under the spool lock, so a concurrent workspace deletion cannot lose or resurrect a line. */
export async function appendRows(lakeDir, rows, now = Date.now()) {
  if (!rows.length) return;
  const lines = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await withLock(spoolLock(lakeDir), () => {
    fs.appendFileSync(spoolPath(lakeDir, now), lines, { mode: 0o640 });
  });
}

/** Spool files, oldest first: `[{ day, file }]`. */
export function listSpool(lakeDir) {
  let names = [];
  try { names = fs.readdirSync(spoolDir(lakeDir)); } catch { return []; }
  return names
    .map((name) => /^ingest-(\d{4}-\d{2}-\d{2})\.ndjson$/u.exec(name))
    .filter(Boolean)
    .map((m) => ({ day: m[1], file: path.join(spoolDir(lakeDir), m[0]) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Remove one workspace's rows from every spool file. Returns the number of rows removed. */
export async function purgeSpool(lakeDir, workspace) {
  let removed = 0;
  for (const { file } of listSpool(lakeDir)) {
    await withLock(spoolLock(lakeDir), () => {
      const kept = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let row = null;
        try { row = JSON.parse(line); } catch { /* keep unparseable lines; they cannot be attributed */ }
        if (row && row.workspace === workspace) removed += 1;
        else kept.push(line);
      }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o640 });
      fs.renameSync(tmp, file);
    }, { timeoutMs: 10_000 });
  }
  return removed;
}
