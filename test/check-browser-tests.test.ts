import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserTestFiles, checkBrowserTests } from '../scripts/check-browser-tests.mjs';

// Built from parts so this file does not itself look like a browser test to the finder below.
const MARKER = ['chromium', 'executablePath()'].join('.');

// The CI leg that installs Chromium fails when a browser test file ran nothing, so a lost browser cannot hide behind skipped tests.

const report = (entries: Record<string, string[]>) => ({
  testResults: Object.entries(entries).map(([name, statuses]) => ({ name: `/runner/work/tabula/tabula/${name}`, assertionResults: statuses.map((status) => ({ status })) })),
});

describe('checkBrowserTests', () => {
  const files = ['test/a-browser.test.ts', 'test/b-browser.test.ts'];

  it('passes when every browser file passed at least one test, whatever else it skipped', () => {
    const result = checkBrowserTests(report({ 'test/a-browser.test.ts': ['passed', 'passed'], 'test/b-browser.test.ts': ['passed', 'skipped'] }), files);
    expect(result.ok).toBe(true);
    expect(result.rows[1]).toMatchObject({ passed: 1, skipped: 1, ran: true });
  });

  it('fails for a file whose tests were all skipped (no Chromium), naming it', () => {
    const result = checkBrowserTests(report({ 'test/a-browser.test.ts': ['passed'], 'test/b-browser.test.ts': ['skipped', 'pending'] }), files);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining('test/b-browser.test.ts: no test passed (2 skipped)')]);
  });

  it('fails for a file that is not in the report at all, and reads Windows paths', () => {
    expect(checkBrowserTests(report({ 'test/a-browser.test.ts': ['passed'] }), files).problems).toEqual([expect.stringContaining('test/b-browser.test.ts: not in the report')]);
    const win = { testResults: [{ name: 'D:\\a\\tabula\\test\\a-browser.test.ts', assertionResults: [{ status: 'passed' }] }] };
    expect(checkBrowserTests(win, ['test/a-browser.test.ts']).ok).toBe(true);
  });

  it('does not take a file whose name only ends the same', () => {
    expect(checkBrowserTests(report({ 'test/other-a-browser.test.ts': ['passed'] }), ['test/a-browser.test.ts']).ok).toBe(false);
  });
});

describe('browserTestFiles', () => {
  it('finds the files that ask for Chromium and ignores the rest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.test.ts'), `const available = existsSync(${MARKER});`);
      fs.writeFileSync(path.join(dir, 'y.test.ts'), 'nothing here');
      fs.writeFileSync(path.join(dir, 'helper.ts'), MARKER);
      expect(browserTestFiles(dir)).toEqual(['test/x.test.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists the repository\'s real browser tests', () => {
    const files = browserTestFiles(path.resolve(__dirname));
    expect(files.length).toBeGreaterThanOrEqual(11);
    expect(files).toContain('test/canvas-focus.test.ts');
  });
});
