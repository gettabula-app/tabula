import { describe, expect, it } from 'vitest';
import { MAX_RECHECKS, fileTimes, overBudget, recheck, summary, testTimes } from '../scripts/test-timings.mjs';

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

describe('measuring the tests over budget once more', () => {
  const row = (test: string, seconds: number) => ({ file: 'test/restore-guards.test.ts', test, seconds, limit: 30 });

  it('counts a test that is within its limit the second time as a stalled sample, with both times', () => {
    const asked: string[][] = [];
    const out = recheck([row('one restore at a time', 31.3)], (file: string, test: string) => (asked.push([file, test]), 0.4));
    expect(asked).toEqual([['test/restore-guards.test.ts', 'one restore at a time']]);
    expect(out.confirmed).toEqual([]);
    expect(out.stalled).toEqual([{ ...row('one restore at a time', 31.3), again: 0.4 }]);
  });

  it('keeps a test that is over its limit the second time too', () => {
    const out = recheck([row('slow', 44), row('also slow', 35)], (_file: string, test: string) => (test === 'slow' ? 33 : 2));
    expect(out.confirmed).toEqual([{ ...row('slow', 44), again: 33 }]);
    expect(out.stalled.map((t) => (t as { test: string }).test)).toEqual(['also slow']);
  });

  it('keeps a test that could not be measured again, and one exactly at its limit is within it', () => {
    expect(recheck([row('gone', 40)], () => null).confirmed).toEqual([{ ...row('gone', 40), again: null }]);
    expect(recheck([row('edge', 40)], () => 30).stalled).toHaveLength(1);
  });

  it('measures each test once, and not at all when more than a few are over: that is a pattern, not a stall', () => {
    let calls = 0;
    const many = Array.from({ length: MAX_RECHECKS + 1 }, (_, i) => row(`t${i}`, 40));
    const out = recheck(many, () => (calls++, 1));
    expect(calls).toBe(0);
    expect(out.confirmed).toHaveLength(MAX_RECHECKS + 1);
    expect(out.stalled).toEqual([]);
    recheck(many.slice(0, MAX_RECHECKS), () => (calls++, 1));
    expect(calls).toBe(MAX_RECHECKS);
  });
});
