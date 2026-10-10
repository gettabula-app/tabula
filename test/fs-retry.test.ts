import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameSyncRetry } from '../server/fs-retry.mjs';

// Windows refuses to rename over a file that another handle has open (EPERM, EBUSY, EACCES) and lets go a moment later.
const failing = (code: string, times: number) => {
  let calls = 0;
  const waits: number[] = [];
  return {
    calls: () => calls,
    waits,
    rename: () => {
      calls++;
      if (calls <= times) throw Object.assign(new Error(code), { code });
    },
    sleep: (ms: number) => waits.push(ms),
  };
};

describe('renameSyncRetry', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries %s with a growing, capped wait until the rename works', (code) => {
    const f = failing(code, 3);
    renameSyncRetry('a', 'b', { rename: f.rename, sleep: f.sleep });
    expect(f.calls()).toBe(4);
    expect(f.waits).toEqual([10, 20, 40]);
  });

  it('gives up after the attempts and throws the last error', () => {
    const f = failing('EPERM', 99);
    expect(() => renameSyncRetry('a', 'b', { rename: f.rename, sleep: f.sleep, attempts: 5 })).toThrow('EPERM');
    expect(f.calls()).toBe(5);
    expect(f.waits).toEqual([10, 20, 40, 80]);
  });

  it('caps the wait at 200 ms and never waits more than about 1.5 s in all', () => {
    const f = failing('EBUSY', 99);
    expect(() => renameSyncRetry('a', 'b', { rename: f.rename, sleep: f.sleep })).toThrow('EBUSY');
    expect(Math.max(...f.waits)).toBe(200);
    expect(f.waits.reduce((a, b) => a + b, 0)).toBeLessThan(2000);
  });

  it('does not retry any other error', () => {
    const f = failing('ENOENT', 99);
    expect(() => renameSyncRetry('a', 'b', { rename: f.rename, sleep: f.sleep })).toThrow('ENOENT');
    expect(f.calls()).toBe(1);
    expect(f.waits).toEqual([]);
  });

  it('renames a real file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-retry-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.tmp'), 'new');
      fs.writeFileSync(path.join(dir, 'x'), 'old');
      renameSyncRetry(path.join(dir, 'x.tmp'), path.join(dir, 'x'));
      expect(fs.readFileSync(path.join(dir, 'x'), 'utf8')).toBe('new');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
