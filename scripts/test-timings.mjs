#!/usr/bin/env node
// Per-file test times from vitest's JSON report (TAB-201). CI writes the report next to the default output and runs
// this after the tests, so every job's log ends with its slowest files and the numbers are kept as an artifact. The
// times measured here, on the Windows shards above all, are what a timing budget will be set from.
//
//   node scripts/test-timings.mjs <report.json> [--top 15]
import fs from 'node:fs';
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, ...rest] = process.argv.slice(2);
  const topAt = rest.indexOf('--top');
  const top = topAt >= 0 ? Number(rest[topAt + 1]) : 15;
  if (!file || !Number.isInteger(top) || top < 1) {
    console.error('usage: node scripts/test-timings.mjs <report.json> [--top 15]');
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
}
