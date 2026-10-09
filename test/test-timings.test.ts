import { describe, expect, it } from 'vitest';
import { fileTimes, overBudget, summary, testTimes } from '../scripts/test-timings.mjs';

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

describe('the per-test timing budget', () => {
  const run = { testResults: [
    { name: '/repo/test/restore-swap.test.ts', assertionResults: [
      { fullName: 'a swap leaves the data wholly old or wholly new', duration: 37_000 },
      { fullName: 'a swap is quick', duration: 400 },
    ] },
    { name: '/repo/test/relay-save.test.ts', assertionResults: [{ fullName: 'saves within about 30 seconds', duration: 30_300 }] },
    { name: '/repo/test/odd.test.ts', assertionResults: [{ fullName: 'no duration' }] },
  ] };

  it('lists tests slowest first, with the file and the full name', () => {
    expect(testTimes(run, '/repo').map((t: { file: string; seconds: number }) => [t.file, t.seconds])).toEqual([
      ['test/restore-swap.test.ts', 37],
      ['test/relay-save.test.ts', 30.3],
      ['test/restore-swap.test.ts', 0.4],
    ]);
  });

  it('reports the tests over the limit, each with the limit it broke', () => {
    expect(overBudget(testTimes(run, '/repo'), { maxTestSeconds: 30 })).toEqual([
      { file: 'test/restore-swap.test.ts', test: 'a swap leaves the data wholly old or wholly new', seconds: 37, limit: 30 },
      { file: 'test/relay-save.test.ts', test: 'saves within about 30 seconds', seconds: 30.3, limit: 30 },
    ]);
    expect(overBudget(testTimes(run, '/repo'), { maxTestSeconds: 45 })).toEqual([]);
  });

  it('gives an exempted test its own limit, matched by file and part of the name', () => {
    const budget = { maxTestSeconds: 30, exempt: [{ file: 'relay-save.test.ts', test: 'within about 30 seconds', maxSeconds: 40, reason: 'waits for the 30 s save by design' }] };
    expect(overBudget(testTimes(run, '/repo'), budget).map((t: { file: string }) => t.file)).toEqual(['test/restore-swap.test.ts']);
  });

  it('refuses a budget without a positive limit, and an exemption without a limit or a reason', () => {
    expect(() => overBudget([], {})).toThrow(/maxTestSeconds/);
    expect(() => overBudget([], { maxTestSeconds: 0 })).toThrow(/maxTestSeconds/);
    expect(() => overBudget([], { maxTestSeconds: 30, exempt: [{ file: 'a', test: 'b', maxSeconds: 40 }] })).toThrow(/reason/);
    expect(() => overBudget([], { maxTestSeconds: 30, exempt: [{ file: 'a', test: 'b', maxSeconds: 0, reason: 'x' }] })).toThrow(/maxSeconds/);
  });
});
