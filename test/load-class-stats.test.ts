import { describe, expect, it } from 'vitest';
import { errorCount, percentile, summaryRows, verdict } from '../scripts/lib/load-class-stats.mjs';

describe('class load summaries', () => {
  it('uses nearest-rank percentiles without changing the input', () => {
    const values = [9, 1, 5, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 95)).toBe(9);
    expect(values).toEqual([9, 1, 5, 3]);
    expect(percentile([], 95)).toBeNull();
  });

  it('counts numeric errors and a relay exit', () => {
    expect(errorCount({ chatRateLimited: 2, failedSignIns: 1 }, null)).toBe(3);
    expect(errorCount({}, { code: 1, signal: null })).toBe(1);
  });

  it('applies the requested verdict order', () => {
    expect(verdict()).toBe('OK');
    expect(verdict({ latencyP95Ms: 501 })).toBe('DEGRADED: p95 over 500 ms');
    expect(verdict({ generatorLagP95Ms: 51 })).toBe('DEGRADED: generator lag; latency not trustworthy');
    expect(verdict({ errors: 1, latencyP95Ms: 900 })).toBe('FAILING: errors or exit');
    expect(verdict({ relayExit: { code: 0 } })).toBe('FAILING: errors or exit');
  });

  it('builds compact, printable rows from step metrics', () => {
    expect(summaryRows([{
      users: 30,
      connectedUsers: 30,
      relay: { rssPeakBytes: 2 * 1024 * 1024, rssEndBytes: 1024 * 1024, cpuAveragePct: 20, cpuPeak5sPct: 35 },
      syncLatencyMs: { p50: 30, p95: 90, max: 120 },
      joinMs: { p50: 100, p95: 200 },
      errors: { websocketErrors: 0 },
    }])).toEqual([{
      users: 30,
      connectedUsers: 30,
      relayPeakRssMb: 2,
      relayEndRssMb: 1,
      cpuAveragePct: 20,
      cpuPeak5sPct: 35,
      syncP50Ms: 30,
      syncP95Ms: 90,
      joinP95Ms: 200,
      errors: 0,
      verdict: 'OK',
    }]);
  });
});
