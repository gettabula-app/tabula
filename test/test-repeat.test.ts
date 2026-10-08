import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDuration, formatRun, formatSummary, judgeRun, parseArgs, selectFiles, summarise } from '../scripts/test-repeat.mjs';

// scripts/test-repeat.mjs, the flake gate (npm run test:repeat). Its pure parts: arguments, the choice of files from
// git's output and the verdict and summary from vitest's JSON report. The vitest runs themselves are not started here.

const script = fileURLToPath(new URL('../scripts/test-repeat.mjs', import.meta.url));
const repo = path.dirname(path.dirname(script));

describe('test-repeat arguments', () => {
  it('runs 20 times on the files it is given by default', () => {
    expect(parseArgs([])).toEqual({ files: [], times: 20, platform: undefined, bail: false, help: false });
    expect(parseArgs(['test/a.test.ts', 'test/b.test.ts']).files).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });

  it('reads the options in any position, with a space or an equals sign', () => {
    expect(parseArgs(['--times', '5', 'test/a.test.ts', '--platform', 'win32', '--bail'])).toEqual({
      files: ['test/a.test.ts'], times: 5, platform: 'win32', bail: true, help: false,
    });
    expect(parseArgs(['--bail', '--times=12', '--platform=win32', 'test/a.test.ts'])).toEqual({
      files: ['test/a.test.ts'], times: 12, platform: 'win32', bail: true, help: false,
    });
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('refuses a count that is not a whole number from 1 to 9999', () => {
    for (const bad of ['0', '-3', '1.5', 'many', '', '10000', '1e3']) {
      expect(() => parseArgs(['--times', bad])).toThrow(`--times must be a whole number from 1 to 9999, got "${bad}"`);
    }
    expect(parseArgs(['--times', '9999']).times).toBe(9999);
  });

  it('refuses a missing value, another platform and options it does not know', () => {
    expect(() => parseArgs(['--times'])).toThrow('--times needs a value');
    expect(() => parseArgs(['--times', '--bail'])).toThrow('--times needs a value');
    expect(() => parseArgs(['--platform'])).toThrow('--platform needs a value');
    expect(() => parseArgs(['--platform', 'linux'])).toThrow('--platform supports only win32, got "linux"');
    expect(() => parseArgs(['--bail=yes'])).toThrow('--bail takes no value');
    expect(() => parseArgs(['--reporter=dot'])).toThrow('unknown option --reporter=dot');
    expect(() => parseArgs(['-x'])).toThrow('unknown option -x');
  });
});

describe('test-repeat file selection', () => {
  const diff = (...paths: string[]) => paths.map((p) => `${p}\0`).join('');
  const status = (...entries: string[]) => entries.map((e) => `${e}\0`).join('');

  it('takes the test files of the committed diff, sorted, and leaves helpers and other files out', () => {
    expect(selectFiles(diff('test/relay.test.ts', 'test/backup-harness.ts', 'test/platform.ts', 'test/ai-keys.test.ts'), '')).toEqual([
      'test/ai-keys.test.ts',
      'test/relay.test.ts',
    ]);
  });

  it('adds the uncommitted new and modified test files from the porcelain status', () => {
    const out = status('?? test/new.test.ts', ' M test/edited.test.ts', 'M  test/staged.test.ts', 'A  test/added.test.ts', 'MM test/both.test.ts', ' M src/app.ts', '?? scripts/bench.mjs');
    expect(selectFiles('', out)).toEqual(['test/added.test.ts', 'test/both.test.ts', 'test/edited.test.ts', 'test/new.test.ts', 'test/staged.test.ts']);
  });

  it('drops deleted files and takes the new name of a renamed one', () => {
    const out = status(' D test/gone.test.ts', 'D  test/removed.test.ts', 'R  test/after.test.ts', 'test/before.test.ts', '?? test/next.test.ts');
    expect(selectFiles('', out)).toEqual(['test/after.test.ts', 'test/next.test.ts']);
  });

  it('lists a file once when it is both committed and edited again', () => {
    expect(selectFiles(diff('test/a.test.ts', 'test/b.test.ts'), status(' M test/a.test.ts', '?? test/c.test.ts'))).toEqual([
      'test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts',
    ]);
  });

  it('finds nothing in empty output', () => {
    expect(selectFiles('', '')).toEqual([]);
    expect(selectFiles('\0', '\0')).toEqual([]);
  });
});

describe('test-repeat verdict and summary', () => {
  const root = path.resolve('/repo');
  const abs = (file: string) => path.join(root, file);
  const A = 'test/a.test.ts';
  const B = 'test/b.test.ts';

  type Test = { status: string; fullName: string; failureMessages?: string[] };
  const file = (name: string, tests: Test[], extra: { status?: string; message?: string } = {}) => ({
    name: abs(name),
    status: extra.status ?? (tests.some((t) => t.status === 'failed') ? 'failed' : 'passed'),
    ...(extra.message ? { message: extra.message } : {}),
    assertionResults: tests,
  });
  const pass = (fullName: string): Test => ({ status: 'passed', fullName, failureMessages: [] });
  const fail = (fullName: string, message: string): Test => ({ status: 'failed', fullName, failureMessages: [message] });
  const judge = (testResults: ReturnType<typeof file>[] | null, exitCode: number | null, files = [A, B]) =>
    judgeRun({ report: testResults && { testResults }, exitCode, files: files.map(abs), root });

  it('passes a run in which every requested file ran and nothing failed', () => {
    const verdict = judge([file(A, [pass('a one'), pass('a two')]), file(B, [pass('b one')])], 0);
    expect(verdict).toEqual({ ok: true, passed: 3, failed: 0, skipped: 0, failures: [], problems: [] });
  });

  it('counts skipped, pending and todo tests as not failed', () => {
    const tests = [pass('ran'), { status: 'skipped', fullName: 'skipped on this platform' }, { status: 'pending', fullName: 'pending' }, { status: 'todo', fullName: 'todo' }];
    expect(judge([file(A, tests)], 0, [A])).toMatchObject({ ok: true, passed: 1, failed: 0, skipped: 3 });
  });

  it('names each failed test with the first line of its message', () => {
    const verdict = judge([file(A, [pass('fine'), fail('relay saves on stop', 'AssertionError: expected 1 to be 2\n    at test/a.test.ts:10:5')]), file(B, [pass('ok')])], 1);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ passed: 2, failed: 1, problems: [] });
    expect(verdict.failures).toEqual([{ file: A, name: 'relay saves on stop', message: 'AssertionError: expected 1 to be 2' }]);
  });

  it('reports a file that failed to run when none of its tests is marked failed', () => {
    const verdict = judge([file(A, [], { status: 'failed', message: '\nError: Cannot find module "./gone"\n    at x' }), file(B, [pass('ok')])], 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual([{ file: A, name: '(the file failed to run)', message: 'Error: Cannot find module "./gone"' }]);
  });

  it('is not a pass without a report, or when a requested file has no results', () => {
    expect(judge(null, 1)).toMatchObject({ ok: false, problems: ['vitest wrote no JSON report'] });
    const missing = judge([file(A, [pass('ok')])], 0);
    expect(missing.ok).toBe(false);
    expect(missing.problems).toEqual([expect.stringContaining('no results for test/b.test.ts')]);
    expect(judge([], 1, [A]).problems).toEqual([expect.stringContaining('no results for test/a.test.ts')]);
  });

  it('is not a pass when vitest exits non-zero although the report shows no failure', () => {
    const verdict = judge([file(A, [pass('ok')])], 1, [A]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([expect.stringContaining('exited with code 1 but reported no failed test')]);
    expect(judge([file(A, [pass('ok')])], null, [A]).problems).toEqual([expect.stringContaining('exited with a signal')]);
  });

  type RunInput = { index: number; ok: boolean; durationMs: number; failures?: { name: string; file?: string; message?: string }[]; problems?: string[] };
  const run = ({ index, ok, durationMs, failures = [], problems = [] }: RunInput) => ({
    index, ok, durationMs, output: '', passed: 4, failed: failures.length, skipped: 0, problems,
    failures: failures.map((f) => ({ file: f.file ?? A, name: f.name, message: f.message ?? '' })),
  });

  it('collects every failed test with the runs it failed in, and adds the time up', () => {
    const summary = summarise([
      run({ index: 1, ok: true, durationMs: 10_000 }),
      run({ index: 2, ok: false, durationMs: 20_000, failures: [{ name: 'zeta', message: 'boom' }, { name: 'alpha' }] }),
      run({ index: 3, ok: true, durationMs: 10_000 }),
      run({ index: 4, ok: false, durationMs: 30_000, failures: [{ name: 'zeta', message: 'boom' }] }),
    ], { times: 4 });
    expect(summary).toMatchObject({ planned: 4, runs: 4, failedRuns: [2, 4], totalMs: 70_000, bailed: false, problems: [] });
    expect(summary.failures.map((f) => [f.name, f.runs])).toEqual([['alpha', [2]], ['zeta', [2, 4]]]);
  });

  it('prints a passing summary as one line', () => {
    const summary = summarise([run({ index: 1, ok: true, durationMs: 1_500 }), run({ index: 2, ok: true, durationMs: 2_500 })], { times: 2 });
    expect(formatSummary(summary)).toBe('test-repeat passed: 2 runs, 0 failed, 4.0s total');
    expect(formatSummary(summarise([run({ index: 1, ok: true, durationMs: 800 })], { times: 1 }))).toBe('test-repeat passed: 1 run, 0 failed, 0.8s total');
    expect(formatSummary(summarise([run({ index: 1, ok: true, durationMs: 800 })], { times: 5, interrupted: true }))).toBe(
      'test-repeat incomplete: 1 run, 0 failed, 0.8s total\ninterrupted after run 1 of 5',
    );
  });

  it('prints each failed test with its runs and message, the problems and a bail notice', () => {
    const summary = summarise([
      run({ index: 1, ok: true, durationMs: 60_000 }),
      run({ index: 2, ok: false, durationMs: 192_000, failures: [{ file: B, name: 'b > saves', message: 'Test timed out in 20000ms.' }], problems: ['vitest wrote no JSON report'] }),
    ], { times: 20, bailed: true });
    expect(formatSummary(summary).split('\n')).toEqual([
      'test-repeat FAILED: 2 runs, 1 failed (run 2), 4m12s total',
      'stopped after run 2 of 20 (--bail)',
      'failed tests:',
      '  test/b.test.ts > b > saves',
      '    failed in 1 of 2 runs (2): Test timed out in 20000ms.',
      'problems:',
      '  run 2: vitest wrote no JSON report',
    ]);
  });

  it('gives each run one progress line, then what failed in it', () => {
    expect(formatRun(run({ index: 3, ok: true, durationMs: 12_340 }), 20)).toBe('run 3/20  passed  12.3s  (4 passed)');
    expect(formatRun(run({ index: 4, ok: false, durationMs: 18_000, failures: [{ name: 'x > y' }] }), 20).split('\n')).toEqual([
      'run 4/20  FAILED  18.0s  (4 passed, 1 failed)',
      '    x test/a.test.ts > x > y',
    ]);
  });

  it('writes durations in seconds, minutes or hours', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(12_340)).toBe('12.3s');
    expect(formatDuration(65_000)).toBe('1m05s');
    expect(formatDuration(252_000)).toBe('4m12s');
    expect(formatDuration(3_723_000)).toBe('1h02m');
  });
});

describe('test-repeat command line', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });

  it('prints its usage for --help and exits 0', () => {
    const res = cli('--help');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage: npm run test:repeat');
  });

  it('exits 2 with the reason for a bad option or a file that does not exist, before running anything', () => {
    const bad = cli('--times', '0', 'test/core.test.ts');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--times must be a whole number from 1 to 9999');
    const missing = cli('test/there-is-no-such-file.test.ts');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('not a file: test/there-is-no-such-file.test.ts');
    expect(missing.stdout).toBe('');
  });
});
