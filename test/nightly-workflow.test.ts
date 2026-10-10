import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync('.github/workflows/nightly.yml', 'utf8');

function job(name: string) {
  const start = workflow.indexOf(`  ${name}:\n`, workflow.indexOf('\njobs:\n'));
  expect(start).toBeGreaterThan(-1);
  const remainder = workflow.slice(start + 1);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? remainder : remainder.slice(0, next);
}

describe('the nightly workflow', () => {
  it('runs nightly on an odd UTC minute and can be started manually', () => {
    expect(workflow).toMatch(/^on:\s*$/m);
    expect(workflow).toContain("cron: '17 3 * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/cron:\s*['"]?0\s/);
  });

  it('serializes nightly runs and tests main on all three OSes with Node 24', () => {
    const suite = job('suite');
    expect(workflow).toMatch(/concurrency:\n\s+group: nightly-full-suite\n\s+cancel-in-progress: false/);
    expect(suite).toContain('fail-fast: false');
    expect(suite).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(suite).toContain('node: [24]');
    expect(suite).toMatch(/uses: actions\/checkout@[^\n]+\n\s+with:\n\s+ref: main/);
    for (const run of [1, 2, 3]) {
      expect(suite).toContain(`npm test -- --reporter=default --reporter=json --outputFile.json=nightly-${run}.json`);
      expect(suite).toMatch(new RegExp(`- name: Test run ${run}\\n\\s+id: run${run}\\n\\s+continue-on-error: true`));
    }
    expect(suite).toContain('retention-days: 14');
  });

  it('grants issue write permission only to the reporting job', () => {
    const jobsStart = workflow.indexOf('\njobs:\n');
    const globalPermissions = workflow.slice(0, jobsStart);
    expect(globalPermissions).toContain('contents: read');
    expect(globalPermissions).not.toContain('issues: write');
    expect(job('suite')).not.toContain('issues: write');
    expect(job('report')).toContain('contents: read');
    expect(job('report')).toContain('issues: write');
  });

  it('uses only official actions or Docker actions and only the GitHub token secret', () => {
    const uses = [...workflow.matchAll(/^\s+uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((action) => /^(actions|docker)\//.test(action))).toBe(true);
    const secrets = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
    expect(secrets).toEqual(['GITHUB_TOKEN']);
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('gh issue comment');
    expect(workflow).toContain('gh issue close');
  });
});
