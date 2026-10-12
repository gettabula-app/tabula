// How many bytes the data directory holds, for the data_bytes gauge. It never blocks the event loop: the directory is read as a stream
// (entry by entry, never a whole listing at once) in the background, the answer is kept for ten minutes, and a directory with more than
// MAX_ENTRIES entries (a data dir pointed at something huge) gives null instead of a long walk on every report.
import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_BYTES_TTL_MS = 10 * 60 * 1000;
export const DATA_BYTES_MAX_ENTRIES = 20_000;

export function createDataBytes({ dir, now = Date.now, ttlMs = DATA_BYTES_TTL_MS, maxEntries = DATA_BYTES_MAX_ENTRIES }) {
  let cached = null;
  let running = null;

  async function walk() {
    let bytes = 0;
    let seen = 0;
    const pending = [dir];
    try {
      while (pending.length) {
        const here = pending.pop();
        const handle = await fs.opendir(here);
        try {
          for await (const entry of handle) {
            if (++seen > maxEntries) return null;
            const file = path.join(here, entry.name);
            if (entry.isDirectory()) pending.push(file);
            else if (entry.isFile()) {
              bytes += (await fs.stat(file)).size;
              if (!Number.isSafeInteger(bytes)) return Number.MAX_SAFE_INTEGER;
            }
          }
        } finally {
          await handle.close().catch(() => undefined);
        }
      }
      return bytes;
    } catch {
      return null;
    }
  }

  /** Walks again now (once at a time) and resolves to the answer. */
  function refresh() {
    running ??= walk().then((value) => {
      cached = { at: now(), value };
      return value;
    }).finally(() => { running = null; });
    return running;
  }

  /** The last answer (null before the first walk has finished). An answer older than the TTL starts a new walk in the background. */
  function dataBytesOnDisk() {
    const at = now();
    if (!cached || at < cached.at || at - cached.at >= ttlMs) void refresh();
    return cached ? cached.value : null;
  }
  /** Resolves to the last answer, walking first only when there has never been one. */
  dataBytesOnDisk.ready = () => (cached ? Promise.resolve(cached.value) : refresh());
  dataBytesOnDisk.refresh = refresh;
  return dataBytesOnDisk;
}
