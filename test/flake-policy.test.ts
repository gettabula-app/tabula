import { describe, expect, it } from 'vitest';
import { MARKER } from '../scripts/check-browser-tests.mjs';
import { flakyTests, renderSummary } from '../scripts/flake-reporter.mjs';
import { wantsBrowserRetry } from './browser-retry';

// CI retries a failed browser test once and lists every test that passed on the retry; the release run retries nothing.

describe('browser retry', () => {
  const browserFile = `const exe = ${MARKER};`;
  const read = (file: string) => (file.endsWith('-browser.test.ts') ? browserFile : 'it("unit", () => {})');

  it('retries only a Chromium file, and only when CI asks for it', () => {
    expect(wantsBrowserRetry('/repo/test/a-browser.test.ts', { TABULA_BROWSER_RETRY: '1' }, read)).toBe(true);
    expect(wantsBrowserRetry('/repo/test/a.test.ts', { TABULA_BROWSER_RETRY: '1' }, read)).toBe(false);
    expect(wantsBrowserRetry('/repo/test/a-browser.test.ts', {}, read)).toBe(false);
    expect(wantsBrowserRetry('/repo/test/a-browser.test.ts', { TABULA_BROWSER_RETRY: '0' }, read)).toBe(false);
  });

  it('does not retry when the file cannot be read or has no path', () => {
    expect(wantsBrowserRetry(undefined, { TABULA_BROWSER_RETRY: '1' }, read)).toBe(false);
    expect(wantsBrowserRetry('/missing.test.ts', { TABULA_BROWSER_RETRY: '1' }, () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('flake report', () => {
  const module = (moduleId: string, tests: { fullName: string; flaky: boolean; retryCount: number }[]) => ({
    moduleId,
    children: { allTests: () => tests.map((t) => ({ fullName: t.fullName, diagnostic: () => ({ flaky: t.flaky, retryCount: t.retryCount }) })) },
  });

  it('lists only the tests that passed on a retry, sorted, with repository-relative paths', () => {
    const list = flakyTests([
      module('/repo/test/b-browser.test.ts', [{ fullName: 'b > steady', flaky: false, retryCount: 0 }, { fullName: 'b > flaky', flaky: true, retryCount: 1 }]),
      module('/repo/test/a-browser.test.ts', [{ fullName: 'a > flaky', flaky: true, retryCount: 1 }]),
    ], '/repo');
    expect(list).toEqual([
      { file: 'test/a-browser.test.ts', name: 'a > flaky', retries: 1 },
      { file: 'test/b-browser.test.ts', name: 'b > flaky', retries: 1 },
    ]);
  });

  it('renders nothing for a clean run and a table with escaped pipes otherwise', () => {
    expect(renderSummary([])).toBe('');
    const text = renderSummary([{ file: 'test/a-browser.test.ts', name: 'x | y', retries: 1 }]);
    expect(text).toContain('| `test/a-browser.test.ts` | x \\| y | 1 |');
  });
});
