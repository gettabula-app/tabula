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
  // agent worktrees live under .claude/worktrees; never collect their tests
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
