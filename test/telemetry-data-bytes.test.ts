import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_BYTES_MAX_ENTRIES, DATA_BYTES_TTL_MS, createDataBytes } from '../server/telemetry/data-bytes.mjs';

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabula-bytes-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));

describe('data_bytes', () => {
  it('adds up the files below the directory', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'x'), 'x'.repeat(10));
    writeFileSync(join(dir, 'a', 'y'), 'y'.repeat(5));
    expect(await createDataBytes({ dir }).refresh()).toBe(15);
  });

  it('keeps the answer for ten minutes, then walks again in the background', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'x'), 'x'.repeat(10));
    let t = 1_000;
    const bytes = createDataBytes({ dir, now: () => t });
    expect(bytes()).toBeNull(); // the first answer is not ready yet: nothing blocks to get it
    await bytes.refresh();
    expect(bytes()).toBe(10);
    writeFileSync(join(dir, 'z'), 'z'.repeat(7));
    t += DATA_BYTES_TTL_MS - 1;
    expect(bytes()).toBe(10); // still the old answer, and no new walk
    t += 1;
    expect(bytes()).toBe(10); // the old answer is served while the new walk runs
    await bytes.refresh();
    expect(bytes()).toBe(17);
  });

  it('returns null past the entry cap, reading the directory as a stream, and keeps that answer for the ten minutes too', async () => {
    const dir = tmp();
    for (let i = 0; i < 6; i += 1) writeFileSync(join(dir, `f${i}`), 'x');
    let t = 0;
    const bytes = createDataBytes({ dir, now: () => t, maxEntries: 5 });
    expect(await bytes.refresh()).toBeNull();
    rmSync(join(dir, 'f0'));
    rmSync(join(dir, 'f1'));
    expect(bytes()).toBeNull(); // cached: no second walk
    t += DATA_BYTES_TTL_MS;
    await bytes.refresh();
    expect(bytes()).toBe(4);
  });

  it('does not hold the event loop: a walk of many files lets other work run in between', async () => {
    const dir = tmp();
    for (let i = 0; i < 300; i += 1) writeFileSync(join(dir, `f${i}`), 'x');
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 0);
    await createDataBytes({ dir }).refresh();
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  it('runs one walk at a time', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'x'), 'xx');
    const bytes = createDataBytes({ dir });
    const [a, b] = await Promise.all([bytes.refresh(), bytes.refresh()]);
    expect([a, b]).toEqual([2, 2]);
  });

  it('has a cap that is a fixed, large number', () => {
    expect(DATA_BYTES_MAX_ENTRIES).toBe(20_000);
  });

  it('returns null when the directory cannot be read', async () => {
    expect(await createDataBytes({ dir: join(tmp(), 'missing') }).refresh()).toBeNull();
  });
});
