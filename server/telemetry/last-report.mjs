// The last hourly report of a hosted workspace, kept in one small file so a machine that stops (Fly autostop) can still hand it to the control
// plane after its next start. Same scrubbed document the route serves, so it holds counts only: no content, no identifier of a person.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { scrubReport } from './scrub.mjs';
import { TELEMETRY_SCHEMA } from './schema.mjs';

export const LAST_REPORT_FILE = 'telemetry-last.json';
const HOUR_MS = 3_600_000;

/** @param {{ dir: string, workspace: () => string | null, log?: (line: string) => void }} options */
export function createLastReport({ dir, workspace, log = () => {} }) {
  const file = path.join(dir, LAST_REPORT_FILE);
  const tmp = `${file}.tmp`;
  let cached;

  function valid(report) {
    if (report === null || typeof report !== 'object' || Array.isArray(report)) return false;
    if (!Number.isSafeInteger(report.hour) || report.hour < 0 || report.hour % HOUR_MS !== 0) return false;
    if (report.workspace !== workspace()) return false; // a volume that moved to another workspace must not hand out the old one's numbers
    const text = JSON.stringify(report);
    if (Buffer.byteLength(text) > TELEMETRY_SCHEMA.limits.maxBytes) return false;
    try {
      return isDeepStrictEqual(scrubReport(report).clean, report); // exactly what the scrubber would let through
    } catch {
      return false;
    }
  }

  /** The stored report, or null when there is none or it is not one this instance would hand out. Read once, then kept. */
  function read() {
    if (cached !== undefined) return cached;
    cached = null;
    try {
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (valid(report)) cached = report;
      else log('api: the stored telemetry report was not valid and is ignored');
    } catch (err) {
      if (err?.code !== 'ENOENT') log('api: the stored telemetry report could not be read and is ignored');
    }
    return cached;
  }

  /** Atomic (a temporary file, then a rename), synchronous and small: safe to call while the process is shutting down. */
  function write(report) {
    if (!valid(report)) return false;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(report));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      cached = report;
      return true;
    } catch (err) {
      log(`api: could not store the telemetry report (${String(err?.code ?? 'error').slice(0, 20)})`);
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
      return false;
    }
  }

  function remove() {
    cached = null;
    try { fs.rmSync(file, { force: true }); fs.rmSync(tmp, { force: true }); } catch { /* the next start tries again */ }
  }

  return { read, write, remove, file };
}
