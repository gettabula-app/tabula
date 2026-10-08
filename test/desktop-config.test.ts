import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Where a user's boards live is decided by these two settings. Both are checked here because nothing in the app would
// notice a change: the app would simply start up empty, with every existing board unreachable. See "Locked settings"
// in docs/desktop.md.
const config = JSON.parse(readFileSync(new URL('../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const main = (config.app.windows as { label: string; useHttpsScheme?: boolean }[]).find((w) => w.label === 'main');

const IDENTIFIER_WHY =
  'The identifier names the webview data folders (~/Library/WebKit/<identifier>, %LOCALAPPDATA%\\<identifier>, ~/.local/share/<identifier>) ' +
  'and the app data folder that holds the board backups. Changing it after a release makes every installed copy start empty: ' +
  'the boards are still on disk but the app no longer looks there. Decide the final identifier before the first public release, ' +
  'then update this test in the same commit and never again.';

const HTTPS_SCHEME_WHY =
  'On Windows the page origin is http://tauri.localhost when this is false and https://tauri.localhost when it is true. ' +
  "IndexedDB and localStorage belong to the origin, so flipping it makes every Windows user's boards unreachable. " +
  'It has no effect on macOS or Linux (tauri://localhost). Never change it after a release.';

/** Throws with the reason when a locked setting changed, so the failure says why it must not. */
function locked(name: string, actual: unknown, expected: unknown, why: string) {
  if (actual !== expected) throw new Error(`${name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}. ${why}`);
}

describe('desktop storage identity (never change after a release)', () => {
  it('keeps the identifier app.tabula.desktop', () => {
    expect(() => locked('identifier', config.identifier, 'app.tabula.desktop', IDENTIFIER_WHY)).not.toThrow();
  });

  it('keeps useHttpsScheme false on the main window', () => {
    expect(main).toBeDefined();
    expect(() => locked('useHttpsScheme', main?.useHttpsScheme, false, HTTPS_SCHEME_WHY)).not.toThrow();
  });
});
