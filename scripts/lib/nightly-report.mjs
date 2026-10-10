/** @typedef {{ name: string, status: string, assertionResults?: { fullName?: string, title?: string, ancestorTitles?: string[], status?: string, duration?: number, failureMessages?: string[] }[] }} TestFileResult */
/** @typedef {{ testResults?: TestFileResult[] }} VitestReport */

import { overBudget, testTimes } from '../test-timings.mjs';

export const NIGHTLY_OS = ['ubuntu-latest', 'macos-latest', 'windows-latest'];
export const NIGHTLY_RUNS = 3;

const SKIPPED_STATUSES = new Set(['pending', 'skipped', 'todo', 'disabled']);

/** Return a stable repo-relative path for POSIX and Windows Vitest reports. */
export function relativeTestFile(name, root = process.cwd()) {
  const win32 = /^[A-Za-z]:[\\/]/.test(name);
  const paths = win32 ? pathWin32 : pathPosix;
  return paths.relative(root, name).replaceAll('\\', '/').replace(/^\.\//, '');
}

// Kept local so the pure helpers don't depend on the host platform's path implementation.
const pathPosix = {
  relative(from, to) {
    const a = from.replaceAll('\\', '/').split('/').filter(Boolean);
    const b = to.replaceAll('\\', '/').split('/').filter(Boolean);
    let same = 0;
    while (same < a.length && same < b.length && a[same] === b[same]) same++;
    return [...Array(a.length - same).fill('..'), ...b.slice(same)].join('/') || '.';
  },
};

const pathWin32 = {
  relative(from, to) {
    const normalize = (value) => value.replaceAll('/', '\\').replace(/\\+$/, '');
    const a = normalize(from).split('\\');
    const b = normalize(to).split('\\');
    let same = 0;
    while (same < a.length && same < b.length && a[same].toLowerCase() === b[same].toLowerCase()) same++;
    return [...Array(a.length - same).fill('..'), ...b.slice(same)].join('\\');
  },
};

/** Convert Vitest's JSON statuses to the four states used in the nightly comparison. */
export function normalizeStatus(status) {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (SKIPPED_STATUSES.has(status)) return 'skipped';
  return 'unknown';
}

function assertionName(assertion) {
  if (typeof assertion.fullName === 'string' && assertion.fullName) return assertion.fullName;
  const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : [];
  return [...ancestors, assertion.title].filter((part) => typeof part === 'string' && part).join(' > ') || '(unnamed test)';
}

function fileRows(report, root) {
  const rows = [];
  for (const fileResult of report.testResults) {
    if (!fileResult || typeof fileResult.name !== 'string') continue;
    const file = relativeTestFile(fileResult.name, root);
    const assertions = Array.isArray(fileResult.assertionResults) ? fileResult.assertionResults : [];
    if (!assertions.length && fileResult.status === 'failed') {
      rows.push({ file, test: '(the file failed to run)', status: 'failed' });
    }
    for (const assertion of assertions) {
      if (!assertion || typeof assertion !== 'object') continue;
      rows.push({ file, test: assertionName(assertion), status: normalizeStatus(assertion.status) });
    }
  }
  return rows;
}

/** Pure timing-budget check for test durations from a Vitest JSON report. */
export function overNightlyBudget(times, budget) {
  return overBudget(times, budget);
}

/**
 * Compare the three Vitest reports for one OS. Missing or malformed reports are infrastructure errors and are kept as
 * unavailable run slots so a partial set of reports cannot be described as always passing.
 * @param {{ os: string, runs: { report?: VitestReport | null, error?: string, outcome?: string }[], root?: string, budget: object }} input
 */
export function analyzeOsRuns({ os, runs, root = process.cwd(), budget }) {
  const runSlots = Array.from({ length: NIGHTLY_RUNS }, (_, index) => runs[index] ?? { report: null, error: 'no report supplied', outcome: 'missing' });
  const infraErrors = [];
  const rowsByRun = [];
  const timingRows = [];
  const runSummaries = [];

  runSlots.forEach((run, index) => {
    const number = index + 1;
    const report = run.report;
    if (run.error) infraErrors.push(`run ${number}: ${run.error}`);
    if (!report || !Array.isArray(report.testResults)) {
      if (!run.error) infraErrors.push(`run ${number}: no valid Vitest JSON report`);
      rowsByRun.push(null);
      runSummaries.push({ run: number, outcome: run.outcome ?? 'missing', reportFound: false, testsFailed: 0, testsSkipped: 0, testsReported: 0 });
      return;
    }
    if (report.testResults.length === 0) infraErrors.push(`run ${number}: no test files were reported`);
    const rows = fileRows(report, root);
    rowsByRun.push(rows);
    let testsFailed = 0;
    let testsSkipped = 0;
    for (const row of rows) {
      if (row.status === 'failed') testsFailed++;
      if (row.status === 'skipped') testsSkipped++;
    }
    timingRows.push(...testTimes(report, root).map((test) => ({ ...test, run: number })));
    if (run.outcome === 'failure' && testsFailed === 0) {
      infraErrors.push(`run ${number}: Vitest exited unsuccessfully without reporting a failed test`);
    }
    if (rows.some((row) => row.status === 'unknown')) infraErrors.push(`run ${number}: one or more test results had an unknown status`);
    runSummaries.push({ run: number, outcome: run.outcome ?? 'unknown', reportFound: true, testsFailed, testsSkipped, testsReported: rows.length });
  });

  const keys = new Map();
  for (const rows of rowsByRun) {
    for (const row of rows ?? []) {
      const key = JSON.stringify([row.file, row.test]);
      if (!keys.has(key)) keys.set(key, { file: row.file, test: row.test, statuses: Array(NIGHTLY_RUNS).fill(null) });
    }
  }
  for (const [runIndex, rows] of rowsByRun.entries()) {
    if (!rows) continue;
    const byKey = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.file, row.test]);
      const existing = byKey.get(key);
      if (!existing || row.status === 'failed' || (row.status === 'passed' && existing.status === 'skipped')) byKey.set(key, row);
    }
    for (const [key, test] of keys) test.statuses[runIndex] = byKey.get(key)?.status ?? 'missing';
  }

  const tests = [...keys.values()].map((test) => {
    const failedRuns = [];
    const passedRuns = [];
    const skippedRuns = [];
    const missingRuns = [];
    for (const [index, status] of test.statuses.entries()) {
      if (status === 'failed') failedRuns.push(index + 1);
      else if (status === 'passed') passedRuns.push(index + 1);
      else if (status === 'skipped') skippedRuns.push(index + 1);
      else missingRuns.push(index + 1);
    }
    let classification = 'incomplete';
    if (failedRuns.length && (passedRuns.length || skippedRuns.length)) classification = 'FLAKY';
    else if (missingRuns.length) classification = 'incomplete';
    else if (failedRuns.length === NIGHTLY_RUNS) classification = 'always-failed';
    else if (passedRuns.length === NIGHTLY_RUNS) classification = 'always-passed';
    else if (skippedRuns.length) classification = 'skipped';
    return { ...test, classification, failedRuns, passedRuns, skippedRuns, missingRuns };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test));

  for (const test of tests) {
    if (test.classification === 'incomplete') {
      infraErrors.push(`${test.file} › ${test.test}: missing a result in run${test.missingRuns.length === 1 ? '' : 's'} ${test.missingRuns.join(', ')}`);
    }
  }

  const slowestByTest = new Map();
  for (const timing of timingRows) {
    const key = JSON.stringify([timing.file, timing.test]);
    const current = slowestByTest.get(key);
    if (!current || timing.seconds > current.seconds) slowestByTest.set(key, timing);
  }
  const slowest = [...slowestByTest.values()]
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file) || a.test.localeCompare(b.test))
    .slice(0, 15);
  const overBudget = overNightlyBudget(timingRows, budget);
  const counts = Object.fromEntries(['always-passed', 'always-failed', 'FLAKY', 'skipped', 'incomplete'].map((classification) => [classification, tests.filter((test) => test.classification === classification).length]));

  return {
    schemaVersion: 1,
    os,
    expectedRuns: NIGHTLY_RUNS,
    runs: runSummaries,
    tests,
    counts,
    slowest,
    overBudget,
    infraErrors: [...new Set(infraErrors)],
    issueRequired: tests.some((test) => test.failedRuns.length > 0 || test.classification === 'incomplete') || infraErrors.length > 0,
  };
}

/** Merge the three OS summaries and add missing-artifact / job infrastructure details. */
export function mergeNightlyResults(osReports, { suiteResult = 'success', downloadOutcome = 'success', runUrl = '' } = {}) {
  const byOs = new Map(osReports.map((report) => [report.os, report]));
  const infraErrors = [];
  for (const os of NIGHTLY_OS) {
    if (!byOs.has(os)) infraErrors.push(`${os}: no nightly artifact was downloaded`);
  }
  for (const report of osReports) infraErrors.push(...(report.infraErrors ?? []).map((error) => `${report.os}: ${error}`));
  if (suiteResult !== 'success') infraErrors.push(`suite job finished with ${suiteResult}`);
  if (downloadOutcome !== 'success') infraErrors.push(`artifact download finished with ${downloadOutcome}`);
  const tests = osReports.flatMap((report) => report.tests.map((test) => ({ ...test, os: report.os })));
  const overBudget = osReports.flatMap((report) => report.overBudget.map((test) => ({ ...test, os: report.os })));
  const fullyGreen = infraErrors.length === 0 && tests.every((test) => test.failedRuns.length === 0 && test.classification !== 'incomplete');
  return {
    schemaVersion: 1,
    expectedOs: NIGHTLY_OS,
    osReports: [...osReports].sort((a, b) => NIGHTLY_OS.indexOf(a.os) - NIGHTLY_OS.indexOf(b.os)),
    tests: tests.sort((a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test) || a.os.localeCompare(b.os)),
    overBudget,
    infraErrors: [...new Set(infraErrors)],
    runUrl,
    fullyGreen,
    issueRequired: !fullyGreen,
  };
}

/** A flaky-only result stays informative; infrastructure errors and tests failing in every run fail the report job. */
export function workflowFailureReasons(report, stepOutcomes = {}) {
  const reasons = [...(report?.infraErrors ?? [])];
  for (const [step, outcome] of Object.entries(stepOutcomes)) {
    if (outcome && outcome !== 'success') reasons.push(`${step} step finished with ${outcome}`);
  }
  for (const test of report?.tests ?? []) {
    if (test.classification === 'always-failed') reasons.push(`${test.os}: ${test.file} › ${test.test} failed in all three runs`);
  }
  return [...new Set(reasons)];
}

function testTable(tests) {
  if (!tests.length) return '_None._';
  return [
    '| File | Test | OS | Result | Runs failed of 3 |',
    '| --- | --- | --- | --- | ---: |',
    ...tests.map((test) => `| \`${escapeCell(test.file)}\` | ${escapeCell(test.test)} | ${escapeCell(test.os)} | ${test.classification} | ${test.failedRuns.length}/3 |`),
  ].join('\n');
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** Markdown summary for one matrix job. */
export function formatOsSummary(report, runUrl = '') {
  const failing = report.tests.filter((test) => test.failedRuns.length || test.classification === 'incomplete');
  const skipped = report.tests.filter((test) => test.classification === 'skipped');
  const lines = [
    `## Nightly full suite: ${report.os}`,
    '',
    `Runs: ${report.runs.map((run) => `${run.run} ${run.outcome} (${run.testsFailed} failed, ${run.testsSkipped} skipped)`).join('; ')}`,
    `Tests: ${report.tests.length} total; ${report.counts['always-passed']} always-passed; ${report.counts['always-failed']} always-failed; ${report.counts.FLAKY} FLAKY; ${report.counts.skipped} skipped; ${report.counts.incomplete} incomplete.`,
    ...(runUrl ? [`[View this workflow run](${runUrl})`] : []),
    '',
    '### Failing, flaky, or incomplete tests',
    '',
    testTable(failing.map((test) => ({ ...test, os: report.os }))),
    '',
    '### Slowest tests (maximum of three runs)',
    '',
    report.slowest.length
      ? ['| File | Test | Slowest run | Seconds |', '| --- | --- | ---: | ---: |', ...report.slowest.map((test) => `| \`${escapeCell(test.file)}\` | ${escapeCell(test.test)} | ${test.run} | ${test.seconds.toFixed(2)} |`)].join('\n')
      : '_No test durations were reported._',
    '',
    '### Timing budget',
    '',
    report.overBudget.length
      ? ['| File | Test | Run | Seconds | Limit |', '| --- | --- | ---: | ---: | ---: |', ...report.overBudget.map((test) => `| \`${escapeCell(test.file)}\` | ${escapeCell(test.test)} | ${test.run} | ${test.seconds.toFixed(2)} | ${test.limit} |`)].join('\n')
      : '_No tests exceeded the configured timing budget._',
  ];
  if (skipped.length) lines.push('', `Skipped tests: ${skipped.map((test) => `\`${escapeCell(test.file)}\` › ${escapeCell(test.test)}`).join(', ')}`);
  if (report.infraErrors.length) lines.push('', '### Infrastructure errors', '', ...report.infraErrors.map((error) => `- ${error}`));
  return lines.join('\n');
}

/** Markdown summary for the report job. */
export function formatMergedSummary(report) {
  const table = [
    '| OS | Result | Always-passed | Always-failed | FLAKY | Skipped | Timing budget warnings |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.osReports.map((osReport) => `| ${osReport.os} | ${osReport.issueRequired ? 'findings' : 'green'} | ${osReport.counts['always-passed']} | ${osReport.counts['always-failed']} | ${osReport.counts.FLAKY} | ${osReport.counts.skipped} | ${osReport.overBudget.length} |`),
  ].join('\n');
  const problems = report.tests.filter((test) => test.failedRuns.length || test.classification === 'incomplete');
  const lines = [
    `## Nightly test results: ${report.fullyGreen ? 'fully green' : 'findings'}`,
    '',
    table,
    '',
    report.runUrl ? `[View this workflow run](${report.runUrl})` : '',
    '',
    '### Failing, flaky, or incomplete tests',
    '',
    testTable(problems),
    '',
    '### Timing budget warnings',
    '',
    report.overBudget.length
      ? ['| File | Test | OS | Run | Seconds | Limit |', '| --- | --- | --- | ---: | ---: | ---: |', ...report.overBudget.map((test) => `| \`${escapeCell(test.file)}\` | ${escapeCell(test.test)} | ${test.os} | ${test.run} | ${test.seconds.toFixed(2)} | ${test.limit} |`)].join('\n')
      : '_No tests exceeded the configured timing budget._',
  ];
  if (report.infraErrors.length) lines.push('', '### Infrastructure errors', '', ...report.infraErrors.map((error) => `- ${error}`));
  return lines.join('\n');
}

/** Body added to the single persistent GitHub issue on a night with findings. */
export function formatIssueBody(report) {
  const problems = report.tests.filter((test) => test.failedRuns.length || test.classification === 'incomplete');
  return [
    `Nightly suite findings for [this workflow run](${report.runUrl}).`,
    '',
    testTable(problems),
    ...(report.infraErrors.length ? ['', '### Infrastructure errors', '', ...report.infraErrors.map((error) => `- ${error}`)] : []),
    ...(report.overBudget.length ? ['', `Timing budget warnings: ${report.overBudget.length}. See the workflow summary and retained JSON artifact for details.`] : []),
  ].join('\n');
}
