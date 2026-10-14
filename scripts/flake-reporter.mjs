// A vitest reporter that lists the tests which failed and then passed on a retry (a flake). vitest's JSON report does not mark them
// (checked on 5.0.3), the per-test diagnostic does. It writes flaky-tests.json when there are any, adds a warning annotation and a step
// summary table in CI, and never changes the result of the run. Usage: vitest run --reporter=default --reporter=./scripts/flake-reporter.mjs
import fs from 'node:fs';
import path from 'node:path';

/** @returns {{ file: string, name: string, retries: number }[]} */
export function flakyTests(testModules, root = process.cwd()) {
  const found = [];
  for (const mod of testModules) {
    for (const test of mod.children.allTests()) {
      const diagnostic = test.diagnostic?.();
      if (diagnostic?.flaky) found.push({ file: path.relative(root, mod.moduleId).replaceAll('\\', '/'), name: test.fullName, retries: diagnostic.retryCount });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

export function renderSummary(list) {
  if (list.length === 0) return '';
  const rows = list.map((t) => `| \`${t.file}\` | ${t.name.replaceAll('|', '\\|')} | ${t.retries} |`);
  return ['### Flaky tests (passed on a retry)', '', '| File | Test | Retries |', '| --- | --- | --- |', ...rows, ''].join('\n');
}

export default class FlakeReporter {
  onTestRunEnd(testModules) {
    const list = flakyTests(testModules);
    if (list.length === 0) return;
    fs.writeFileSync('flaky-tests.json', `${JSON.stringify(list, null, 2)}\n`);
    for (const t of list) console.log(`::warning title=Flaky test::${t.file} > ${t.name} passed on a retry`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderSummary(list)}\n`);
  }
}
