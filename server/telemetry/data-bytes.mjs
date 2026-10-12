// How many bytes the data directory holds, for the data_bytes gauge. The walk is bounded: the answer is kept for ten minutes, and a
// directory with more than MAX_ENTRIES entries (a data dir pointed at something huge) gives null instead of a long walk on every report.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_BYTES_TTL_MS = 10 * 60 * 1000;
export const DATA_BYTES_MAX_ENTRIES = 20_000;

export function createDataBytes({ dir, now = Date.now, ttlMs = DATA_BYTES_TTL_MS, maxEntries = DATA_BYTES_MAX_ENTRIES }) {
  let cached = null;
  function walk() {
    let bytes = 0;
    let seen = 0;
    const pending = [dir];
    try {
      while (pending.length) {
        const here = pending.pop();
        for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
          if (++seen > maxEntries) return null;
          const file = path.join(here, entry.name);
          if (entry.isDirectory()) pending.push(file);
          else if (entry.isFile()) {
            bytes += fs.statSync(file).size;
            if (!Number.isSafeInteger(bytes)) return Number.MAX_SAFE_INTEGER;
          }
        }
      }
      return bytes;
    } catch {
      return null;
    }
  }
  return function dataBytesOnDisk() {
    const at = now();
    if (cached && at >= cached.at && at - cached.at < ttlMs) return cached.value;
    cached = { at, value: walk() };
    return cached.value;
  };
}
