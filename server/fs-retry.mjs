// Atomic saves write a .tmp file and rename it over the target. On Windows that rename fails with EPERM, EBUSY or EACCES
// while another handle (a virus scanner, a backup copy, an editor, a test reading the file) has the target open, and the
// handle is gone a moment later. Retry with a short backoff instead of failing the save.
import fs from 'node:fs';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Blocks the thread for `ms`; the saves that use it are synchronous on purpose. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * fs.renameSync that retries EPERM, EBUSY and EACCES up to `attempts` times (10, 20, 40 ... capped at 200 ms, about 1.3 s
 * in all), then throws the last error. Any other error is thrown at once.
 * @param {string} from
 * @param {string} to
 * @param {{ rename?: (from: string, to: string) => void, sleep?: (ms: number) => void, attempts?: number, baseMs?: number }} [options]
 */
export function renameSyncRetry(from, to, { rename = fs.renameSync, sleep = sleepSync, attempts = 10, baseMs = 10 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts || !RETRYABLE.has(err?.code)) throw err;
      sleep(Math.min(200, baseMs * 2 ** (attempt - 1)));
    }
  }
}
