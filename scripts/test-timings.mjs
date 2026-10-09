#!/usr/bin/env node
// Per-file test times from vitest's JSON report (TAB-201). CI writes the report next to the default output and runs
// this after the tests, so every job's log ends with its slowest files and the numbers are kept as an artifact. The
// times measured here, on the Windows shards above all, set the budget in test/timing-budget.json: with --budget, a
// single test slower than its limit fails the job by name, so a slow test is fixed before it becomes a timeout.
//
// A slow sample on a shared runner can be a stall that has nothing to do with the test (a 0.4 s test measured at
// 31 s on one Windows job). So each test over its limit is measured once more, alone, and the job fails only when that
// second sample is over too; both times and a "stalled sample" line are printed either way.
//
//   node scripts/test-timings.mjs <report.json> [--top 15] [--budget test/timing-budget.json]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Seconds per test file, slowest first. A file's time is from its first test starting to its last one ending. */
export function fileTimes(report, root = process.cwd()) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  return results
    .filter((r) => typeof r?.name === 'string' && Number.isFinite(r.startTime) && Number.isFinite(r.endTime))
    .map((r) => ({
      file: path.relative(root, r.name).split(path.sep).join('/'),
      seconds: Math.max(0, r.endTime - r.startTime) / 1000,
      status: r.status,
    }))
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
}

/** The lines printed to the log: the slowest `top` files and the total. */
export function summary(times, top = 15) {
  const total = times.reduce((sum, t) => sum + t.seconds, 0);
  const width = Math.max(0, ...times.slice(0, top).map((t) => t.file.length));
  return [
    `Slowest ${Math.min(top, times.length)} of ${times.length} test files (${total.toFixed(1)} s in all):`,
    ...times.slice(0, top).map((t) => `  ${t.file.padEnd(width)}  ${t.seconds.toFixed(1).padStart(6)} s${t.status === 'passed' ? '' : `  ${t.status}`}`),
  ];
}

/** Seconds per test, slowest first, as "file › describe › title". */
export function testTimes(report, root = process.cwd()) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  const out = [];
  for (const r of results) {
    if (typeof r?.name !== 'string' || !Array.isArray(r.assertionResults)) continue;
    const file = path.relative(root, r.name).split(path.sep).join('/');
    for (const a of r.assertionResults) {
      if (!Number.isFinite(a?.duration)) continue;
      out.push({ file, test: String(a.fullName ?? a.title ?? ''), seconds: a.duration / 1000 });
    }
  }
  return out.sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file) || a.test.localeCompare(b.test));
}

/**
 * The tests over budget: slower than `maxTestSeconds`, or than their own limit in `exempt` (matched by the end of
 * the file path and a part of the full test name). An exemption must give its limit and say why.
 */
export function overBudget(times, budget) {
  const max = Number(budget?.maxTestSeconds);
  if (!Number.isFinite(max) || max <= 0) throw new Error('timing budget: maxTestSeconds must be a positive number');
  const exempt = Array.isArray(budget.exempt) ? budget.exempt : [];
  for (const e of exempt) {
    if (typeof e?.file !== 'string' || typeof e?.test !== 'string' || typeof e?.reason !== 'string' || !e.reason.trim() || !(Number(e.maxSeconds) > 0)) {
      throw new Error(`timing budget: an exemption needs file, test, maxSeconds and a reason (${JSON.stringify(e)})`);
    }
  }
  const limitOf = (t) => exempt.find((e) => t.file.endsWith(e.file) && t.test.includes(e.test))?.maxSeconds ?? max;
  return times.filter((t) => t.seconds > limitOf(t)).map((t) => ({ ...t, limit: Number(limitOf(t)) }));
}

/** More tests than this over budget is a pattern, not a stall: no second chances, the job fails. */
export const MAX_RECHECKS = 3;

/**
 * Measures each test over budget once more with `measure(file, test)` (seconds, or null when it could not be measured,
 * which counts as still over). A test within its limit the second time is a stalled sample. Nothing is re-measured
 * when more than `max` tests are over.
 * @returns {{ confirmed: object[], stalled: object[] }} each row has `seconds` (first sample), `again` and `limit`
 */
export function recheck(over, measure, max = MAX_RECHECKS) {
  if (over.length > max) return { confirmed: over.map((t) => ({ ...t, again: null })), stalled: [] };
  const confirmed = [];
  const stalled = [];
  for (const t of over) {
    const again = measure(t.file, t.test);
    (again !== null && again <= t.limit ? stalled : confirmed).push({ ...t, again });
  }
  return { confirmed, stalled };
}

/** Runs one test alone with vitest and returns its seconds, or null. The test name is matched literally. */
function measureAlone(file, test, root = process.cwd()) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'timing-recheck-')), 'report.json');
  // the report's full name joins describe and test titles with a space, while -t matches them joined with " > ", so
  // a space may be either
  const pattern = test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '( > | )');
  const run = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', file, '-t', pattern, '--reporter=json', `--outputFile.json=${out}`], {
    cwd: root,
    stdio: 'ignore',
    timeout: 5 * 60_000,
  });
  try {
    if (run.status !== 0) return null;
    const hit = testTimes(JSON.parse(fs.readFileSync(out, 'utf8')), root).find((t) => t.file === file && t.test === test);
    return hit ? hit.seconds : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, ...rest] = process.argv.slice(2);
  const topAt = rest.indexOf('--top');
  const top = topAt >= 0 ? Number(rest[topAt + 1]) : 15;
  const budgetAt = rest.indexOf('--budget');
  const budgetFile = budgetAt >= 0 ? rest[budgetAt + 1] : null;
  if (!file || !Number.isInteger(top) || top < 1 || (budgetAt >= 0 && !budgetFile)) {
    console.error('usage: node scripts/test-timings.mjs <report.json> [--top 15] [--budget test/timing-budget.json]');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // a run that died before vitest wrote its report has no timings; the test step already failed and says why
    console.log(`No test timings: ${file} could not be read (${e.code ?? e.message})`);
    process.exit(0);
  }
  for (const line of summary(fileTimes(report), top)) console.log(line);
  if (budgetFile) {
    const budget = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    const first = overBudget(testTimes(report), budget);
    const { confirmed, stalled } = recheck(first, measureAlone);
    for (const t of stalled) {
      console.log(`stalled sample: ${t.file} › ${t.test}: ${t.seconds.toFixed(1)} s, then ${t.again.toFixed(1)} s alone (limit ${t.limit} s); not counted`);
    }
    if (confirmed.length) {
      console.log(`\n${confirmed.length} test${confirmed.length === 1 ? '' : 's'} over the timing budget (${budgetFile}):`);
      for (const t of confirmed) {
        const second = t.again === null ? (first.length > MAX_RECHECKS ? 'not re-measured, too many tests over' : 'second sample failed or not found') : `${t.again.toFixed(1)} s alone`;
        console.log(`  ${t.seconds.toFixed(1)} s > ${t.limit} s  ${t.file} › ${t.test} (${second})`);
      }
      console.log('Make the test cheaper (fewer files, smaller data, an injected limit or clock), or add an exemption with a reason.');
      process.exit(1);
    }
    console.log(`Every test is within the timing budget (${budget.maxTestSeconds} s per test).`);
  }
}
