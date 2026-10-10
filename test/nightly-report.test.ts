import { describe, expect, it } from 'vitest';
import { analyzeOsRuns, overNightlyBudget, relativeTestFile, workflowFailureReasons } from '../scripts/lib/nightly-report.mjs';

const budget = { maxTestSeconds: 1, exempt: [] };
const root = '/repo';

function report(status: string, options: { file?: string; name?: string; duration?: number } = {}) {
  const file = options.file ?? 'test/sample.test.ts';
  return {
    testResults: [{
      name: `${root}/${file}`,
      status: status === 'failed' ? 'failed' : 'passed',
      assertionResults: [{ fullName: options.name ?? 'suite > sample test', status, duration: options.duration ?? 100 }],
    }],
  };
}

function run(status: string, options: { file?: string; name?: string; duration?: number } = {}) {
  return { report: report(status, options), outcome: status === 'failed' ? 'failure' : 'success' };
}

function analyze(statuses: string[], options: { file?: string; name?: string; duration?: number } = {}) {
  return analyzeOsRuns({ os: 'ubuntu-latest', runs: statuses.map((status) => run(status, options)), root, budget });
}

describe('nightly test classification', () => {
  it('normalizes Windows report paths when classifying tests', () => {
    expect(relativeTestFile('C:\\work\\tabula\\test\\sample.test.ts', 'C:\\work\\tabula')).toBe('test/sample.test.ts');
  });

  it('classifies a test that passed all three runs as always-passed', () => {
    const result = analyze(['passed', 'passed', 'passed']);
    expect(result.tests[0]).toMatchObject({ classification: 'always-passed', passedRuns: [1, 2, 3], failedRuns: [] });
    expect(result.infraErrors).toEqual([]);
  });

  it('classifies a test that failed all three runs as always-failed', () => {
    const result = analyze(['failed', 'failed', 'failed']);
    expect(result.tests[0]).toMatchObject({ classification: 'always-failed', failedRuns: [1, 2, 3] });
    expect(workflowFailureReasons({ infraErrors: [], tests: result.tests }).join('\n')).toContain('failed in all three runs');
  });

  it('classifies a mixed pass and failure as FLAKY without failing the workflow by itself', () => {
    const result = analyze(['passed', 'failed', 'passed']);
    expect(result.tests[0]).toMatchObject({ classification: 'FLAKY', failedRuns: [2], passedRuns: [1, 3] });
    expect(workflowFailureReasons({ infraErrors: [], tests: result.tests })).toEqual([]);
  });

  it('reports a missing JSON report as incomplete and an infrastructure error', () => {
    const result = analyzeOsRuns({
      os: 'ubuntu-latest',
      root,
      budget,
      runs: [
        { report: null, error: 'nightly-1.json: ENOENT', outcome: 'failure' },
        run('passed'),
        run('passed'),
      ],
    });
    expect(result.tests[0]).toMatchObject({ classification: 'incomplete', missingRuns: [1] });
    expect(result.infraErrors).toContain('run 1: nightly-1.json: ENOENT');
    expect(result.issueRequired).toBe(true);
  });

  it('keeps skipped tests separate from passes and failures', () => {
    const result = analyze(['pending', 'skipped', 'todo']);
    expect(result.tests[0]).toMatchObject({ classification: 'skipped', skippedRuns: [1, 2, 3] });
    expect(result.counts.skipped).toBe(1);
  });

  it('keeps the same test name in different files as two test identities', () => {
    const first = report('passed', { file: 'test/alpha.test.ts', name: 'same title' });
    const second = report('passed', { file: 'test/beta.test.ts', name: 'same title' });
    const result = analyzeOsRuns({
      os: 'ubuntu-latest', root, budget,
      runs: [
        { report: { testResults: [...first.testResults, ...second.testResults] }, outcome: 'success' },
        { report: { testResults: [...first.testResults, ...second.testResults] }, outcome: 'success' },
        { report: { testResults: [...first.testResults, ...second.testResults] }, outcome: 'success' },
      ],
    });
    expect(result.tests.map(({ file, test, classification }) => [file, test, classification])).toEqual([
      ['test/alpha.test.ts', 'same title', 'always-passed'],
      ['test/beta.test.ts', 'same title', 'always-passed'],
    ]);
  });

  it('uses the CI timing-budget rules and records the slow run over budget', () => {
    const result = analyze(['passed', 'passed', 'passed'], { duration: 1500 });
    expect(result.overBudget).toEqual([{ file: 'test/sample.test.ts', test: 'suite > sample test', seconds: 1.5, run: 1, limit: 1 }, { file: 'test/sample.test.ts', test: 'suite > sample test', seconds: 1.5, run: 2, limit: 1 }, { file: 'test/sample.test.ts', test: 'suite > sample test', seconds: 1.5, run: 3, limit: 1 }]);
    expect(overNightlyBudget([{ file: 'test/relay-save.test.ts', test: 'writes within 30 seconds', seconds: 31 }], {
      maxTestSeconds: 30,
      exempt: [{ file: 'relay-save.test.ts', test: 'within 30 seconds', maxSeconds: 40, reason: 'relay waits for the save timer' }],
    })).toEqual([]);
  });
});
