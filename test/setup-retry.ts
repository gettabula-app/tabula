import { expect, vi } from 'vitest';
import { wantsBrowserRetry } from './browser-retry';

// vitest's retry is global; this setup file runs once per test file, so the retry can be limited to the browser files.
// setConfig applies `retry` at run time (checked on 5.0.3) although its RuntimeConfig type does not list it.
const retryOnce = { retry: 1 } as unknown as Parameters<typeof vi.setConfig>[0];
if (wantsBrowserRetry(expect.getState().testPath, process.env)) vi.setConfig(retryOnce);
