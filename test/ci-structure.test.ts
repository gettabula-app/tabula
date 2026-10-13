import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserTestFiles } from '../scripts/check-browser-tests.mjs';

const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');

function job(name: string) {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const next = ci.slice(start + 1).search(/\n(?:  # |  [a-z-]+:\n)/);
  return ci.slice(start, next === -1 ? undefined : start + 1 + next);
}

// CI runs the unit legs, the browser tests and the Docker build side by side; main is never cancelled and the image is pushed only after green.

describe('ci.yml structure', () => {
  it('cancels only pull request runs; every other run has its own group per commit', () => {
    expect(ci).toContain("group: ci-${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'workflow_dispatch' && github.run_id || github.sha }}");
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it('runs the unit legs without the browser files and the browser job with them, with the retry only there', () => {
    expect(job('test')).toContain('TABULA_TEST_SET: unit');
    expect(job('test')).not.toContain('playwright');
    expect(job('test')).not.toContain('TABULA_BROWSER_RETRY');
    const browser = job('browser');
    expect(browser).toContain('TABULA_TEST_SET: browser');
    expect(browser).toContain("TABULA_BROWSER_RETRY: ${{ inputs.with-node22 && '0' || '1' }}");
    expect(browser).toContain('npx playwright install --with-deps chromium');
    expect(browser).toContain('node scripts/check-browser-tests.mjs test-results.json');
  });

  it('builds the image in parallel without pushing, and publishes only after the tests, for main and release tags', () => {
    const build = job('docker');
    expect(build).toContain('needs: [changes, quality]');
    expect(build).not.toMatch(/push: true|login-action/);
    const publish = job('docker-publish');
    expect(publish).toContain('needs: [changes, quality, test, browser, docker]');
    expect(publish).toContain("github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/'))");
    expect(publish).not.toContain('push: false');
  });

  it('runs on queue branches and skips the repeat run of a commit that already passed there', () => {
    expect(ci).toContain("branches: [main, 'queue/**']");
    const changes = job('changes');
    expect(changes).toContain('actions: read');
    expect(changes).toContain('verified: ${{ steps.verified.outputs.verified }}');
    expect(changes).toContain('startswith("queue/")');
    expect(changes).toContain('[ "$REF" = refs/heads/main ]');
    for (const name of ['quality', 'test', 'browser', 'docker']) {
      expect(job(name)).toContain("if: needs.changes.outputs.code == 'true' && needs.changes.outputs.verified != 'true'");
    }
    // the publish still runs when those jobs are skipped, but never after a failure or a cancel
    expect(job('docker-publish')).toContain("!cancelled() && !contains(needs.*.result, 'failure')");
  });

  it('lets CI passed wait for every job', () => {
    expect(job('ci-ok')).toContain('needs: [changes, quality, test, browser, docker, docker-publish, docs]');
  });
});

describe('TABULA_TEST_SET', () => {
  const list = (set?: string) => {
    const result = spawnSync(process.execPath, [path.join('node_modules', 'vitest', 'vitest.mjs'), 'list', '--filesOnly'], {
      encoding: 'utf8',
      env: { ...process.env, TABULA_TEST_SET: set ?? '' },
    });
    expect(result.status).toBe(0);
    return result.stdout.split('\n').map((line) => line.trim().replaceAll('\\', '/')).filter((line) => /^test\/.*\.test\.[mc]?[jt]s$/.test(line));
  };

  it('splits the suite into the unit files and the Chromium files without losing or repeating one', () => {
    const all = list();
    const unit = list('unit');
    const browser = list('browser');
    expect(browser.sort()).toEqual(browserTestFiles('test'));
    expect(unit.some((file) => browser.includes(file))).toBe(false);
    expect([...unit, ...browser].sort()).toEqual(all.sort());
  }, 60_000);
});
