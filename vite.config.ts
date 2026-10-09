import { configDefaults, defineConfig } from 'vitest/config';
import docs from './scripts/vite-docs.mjs';

// In dev, the relay runs on 8787 and Vite proxies the sync socket to it,
// so the client always connects to same-origin /sync (and /chat, the team chat socket).
export default defineConfig({
  plugins: [docs()],
  server: {
    port: 5173,
    proxy: {
      '/sync': { target: 'ws://localhost:8787', ws: true },
      '/chat': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
      '/icons': { target: 'http://localhost:8787' },
    },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    // agent worktrees live under .claude/worktrees; never collect their tests
    exclude: [...configDefaults.exclude, '.claude/**'],
    // Many test files spawn a relay process each. On the small CI runners (Windows and macOS above all) running
    // them all at once starves the machine and unrelated tests time out, so CI runs two files at a time and every
    // test and hook gets room to wait for a relay. Both limits stay well above RELAY_START_MS (test/relay-timing.ts), so
    // a slow start ends in the helper's error, which carries the relay's output, and not in a bare timeout.
    maxWorkers: process.env.CI ? 2 : undefined,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
