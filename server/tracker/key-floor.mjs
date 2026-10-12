import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPORT_AFTER = 25;
const REPORT_DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_DEBOUNCE_MS = 30_000;
const RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const MAX_COUNTERS = 100;
const MAX_FILE_CHARS = 256 * 1024;
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
export const KEY_FLOOR_CHANGED_EVENT = 'tracker-key-floor-changed';

const counterKey = ({ scope, prefix }) => JSON.stringify([scope, prefix]);
const positiveSafe = (value) => Number.isSafeInteger(value) && value > 0;
const nonNegativeSafe = (value) => Number.isSafeInteger(value) && value >= 0;

function validName(value) {
  return typeof value === 'string' && SAFE_NAME.test(value);
}

function normalizeFloorRows(value, { kind = 'floor' } = {}) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.counters) ? value.counters : [];
  const result = [];
  for (const row of rows) {
    if (!row || !validName(row.scope) || !validName(row.prefix)) continue;
    const floor = kind === 'next' ? row.next : row.floor;
    if (!positiveSafe(floor)) continue;
    result.push({ scope: row.scope, prefix: row.prefix, floor });
  }
  return result;
}

/**
 * Compute the counter floors from the restored snapshot and every optional source.
 * `restored` is `{scope,prefix,next,maxNumber}[]`; the other sources are arrays (or
 * `{counters}`) with `next` for `liveBefore`/`manifestMax` and `floor` for the
 * control plane/file. The control-plane floor gets the 25-key reporting safety
 * jump here. `restoredHasTickets` is optional when the caller can distinguish a
 * ticket-bearing database from an empty database whose counter table is absent.
 * Returns `{ counters: [{scope,prefix,next}], known }`.
 *
 * @param {{restored: Array<{scope:string,prefix:string,next:number,maxNumber:number}>, liveBefore?: unknown, manifestMax?: unknown, controlPlane?: unknown, floorFile?: unknown, restoredHasTickets?: boolean}} input
 */
export function computeKeyFloor({ restored = [], liveBefore, manifestMax, controlPlane, floorFile, restoredHasTickets } = {}) {
  const floors = new Map();
  const add = (scope, prefix, next) => {
    if (!validName(scope) || !validName(prefix) || !positiveSafe(next)) return;
    const key = counterKey({ scope, prefix });
    floors.set(key, { scope, prefix, next: Math.max(next, floors.get(key)?.next ?? 0) });
  };

  for (const row of Array.isArray(restored) ? restored : []) {
    if (!row || !validName(row.scope) || !validName(row.prefix)) continue;
    if (positiveSafe(row.next)) add(row.scope, row.prefix, row.next);
    if (nonNegativeSafe(row.maxNumber) && row.maxNumber < Number.MAX_SAFE_INTEGER) add(row.scope, row.prefix, row.maxNumber + 1);
  }

  const liveRows = normalizeFloorRows(liveBefore, { kind: 'next' });
  const manifestRows = normalizeFloorRows(manifestMax, { kind: 'next' });
  const controlRows = normalizeFloorRows(controlPlane);
  const fileRows = normalizeFloorRows(floorFile);
  for (const row of liveRows) add(row.scope, row.prefix, row.floor);
  for (const row of manifestRows) add(row.scope, row.prefix, row.floor);
  for (const row of controlRows) add(row.scope, row.prefix, Math.min(Number.MAX_SAFE_INTEGER, row.floor + REPORT_AFTER));
  for (const row of fileRows) add(row.scope, row.prefix, row.floor);

  // `known` needs evidence about every counter that has tickets: a row for its (scope, prefix) in an external source.
  // An empty source, or one with other prefixes only, proves nothing; a row below the restored counter proves nothing
  // (control plane rows get the reporting margin); a manifest counts only when it is newer than the restored counter
  // (the restored manifest's own counter is the restored counter).
  const restoredRows = (Array.isArray(restored) ? restored : []).filter((row) => row && validName(row.scope) && validName(row.prefix));
  const restoredNext = new Map(restoredRows.map((row) => [counterKey(row), positiveSafe(row.next) ? row.next : 0]));
  const evidence = new Set();
  // A row proves something only if its value reaches the restored counter: a seeded row with next 1 proves nothing.
  const reaches = (row, value) => value >= (restoredNext.get(counterKey(row)) ?? 0);
  for (const row of [...liveRows, ...fileRows]) if (reaches(row, row.floor)) evidence.add(counterKey(row));
  for (const row of controlRows) if (reaches(row, row.floor + REPORT_AFTER)) evidence.add(counterKey(row));
  for (const row of manifestRows) if (row.floor > (restoredNext.get(counterKey(row)) ?? 0)) evidence.add(counterKey(row));
  const needsEvidence = restoredRows.filter((row) => nonNegativeSafe(row.maxNumber) && row.maxNumber > 0);
  const hasRestoredTickets = restoredHasTickets ?? needsEvidence.length > 0;
  const known = !hasRestoredTickets || (needsEvidence.every((row) => evidence.has(counterKey(row)))
    && (needsEvidence.length > 0 || restoredHasTickets !== true));
  const counters = [...floors.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.prefix.localeCompare(b.prefix));
  return { counters, known };
}

/**
 * Raise every ticket counter past its current high-water mark, plus 1000. Runs inside the caller's transaction
 * (directory.transaction), so the jump, its audit row and the gate marking commit or roll back together.
 */
export function epochJump(db, now = Date.now()) {
  const rows = db.prepare('SELECT scope, prefix, next_number FROM ticket_counters ORDER BY scope, prefix').all();
  const maxFor = db.prepare('SELECT COALESCE(MAX(number), 0) AS max_number FROM tickets WHERE tracker_id = ? AND prefix = ?');
  const update = db.prepare('UPDATE ticket_counters SET next_number = ?, updated_at = ? WHERE scope = ? AND prefix = ?');
  return rows.map((row) => {
    const oldNext = Number(row.next_number);
    const maxNumber = Number(maxFor.get(row.scope, row.prefix).max_number);
    const newNext = Math.max(oldNext, maxNumber + 1) + 1000;
    update.run(newNext, now, row.scope, row.prefix);
    return { scope: row.scope, prefix: row.prefix, oldNext, newNext };
  });
}

function checkedFileData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.counters)
    || !nonNegativeSafe(value.at) || value.counters.length > MAX_COUNTERS) return null;
  const counters = [];
  const seen = new Set();
  for (const row of value.counters) {
    if (!row || !validName(row.scope) || !validName(row.prefix) || !positiveSafe(row.floor)) return null;
    const key = counterKey(row);
    if (seen.has(key)) return null;
    seen.add(key);
    counters.push({ scope: row.scope, prefix: row.prefix, floor: row.floor });
  }
  return { counters, at: value.at };
}

/** Read a self-hosted counter floor file. Missing, oversized or malformed files return null. */
export function readKeyFloorFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_CHARS) return null;
    return checkedFileData(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Atomically replace the self-hosted counter floor file using a temp file in its directory. */
export function writeKeyFloorFile(file, counters, at = Date.now()) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !nonNegativeSafe(at)) throw new TypeError('Invalid key floor file path or time');
  if (!Array.isArray(counters) || counters.length > MAX_COUNTERS) throw new TypeError('Invalid key floor counters');
  const data = checkedFileData({ counters, at });
  if (!data) throw new TypeError('Invalid key floor counters');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function readLiveCounters(directory) {
  try {
    return directory.db.prepare('SELECT scope, prefix, next_number FROM ticket_counters ORDER BY scope, prefix').all()
      .filter((row) => validName(row.scope) && validName(row.prefix) && positiveSafe(Number(row.next_number)))
      .map((row) => ({ scope: row.scope, prefix: row.prefix, next: Number(row.next_number) }));
  } catch {
    return [];
  }
}

/**
 * Queue key-counter evidence without putting network or file IO in a ticket transaction.
 * The `tracker-key-floor-changed` event is trailing-debounced. `flush()` forces a
 * final report and never throws, so a sink failure cannot fail a create or shutdown.
 *
 * @param {any} [options]
 */
export function createKeyFloorReporter({
  directory,
  events,
  cloud = null,
  floorFile = null,
  now = Date.now,
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
  log = () => {},
  debounceMs = REPORT_DEBOUNCE_MS,
  retryMs = RETRY_MS,
} = {}) {
  let debounceTimer = null;
  let retryTimer = null;
  let dailyTimer = null;
  let inFlight = null;
  let closed = false;
  let queued = false;
  let retryIndex = 0;
  const reported = {
    cloud: new Map(),
    file: new Map(),
  };
  const successAt = { cloud: null, file: null };
  const say = (message) => { try { log(message); } catch { /* reporting logs are best-effort too */ } };

  const cancel = (timer) => { if (timer !== null) clearTimer(timer); };
  const armDaily = () => {
    if (closed) return;
    cancel(dailyTimer);
    dailyTimer = setTimer(() => {
      dailyTimer = null;
      void push(true).catch(() => {}).finally(armDaily);
    }, REPORT_DAY_MS);
    dailyTimer?.unref?.();
  };

  function schedule(delay = debounceMs) {
    // A throttle, not a debounce: an armed timer is never re-armed, so a steady stream of creates cannot starve the report.
    if (closed || retryTimer !== null || debounceTimer !== null) return;
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      void push(false).catch(() => {});
    }, delay);
    debounceTimer?.unref?.();
  }

  function due(counters) {
    const sinks = [...(cloud ? ['cloud'] : []), ...(floorFile ? ['file'] : [])];
    if (!sinks.length) return false;
    if (sinks.some((sink) => successAt[sink] === null || now() - successAt[sink] >= REPORT_DAY_MS)) return true;
    return counters.some((row) => sinks.some((sink) => {
      const last = reported[sink].get(counterKey(row));
      return last === undefined || row.next - last >= REPORT_AFTER;
    }));
  }

  // A counter that has advanced REPORT_AFTER past what a sink last saw must be reported now, not after a quiet period.
  function advancedPastReport(counters) {
    const sinks = [...(cloud ? ['cloud'] : []), ...(floorFile ? ['file'] : [])];
    return counters.some((row) => sinks.some((sink) => {
      const last = reported[sink].get(counterKey(row));
      return last !== undefined && row.next - last >= REPORT_AFTER;
    }));
  }

  async function push(force) {
    if (inFlight) return inFlight;
    if (closed && !force) return null;
    const counters = readLiveCounters(directory);
    if (!force && !queued && !due(counters)) return null;
    queued = false;
    cancel(retryTimer);
    retryTimer = null;
    inFlight = (async () => {
      let failed = false;
      if (cloud) {
        try {
          for (let offset = 0; offset < counters.length; offset += MAX_COUNTERS) {
            const batch = counters.slice(offset, offset + MAX_COUNTERS).map(({ scope, prefix, next }) => ({ scope, prefix, floor: next }));
            if (batch.length) await cloud.reportKeyFloor(batch);
          }
          const at = now();
          successAt.cloud = at;
          reported.cloud.clear();
          for (const row of counters) reported.cloud.set(counterKey(row), row.next);
        } catch {
          failed = true;
          say('tracker key floor cloud report failed');
        }
      }
      if (floorFile) {
        try {
          const floors = new Map((readKeyFloorFile(floorFile)?.counters ?? []).map((row) => [counterKey(row), row]));
          for (const row of counters) {
            const key = counterKey(row);
            const prior = floors.get(key);
            floors.set(key, { scope: row.scope, prefix: row.prefix, floor: Math.max(prior?.floor ?? 0, row.next) });
          }
          const fileCounters = [...floors.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.prefix.localeCompare(b.prefix));
          writeKeyFloorFile(floorFile, fileCounters, now());
          const at = now();
          successAt.file = at;
          reported.file.clear();
          for (const row of fileCounters) reported.file.set(counterKey(row), row.floor);
        } catch {
          failed = true;
          say('tracker key floor file report failed');
        }
      }
      if (failed) {
        if (!closed) {
          cancel(debounceTimer);
          debounceTimer = null;
          const delay = retryMs[Math.min(retryIndex, retryMs.length - 1)];
          retryIndex = Math.min(retryIndex + 1, retryMs.length - 1);
          retryTimer = setTimer(() => {
            retryTimer = null;
            void push(true).catch(() => {});
          }, delay);
          retryTimer?.unref?.();
        }
      } else {
        retryIndex = 0;
      }
      return status();
    })().finally(() => {
      inFlight = null;
      // Creates that landed while this report was out may already be 25 past it.
      if (!closed && retryTimer === null) {
        try { if (advancedPastReport(readLiveCounters(directory))) void push(false).catch(() => {}); } catch { /* best effort */ }
      }
    });
    return inFlight;
  }

  function onChanged() {
    try {
      queued = true;
      const counters = readLiveCounters(directory);
      if (advancedPastReport(counters)) {
        cancel(debounceTimer);
        debounceTimer = null;
        void push(false).catch(() => {});
      } else if (due(counters)) schedule();
    } catch { /* key-floor reporting cannot interfere with a committed ticket */ }
  }

  const toReportedRows = (values) => [...values.entries()].map(([key, floor]) => {
      const [scope, prefix] = JSON.parse(key);
      return { scope, prefix, floor };
    });
  const status = () => ({
    cloudLastSuccessAt: successAt.cloud,
    cloudCounters: toReportedRows(reported.cloud),
    fileLastSuccessAt: successAt.file,
    fileCounters: toReportedRows(reported.file),
    queued,
  });

  events?.on?.(KEY_FLOOR_CHANGED_EVENT, onChanged);
  armDaily();
  queued = true;
  schedule(0);

  return {
    status,
    async flush() {
      if (closed) return status();
      cancel(debounceTimer);
      debounceTimer = null;
      cancel(retryTimer);
      retryTimer = null;
      queued = true;
      try {
        if (inFlight) await inFlight.catch(() => {});
        return await push(true);
      } catch { return status(); }
    },
    close() {
      closed = true;
      cancel(debounceTimer);
      cancel(retryTimer);
      cancel(dailyTimer);
      debounceTimer = retryTimer = dailyTimer = null;
      events?.off?.(KEY_FLOOR_CHANGED_EVENT, onChanged);
    },
  };
}
