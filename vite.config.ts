import { configDefaults, defineConfig } from 'vitest/config';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import docs from './scripts/vite-docs.mjs';
import { browserTestFiles } from './scripts/check-browser-tests.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEMO_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://api.fontshare.com/v2/css; font-src 'self' https://cdn.fontshare.com; img-src 'self' data: blob:; connect-src 'self' https://api.fontshare.com/v2/css https://cdn.fontshare.com/; base-uri 'self'; form-action 'none'";

function demoBuildPlugin() {
  let outDir = '';
  let base = '/demo/';
  return {
    name: 'tabula-demo-build',
    apply: (_config: unknown, env: { mode: string }) => env.mode === 'demo',
    configResolved(config: { root: string; base: string; build: { outDir: string } }) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
    },
    transformIndexHtml(html: string) {
      return html
        .replace(/\s*<link\b[^>]*rel=["']manifest["'][^>]*>/i, '')
        .replace(/href=["']\/favicon\.svg["']/i, `href="${base}favicon.svg"`)
        .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}">`);
    },
    writeBundle() {
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'public', 'favicon.svg'), path.join(outDir, 'favicon.svg'));
    },
  };
}

/** Stamps dist/sw.js with its release hash and the emitted Newsreader asset for the shell precache. */
function swVersionPlugin() {
  let outDir = '';
  return {
    name: 'tabula-sw-version',
    apply: (_config: unknown, env: { mode: string }) => env.mode !== 'demo',
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const sw = path.join(outDir, 'sw.js');
      if (!fs.existsSync(sw)) return;
      const src = fs.readFileSync(sw, 'utf8');
      // index.html names the hashed bundles, so it changes whenever the app does
      const index = fs.existsSync(path.join(outDir, 'index.html')) ? fs.readFileSync(path.join(outDir, 'index.html')) : '';
      const build = createHash('sha256').update(src).update(index).digest('hex').slice(0, 10);
      const assetsDir = path.join(outDir, 'assets');
      const fontFile = fs.existsSync(assetsDir)
        ? fs.readdirSync(assetsDir).find((file) => /^newsreader-latin-wght-normal(?:-[\w-]+)?\.woff2$/.test(file))
        : undefined;
      if (!fontFile) throw new Error('Newsreader font asset was not emitted into the app bundle');
      const fontUrl = `/assets/${fontFile}`;
      fs.writeFileSync(sw, src.replace('__TABULA_BUILD__', build).replace('__TABULA_NEWSREADER_FONT__', fontUrl));
    },
  };
}

/** The restore drill's test files, which only `npm run drill:local` runs. */
export const DRILL_PATTERN = '**/*.drill.test.ts';
// Desktop (Tauri) is frozen (platform freeze, Johan 2026-10-13): its four test files stay in the repository, with desktop/, but are not part of
// `npm test` or CI. To run them again: TABULA_DESKTOP_TESTS=1 npx vitest run test/desktop-backup.test.ts test/desktop-config.test.ts test/desktop-env.test.ts test/desktop-logic.test.ts
export const DESKTOP_TEST_PATTERNS = ['**/test/desktop-backup.test.ts', '**/test/desktop-config.test.ts', '**/test/desktop-env.test.ts', '**/test/desktop-logic.test.ts'];

/**
 * TABULA_TEST_SET splits the suite for CI: `unit` leaves out the test files that launch Chromium, `browser` runs only those (CI runs them in
 * their own job with the browser installed). Unset runs everything, which is what `npm test` does locally.
 */
const browserFiles = browserTestFiles(path.join(ROOT, 'test'));
const testSet = process.env.TABULA_TEST_SET;
if (testSet !== undefined && testSet !== '' && testSet !== 'unit' && testSet !== 'browser') throw new Error(`TABULA_TEST_SET must be unit or browser, not ${testSet}`);

const docsPages = {
  ...docs(),
  apply: (_config: any, env: { mode: string }) => env.mode !== 'demo',
};

const demoConfigPlugin = {
  name: 'tabula-demo-config',
  config(_config: unknown, env: { mode: string }) {
    if (env.mode === 'test') return undefined;
    if (env.mode !== 'demo') return { define: { 'import.meta.env.VITE_DEMO': 'undefined' } };
    return {
      publicDir: false,
      define: { 'import.meta.env.VITE_DEMO': '"1"' },
      // No account, no tracker: keep its UI and data code out of the one-file demo bundle.
      resolve: {
        alias: [{
          find: /^(?:\.{1,2}\/)+(?:tracker-data|tracker\/ui\/(?:frame|shell|link-dialog-open|unlink-confirm))$/,
          replacement: path.join(ROOT, 'src/demo/no-tracker.ts'),
        }],
      },
      build: { sourcemap: false, rolldownOptions: { output: { codeSplitting: false } } },
    };
  },
};

// In dev, PORT selects the relay and VITE_PORT selects Vite; both keep their documented defaults.
const relayPort = Number(process.env.PORT) || 8787;
const vitePort = Number(process.env.VITE_PORT) || 5173;

// Vite proxies sync and API requests to the selected relay port.
export default defineConfig({
  plugins: [docsPages, demoConfigPlugin, demoBuildPlugin(), swVersionPlugin()],
  // Tracker and board deep links are HTML5 paths and must reach the SPA entry in development too.
  appType: 'spa',
  server: {
    port: vitePort,
    strictPort: true,
    proxy: {
      '/sync': { target: `ws://localhost:${relayPort}`, ws: true },
      '/chat': { target: `ws://localhost:${relayPort}`, ws: true },
      '/api': { target: `http://localhost:${relayPort}` },
      '/icons': { target: `http://localhost:${relayPort}` },
    },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    // agent worktrees live under .claude/worktrees; never collect their tests. The restore drill (test/drill,
    // `npm run drill:local`, vitest.drill.config.ts) is not part of `npm test` or CI: test/drill-config.test.ts checks it.
    exclude: [
      ...configDefaults.exclude,
      '.claude/**',
      DRILL_PATTERN,
      ...(process.env.TABULA_DESKTOP_TESTS === '1' ? [] : DESKTOP_TEST_PATTERNS),
      ...(testSet === 'unit' ? browserFiles : []),
    ],
    ...(testSet === 'browser' ? { include: browserFiles } : {}),
    // Many test files spawn a relay process each. On the small CI runners (Windows and macOS above all) running
    // them all at once starves the machine and unrelated tests time out, so CI runs two files at a time and every
    // test and hook gets room to wait for a relay. Both limits stay well above RELAY_START_MS (test/relay-timing.ts), so
    // a slow start ends in the helper's error, which carries the relay's output, and not in a bare timeout.
    // Linux runners (4 vCPUs) run four files at once: four CI runs with 4 were green and about 30% faster than with 2 (no flake reported). The
    // Windows and macOS runners keep two. TABULA_MAX_WORKERS lets a CI run try another number (workflow_dispatch input max-workers).
    maxWorkers: process.env.CI ? Number(process.env.TABULA_MAX_WORKERS) || (process.platform === 'linux' ? 4 : 2) : undefined,
    // every test file's fetch avoids reused idle sockets and retries one reset GET visibly (test/http-retry.ts)
    setupFiles: ['./test/setup-http.ts', './test/setup-retry.ts'],
    // The Windows runners are roughly 20 times slower for real restores and relays (test/wait-budget.ts scales the waits inside tests the same way).
    testTimeout: process.platform === 'win32' ? 180_000 : 60_000,
    hookTimeout: process.platform === 'win32' ? 120_000 : 60_000,
  },
});
