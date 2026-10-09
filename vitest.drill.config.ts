import { configDefaults, defineConfig } from 'vitest/config';
import base, { DRILL_PATTERN } from './vite.config';

// `npm run drill:local` (scripts/drill-local.mjs): the local restore drill of docs/backups.md, "Rehearsing a restore
// locally". The base config is spread, not merged: mergeConfig would concatenate the exclude lists and keep the drill
// pattern out. One file at a time, in order, with room for the relays it starts and stops.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [`test/drill/${DRILL_PATTERN.replace(/^\*\*\//, '')}`],
    exclude: [...configDefaults.exclude, '.claude/**'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
