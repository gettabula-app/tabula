import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Directory lock (mkdir is atomic, also across containers sharing a volume).
 * A lock older than `staleMs` is taken over, so a crashed holder cannot block the stack forever.
 */
export async function withLock(lockDir, fn, { timeoutMs = 3000, staleMs = 60_000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) { fs.rmdirSync(lockDir); continue; }
      } catch { /* released meanwhile */ }
      if (Date.now() >= deadline) throw Object.assign(new Error('lock timeout'), { code: 'ELOCKED' });
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* already taken over as stale */ }
  }
}
