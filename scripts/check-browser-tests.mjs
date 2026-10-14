#!/usr/bin/env node
// Proves that the browser tests really ran. They launch Playwright's Chromium and skip when it is absent, so a CI leg that lost its browser
// would stay green while testing nothing. After the tests, this reads vitest's JSON report (test-results.json) and fails when any test file
// that asks for Chromium has no passing test. A test that is skipped for another reason (the WebKit ones) does not matter as long as the file
// ran something. Usage: node scripts/check-browser-tests.mjs test-results.json [test-dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKER = 'chromium.executablePath()';
// Tests that may be skipped on the Linux CI leg: the WebKit test of the asset store (WebKit is not installed there). Any other skipped browser test
// means Chromium or a feature went missing and a test stopped running: the check fails the leg. (Opt out in a run with CHECK_BROWSER_ALLOW_SKIPS=1.)
export const ALLOWED_SKIPS = { 'test/asset-store-browser.test.ts': 1 };

/** The test files (relative to the repository, with forward slashes) that need Chromium. */
export function browserTestFiles(testDir) {
  return fs.readdirSync(testDir)
    .filter((name) => /\.test\.(?:ts|mjs|js)$/.test(name))
    .filter((name) => fs.readFileSync(path.join(testDir, name), 'utf8').includes(MARKER))
    .map((name) => `test/${name}`)
    .sort();
}

/**
 * @param {{ testResults?: { name: string, assertionResults?: { status: string }[] }[] }} report vitest's JSON report
 * @param {string[]} files browserTestFiles()
 * @returns {{ ok: boolean, rows: { file: string, passed: number, skipped: number, failed: number, ran: boolean }[], problems: string[] }}
 */
export function checkBrowserTests(report, files, { allowSkips = false } = {}) {
  const results = (report?.testResults ?? []).map((r) => ({ name: String(r.name).replaceAll('\\', '/'), tests: r.assertionResults ?? [] }));
  const rows = [];
  const problems = [];
  for (const file of files) {
    const result = results.find((r) => r.name.endsWith(`/${file}`) || r.name === file);
    const count = (status) => result?.tests.filter((t) => t.status === status).length ?? 0;
    const row = { file, passed: count('passed'), skipped: count('skipped') + count('pending'), failed: count('failed'), ran: Boolean(result) };
    rows.push(row);
    if (!row.ran) problems.push(`${file}: not in the report (the file did not run)`);
    else if (row.passed === 0) problems.push(`${file}: no test passed (${row.skipped} skipped): is Chromium installed on this leg?`);
    else if (row.skipped > (ALLOWED_SKIPS[file] ?? 0) && !allowSkips) problems.push(`${file}: ${row.skipped} skipped (allowed: ${ALLOWED_SKIPS[file] ?? 0})`);
  }
  return { ok: problems.length === 0, rows, problems };
}

function main(argv) {
  const [reportPath, testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test')] = argv;
  if (!reportPath) {
    process.stderr.write('usage: check-browser-tests.mjs test-results.json [test-dir]\n');
    return 2;
  }
  const files = browserTestFiles(testDir);
  if (files.length === 0) {
    process.stderr.write('no test file asks for Chromium: the marker in this script is out of date\n');
    return 2;
  }
  const { ok, rows, problems } = checkBrowserTests(JSON.parse(fs.readFileSync(reportPath, 'utf8')), files, { allowSkips: process.env.CHECK_BROWSER_ALLOW_SKIPS === '1' });
  for (const row of rows) process.stdout.write(`${row.passed > 0 ? 'ok     ' : 'MISSING'} ${row.file}: ${row.passed} passed, ${row.skipped} skipped, ${row.failed} failed\n`);
  if (!ok) process.stderr.write(`${problems.join('\n')}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
