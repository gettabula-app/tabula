import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// TAB-180: relay tests failed on loaded runners and on a machine running other suites. Each helper had its own start
// limit (8 or 15 seconds) with the test and hook limits not far above it, and the relays took their ports from fixed
// random ranges that overlapped between test files, so two of them could be given the same port.

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = fs.readdirSync(here)
  .filter((f) => f.endsWith('.ts') && f !== 'relay-timing.test.ts')
  .map((f) => ({ f, text: fs.readFileSync(path.join(here, f), 'utf8') }));

describe('how tests start a relay', () => {
  it('leaves the test and hook timeouts above the start limit, so a slow start ends in the helper error', () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(RELAY_START_MS + 10_000);
    expect(config.test?.hookTimeout).toBeGreaterThanOrEqual(RELAY_START_MS + 10_000);
  });

  it('uses one start limit in every test file that starts a relay', () => {
    const starters = sources.filter((s) => s.text.includes('relay.mjs'));
    expect(starters.length).toBeGreaterThan(10);
    expect(starters.filter((s) => !s.text.includes('RELAY_START_MS')).map((s) => s.f)).toEqual([]);
  });

  it('takes ports from the system, not from a fixed range picked at random', () => {
    expect(sources.filter((s) => /\d{4,5}\s*\+\s*Math\.floor\(Math\.random\(\)/.test(s.text)).map((s) => s.f)).toEqual([]);
  });

  it('never gives the same port twice', async () => {
    const ports = await Promise.all(Array.from({ length: 20 }, () => freePort()));
    expect(new Set(ports).size).toBe(20);
    expect(ports.every((p) => p > 1023)).toBe(true);
  });
});
