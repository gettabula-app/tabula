#!/usr/bin/env node
// Flake gate (TAB-154): runs test files N times under CI=true, so the CI settings of vite.config.ts apply (two workers,
// longer timeouts), and reports which tests failed in which runs.
//
//   npm run test:repeat -- [files...] [--times 20] [--platform win32] [--bail]
//
// Without files it takes the test files changed versus origin/main (committed, staged or untracked). Each run is one
// `vitest run` child process (no shell) whose result is read from vitest's JSON reporter, not from its text output.
// --platform win32 sets TABULA_TEST_PLATFORM=win32 for the tests (test/platform.ts).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

const DEFAULT_TIMES = 20;
const TEST_FILE = /^test\/.+\.test\.[cm]?[jt]sx?$/;
const OUTPUT_TAIL_LINES = 25;
const OUTPUT_KEEP_BYTES = 64 * 1024;

export const USAGE = `Usage: npm run test:repeat -- [files...] [--times N] [--platform win32] [--bail]

Runs vitest on the test files N times under CI=true and reports every failed test with the runs it failed in.
Without files it runs the test files changed versus origin/main (committed, staged or untracked).

  --times N          number of runs, 1 to 9999 (default ${DEFAULT_TIMES})
  --platform win32   set TABULA_TEST_PLATFORM=win32 so tests take their Windows code paths (see test/platform.ts)
  --bail             stop at the first failing run`;

/**
 * @typedef {{ status: string, fullName: string, failureMessages?: string[] }} AssertionResult
 * @typedef {{ name: string, status: string, message?: string, assertionResults: AssertionResult[] }} FileResult
 * @typedef {{ success?: boolean, testResults: FileResult[] }} VitestReport
 * @typedef {{ file: string, name: string, message: string }} Failure
 * @typedef {{ ok: boolean, passed: number, failed: number, skipped: number, failures: Failure[], problems: string[] }} Verdict
 * @typedef {Verdict & { index: number, durationMs: number, output: string }} Run
 */

/**
 * @param {string[]} argv
 * @returns {{ files: string[], times: number, platform: 'win32' | undefined, bail: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ files: string[], times: number, platform: 'win32' | undefined, bail: boolean, help: boolean }} */
  const opts = { files: [], times: DEFAULT_TIMES, platform: undefined, bail: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--times') {
      const v = value();
      if (!/^[1-9]\d{0,3}$/.test(v)) throw new Error(`--times must be a whole number from 1 to 9999, got "${v}"`);
      opts.times = Number(v);
    } else if (flag === '--platform') {
      const v = value();
      if (v !== 'win32') throw new Error(`--platform supports only win32, got "${v}"`);
      opts.platform = v;
    } else if (flag === '--bail' || flag === '--help' || flag === '-h') {
      if (inline !== undefined) throw new Error(`${flag} takes no value`);
      if (flag === '--bail') opts.bail = true;
      else opts.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      opts.files.push(arg);
    }
  }
  return opts;
}

/**
 * The test files named by `git diff -z --name-only` (committed changes) and `git status --porcelain -z` (uncommitted
 * ones): added or modified, deleted files left out, each once, sorted.
 * @param {string} diffOut @param {string} statusOut
 */
export function selectFiles(diffOut, statusOut) {
  const picked = new Set();
  for (const file of diffOut.split('\0')) if (TEST_FILE.test(file)) picked.add(file);
  const entries = statusOut.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    if (/[RC]/.test(xy)) i++; // a rename or copy is followed by its original path as a field of its own
    if (xy.includes('D')) continue;
    if (TEST_FILE.test(file)) picked.add(file);
  }
  return [...picked].sort();
}

/** @param {string} from @param {string} to */
const relative = (from, to) => path.relative(from, to).split(path.sep).join('/');

/** @param {string | undefined} text */
const firstLine = (text) => {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}...` : line.trim();
};

/**
 * Decides whether one vitest run passed, from its JSON report and exit code. A run is not a pass when vitest exited
 * non-zero for a reason the report does not show (an unhandled error), when no JSON report exists, or when a requested
 * file has no results (it was not collected, so nothing ran).
 * @param {{ report: VitestReport | null, exitCode: number | null, files: string[], root: string }} run `files` are absolute
 * @returns {Verdict}
 */
export function judgeRun({ report, exitCode, files, root: base }) {
  /** @type {Failure[]} */
  const failures = [];
  /** @type {string[]} */
  const problems = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  if (!report || !Array.isArray(report.testResults)) {
    problems.push('vitest wrote no JSON report');
  } else {
    for (const result of report.testResults) {
      const file = relative(base, result.name);
      let failedHere = 0;
      for (const test of result.assertionResults ?? []) {
        if (test.status === 'passed') passed++;
        else if (test.status === 'failed') {
          failed++;
          failedHere++;
          failures.push({ file, name: test.fullName, message: firstLine(test.failureMessages?.[0]) });
        } else skipped++;
      }
      if (result.status === 'failed' && !failedHere) {
        failures.push({ file, name: '(the file failed to run)', message: firstLine(result.message) });
      }
    }
    for (const file of files) {
      if (!report.testResults.some((result) => path.relative(file, result.name) === '')) {
        problems.push(`no results for ${relative(base, file)} (not collected: not a test file, or excluded by vite.config.ts)`);
      }
    }
    if (exitCode !== 0 && !failures.length && !problems.length) {
      problems.push(`vitest exited with ${exitCode === null ? 'a signal' : `code ${exitCode}`} but reported no failed test (an unhandled error, see the output)`);
    }
  }
  return { ok: !failures.length && !problems.length && exitCode === 0, passed, failed, skipped, failures, problems };
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m${String(s).padStart(2, '0')}s`;
}

/** The progress line of one run, followed by what failed in it. @param {Run} run @param {number} times */
export function formatRun(run, times) {
  const counts = [`${run.passed} passed`, ...(run.failed ? [`${run.failed} failed`] : []), ...(run.skipped ? [`${run.skipped} skipped`] : [])];
  const lines = [`run ${run.index}/${times}  ${run.ok ? 'passed' : 'FAILED'}  ${formatDuration(run.durationMs)}  (${counts.join(', ')})`];
  for (const f of run.failures) lines.push(`    x ${f.file} > ${f.name}`);
  for (const p of run.problems) lines.push(`    ! ${p}`);
  return lines.join('\n');
}

/**
 * @param {Run[]} runs
 * @param {{ times: number, bailed?: boolean, interrupted?: boolean }} plan
 */
export function summarise(runs, { times, bailed = false, interrupted = false }) {
  /** @type {Map<string, Failure & { runs: number[] }>} */
  const byTest = new Map();
  for (const run of runs) {
    for (const f of run.failures) {
      const key = `${f.file} > ${f.name}`;
      const known = byTest.get(key);
      if (known) known.runs.push(run.index);
      else byTest.set(key, { ...f, runs: [run.index] });
    }
  }
  return {
    planned: times,
    runs: runs.length,
    failedRuns: runs.filter((r) => !r.ok).map((r) => r.index),
    failures: [...byTest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, f]) => f),
    problems: runs.flatMap((r) => r.problems.map((text) => ({ run: r.index, text }))),
    totalMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
    bailed,
    interrupted,
  };
}

/** @param {ReturnType<typeof summarise>} s */
export function formatSummary(s) {
  const runs = (n) => `${n} run${n === 1 ? '' : 's'}`;
  const head = s.failedRuns.length
    ? `test-repeat FAILED: ${runs(s.runs)}, ${s.failedRuns.length} failed (${s.failedRuns.length === 1 ? 'run' : 'runs'} ${s.failedRuns.join(', ')}), ${formatDuration(s.totalMs)} total`
    : `test-repeat ${s.interrupted ? 'incomplete' : 'passed'}: ${runs(s.runs)}, 0 failed, ${formatDuration(s.totalMs)} total`;
  const lines = [head];
  if (s.bailed) lines.push(`stopped after run ${s.runs} of ${s.planned} (--bail)`);
  if (s.interrupted) lines.push(`interrupted after run ${s.runs} of ${s.planned}`);
  if (s.failures.length) {
    lines.push('failed tests:');
    for (const f of s.failures) {
      lines.push(`  ${f.file} > ${f.name}`, `    failed in ${f.runs.length} of ${runs(s.runs)} (${f.runs.join(', ')})${f.message ? `: ${f.message}` : ''}`);
    }
  }
  if (s.problems.length) {
    lines.push('problems:');
    for (const p of s.problems) lines.push(`  run ${p.run}: ${p.text}`);
  }
  return lines.join('\n');
}

/** @param {string} text */
const tail = (text) => text.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');

/** @param {string[]} args */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = /** @type {{ stderr?: string }} */ (err).stderr;
    throw new Error(`git ${args[0]} failed: ${String(stderr || err).trim()}`);
  }
}

function changedTestFiles() {
  let diff;
  try {
    diff = git('diff', '-z', '--no-renames', '--name-only', '--diff-filter=AM', 'origin/main...HEAD', '--', 'test/');
  } catch (err) {
    throw new Error(`${/** @type {Error} */ (err).message}\nIs origin/main fetched? Or name the files: npm run test:repeat -- test/foo.test.ts`);
  }
  const status = git('status', '--porcelain', '-z', '-uall');
  return selectFiles(diff, status).filter((f) => fs.existsSync(path.join(root, f)));
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let current;

/**
 * @param {string[]} files @param {NodeJS.ProcessEnv} env @param {string} reportFile
 * @returns {Promise<{ exitCode: number | null, output: string }>}
 */
function runVitest(files, env, reportFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestBin, 'run', ...files, '--reporter=json', `--outputFile=${reportFile}`], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current = child;
    let output = '';
    const collect = (chunk) => {
      output = (output + chunk).slice(-OUTPUT_KEEP_BYTES);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', (exitCode) => {
      current = undefined;
      resolve({ exitCode, output });
    });
  });
}

/** @param {string} file @returns {VitestReport | null} */
function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string[]} argv */
export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`test-repeat: ${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  let files;
  try {
    if (opts.files.length) {
      const missing = opts.files.filter((f) => !fs.statSync(path.resolve(f), { throwIfNoEntry: false })?.isFile());
      if (missing.length) {
        console.error(`test-repeat: not a file: ${missing.join(', ')}`);
        return 2;
      }
      files = opts.files.map((f) => fs.realpathSync(path.resolve(f)));
    } else {
      files = changedTestFiles().map((f) => path.join(root, f));
      if (!files.length) {
        console.error('test-repeat: no test files are changed versus origin/main (committed, staged or untracked). Name the files: npm run test:repeat -- test/foo.test.ts');
        return 2;
      }
    }
  } catch (err) {
    console.error(`test-repeat: ${/** @type {Error} */ (err).message}`);
    return 2;
  }

  const forced = opts.platform ?? process.env.TABULA_TEST_PLATFORM;
  console.log(`test-repeat: ${files.length} file${files.length === 1 ? '' : 's'} x ${opts.times} run${opts.times === 1 ? '' : 's'} under CI=true${forced ? `, platform forced to ${forced}` : ''}${opts.files.length ? '' : ' (changed versus origin/main)'}`);
  for (const f of files) console.log(`  ${relative(root, f)}`);

  const env = { ...process.env, CI: 'true', ...(opts.platform ? { TABULA_TEST_PLATFORM: opts.platform } : {}) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-test-repeat-'));
  /** @type {Run[]} */
  const runs = [];
  let bailed = false;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    current?.kill('SIGTERM');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    for (let index = 1; index <= opts.times && !interrupted; index++) {
      const reportFile = path.join(tmp, `run-${index}.json`);
      const t0 = Date.now();
      const { exitCode, output } = await runVitest(files, env, reportFile);
      if (interrupted) break;
      const verdict = judgeRun({ report: readReport(reportFile), exitCode, files, root });
      const run = { ...verdict, index, durationMs: Date.now() - t0, output: verdict.ok ? '' : tail(output) };
      runs.push(run);
      console.log(formatRun(run, opts.times));
      if (!verdict.ok && verdict.problems.length && run.output) console.log(run.output.replace(/^/gm, '    | '));
      if (!verdict.ok && opts.bail && index < opts.times) {
        bailed = true;
        break;
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const summary = summarise(runs, { times: opts.times, bailed, interrupted });
  console.log(`\n${formatSummary(summary)}`);
  if (interrupted) return 130;
  return summary.failedRuns.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
