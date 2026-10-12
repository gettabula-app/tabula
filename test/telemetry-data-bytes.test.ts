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
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('data_bytes', () => {
  it('adds up the files below the directory', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'x'), 'x'.repeat(10));
    writeFileSync(join(dir, 'a', 'y'), 'y'.repeat(5));
    expect(createDataBytes({ dir })()).toBe(15);
  });

  it('keeps the answer for ten minutes, then walks again', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'x'), 'x'.repeat(10));
    let t = 1_000;
    const bytes = createDataBytes({ dir, now: () => t });
    expect(bytes()).toBe(10);
    writeFileSync(join(dir, 'z'), 'z'.repeat(7));
    t += DATA_BYTES_TTL_MS - 1;
    expect(bytes()).toBe(10); // still the old answer
    t += 1;
    expect(bytes()).toBe(17);
  });

  it('returns null past the entry cap, and keeps that answer for the ten minutes too', () => {
    const dir = tmp();
    for (let i = 0; i < 6; i += 1) writeFileSync(join(dir, `f${i}`), 'x');
    let t = 0;
    const bytes = createDataBytes({ dir, now: () => t, maxEntries: 5 });
    expect(bytes()).toBeNull();
    rmSync(join(dir, 'f0'));
    rmSync(join(dir, 'f1'));
    expect(bytes()).toBeNull(); // cached: no second walk
    t += DATA_BYTES_TTL_MS;
    expect(bytes()).toBe(4);
  });

  it('has a cap that is a fixed, large number', () => {
    expect(DATA_BYTES_MAX_ENTRIES).toBe(20_000);
  });

  it('returns null when the directory cannot be read', () => {
    expect(createDataBytes({ dir: join(tmp(), 'missing') })()).toBeNull();
  });
});
