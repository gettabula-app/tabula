#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NIGHTLY_RUNS,
  analyzeOsRuns,
  formatIssueBody,
  formatMergedSummary,
  formatOsSummary,
  mergeNightlyResults,
  workflowFailureReasons,
} from './lib/nightly-report.mjs';

export const USAGE = `Usage:
  node scripts/nightly-report.mjs analyze --os <os> --output <json> --report <file> --outcome <status> (repeat ${NIGHTLY_RUNS} times)
  node scripts/nightly-report.mjs merge --artifacts-dir <dir> --output <json> --issue-body <md> --suite-result <status> --download-outcome <status> --run-url <url>
  node scripts/nightly-report.mjs check --result-file <json> --merge-outcome <status> --post-outcome <status>`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, reports: [], outcomes: [] };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--report' || flag === '--outcome') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      options[flag === '--report' ? 'reports' : 'outcomes'].push(value);
    } else if (flag.startsWith('--')) {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      options[flag.slice(2).replaceAll('-', '')] = value;
    } else {
      throw new Error(`unexpected argument ${flag}`);
    }
  }
  return options;
}

function readReport(file) {
  try {
    return { report: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { report: null, error: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function publishSummary(markdown) {
  const destination = process.env.GITHUB_STEP_SUMMARY;
  if (destination) fs.appendFileSync(destination, `${markdown}\n`, 'utf8');
  else console.log(markdown);
}

function analyze(options) {
  if (!options.os || !options.output || options.reports.length !== NIGHTLY_RUNS || options.outcomes.length !== NIGHTLY_RUNS) {
    throw new Error(USAGE);
  }
  const runs = options.reports.map((file, index) => ({ ...readReport(file), outcome: options.outcomes[index] }));
  const budget = JSON.parse(fs.readFileSync('test/timing-budget.json', 'utf8'));
  const report = analyzeOsRuns({ os: options.os, runs, budget });
  writeJson(options.output, report);
  publishSummary(formatOsSummary(report, process.env.NIGHTLY_RUN_URL ?? ''));
  return report.infraErrors.length ? 1 : 0;
}

function readOsArtifacts(artifactsDir) {
  const reports = [];
  if (!fs.existsSync(artifactsDir)) return reports;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === 'nightly-summary.json') {
        try {
          reports.push(JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch (error) {
          reports.push({
            os: path.basename(path.dirname(file)),
            tests: [],
            overBudget: [],
            counts: { 'always-passed': 0, 'always-failed': 0, FLAKY: 0, skipped: 0, incomplete: 0 },
            infraErrors: [`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`],
          });
        }
      }
    }
  };
  visit(artifactsDir);
  return reports;
}

function merge(options) {
  if (!options.artifactsdir || !options.output || !options.issuebody) throw new Error(USAGE);
  const reports = readOsArtifacts(options.artifactsdir);
  for (const report of reports) {
    if (!Array.isArray(report.tests)) report.tests = [];
    if (!Array.isArray(report.overBudget)) report.overBudget = [];
    if (!Array.isArray(report.infraErrors)) report.infraErrors = ['artifact is missing its infrastructure status'];
    if (!report.counts) report.counts = { 'always-passed': 0, 'always-failed': 0, FLAKY: 0, skipped: 0, incomplete: 0 };
  }
  const report = mergeNightlyResults(reports, {
    suiteResult: options.suiteresult,
    downloadOutcome: options.downloadoutcome,
    runUrl: options.runurl,
  });
  writeJson(options.output, report);
  fs.writeFileSync(options.issuebody, `${formatIssueBody(report)}\n`, 'utf8');
  publishSummary(formatMergedSummary(report));
  return 0;
}

function check(options) {
  if (!options.resultfile) throw new Error(USAGE);
  const report = JSON.parse(fs.readFileSync(options.resultfile, 'utf8'));
  const reasons = workflowFailureReasons(report, {
    'merge results': options.mergeoutcome,
    'post result': options.postoutcome,
  });
  if (reasons.length) {
    console.error('Nightly report failed:');
    for (const reason of reasons) console.error(`- ${reason}`);
    return 1;
  }
  console.log('Nightly report completed; flaky tests are recorded and do not fail the run.');
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'analyze') return analyze(options);
    if (options.command === 'merge') return merge(options);
    if (options.command === 'check') return check(options);
    throw new Error(USAGE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
