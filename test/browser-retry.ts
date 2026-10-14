import fs from 'node:fs';
import { MARKER } from '../scripts/check-browser-tests.mjs';

/**
 * CI retries a failing browser test once (the Playwright ones: timing flakes such as the markdown source edit, line height and live roles).
 * Only a file that asks for Chromium is retried, only when TABULA_BROWSER_RETRY is 1 (CI sets it, except for a release run), so a unit
 * test is never softened and a local run still shows every flake. A test that passed on its retry is listed by scripts/flake-reporter.mjs.
 */
export function wantsBrowserRetry(testPath: string | undefined, env: Record<string, string | undefined>, read: (file: string) => string = (file) => fs.readFileSync(file, 'utf8')): boolean {
  if (env.TABULA_BROWSER_RETRY !== '1' || !testPath) return false;
  try {
    return read(testPath).includes(MARKER);
  } catch {
    return false;
  }
}
