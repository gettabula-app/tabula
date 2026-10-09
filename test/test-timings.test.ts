import { describe, expect, it } from 'vitest';
import { fileTimes, summary } from '../scripts/test-timings.mjs';

const report = (rows: { name: string; startTime?: number; endTime?: number; status?: string }[]) => ({ testResults: rows });

describe('per-file test times', () => {
  it('turns the report into seconds per file, slowest first, with paths from the root', () => {
    const times = fileTimes(report([
      { name: '/repo/test/a.test.ts', startTime: 1000, endTime: 1500, status: 'passed' },
      { name: '/repo/test/b.test.ts', startTime: 1000, endTime: 9000, status: 'failed' },
      { name: '/repo/test/c.test.ts', startTime: 2000, endTime: 2500, status: 'passed' },
    ]), '/repo');
    expect(times).toEqual([
      { file: 'test/b.test.ts', seconds: 8, status: 'failed' },
      { file: 'test/a.test.ts', seconds: 0.5, status: 'passed' },
      { file: 'test/c.test.ts', seconds: 0.5, status: 'passed' },
    ]);
  });

  it('skips rows without a name or times, and a report that is not one', () => {
    expect(fileTimes(report([{ name: '/r/x.test.ts' }, { name: 5 as unknown as string, startTime: 1, endTime: 2 }]), '/r')).toEqual([]);
    expect(fileTimes(null)).toEqual([]);
    expect(fileTimes({})).toEqual([]);
  });

  it('prints the slowest files with the total, and marks the ones that did not pass', () => {
    const lines = summary([
      { file: 'test/slow.test.ts', seconds: 61.25, status: 'failed' },
      { file: 'test/quick.test.ts', seconds: 0.5, status: 'passed' },
      { file: 'test/other.test.ts', seconds: 0.25, status: 'passed' },
    ], 2);
    expect(lines[0]).toBe('Slowest 2 of 3 test files (62.0 s in all):');
    expect(lines[1]).toMatch(/^ {2}test\/slow\.test\.ts +61\.3 s {2}failed$/);
    expect(lines[2]).toMatch(/^ {2}test\/quick\.test\.ts +0\.5 s$/);
    expect(lines).toHaveLength(3);
  });
});
