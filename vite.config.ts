import { configDefaults, defineConfig } from 'vitest/config';

// In dev, the relay runs on 8787 and Vite proxies the sync socket to it,
// so the client always connects to same-origin /sync.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/sync': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    // agent worktrees live under .claude/worktrees; never collect their tests
    exclude: [...configDefaults.exclude, '.claude/**'],
    // Many test files spawn a relay process each. On the small CI runners (Windows and macOS above all) running
    // them all at once starves the machine and unrelated tests time out, so CI runs two files at a time and every
    // test and hook gets room to wait for a relay.
    maxWorkers: process.env.CI ? 2 : undefined,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
