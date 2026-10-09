export function percentile(values, p) {
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new RangeError('percentile must be from 0 to 100');
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** @param {Record<string, number>} [errors] @param {unknown | null} [relayExit] */
export function errorCount(errors = {}, relayExit = null) {
  const count = Object.values(errors).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  return count + (relayExit === null ? 0 : 1);
}

/** @param {{ errors?: number, relayExit?: unknown | null, latencyP95Ms?: number | null, generatorLagP95Ms?: number | null }} [input] */
export function verdict({ errors = 0, relayExit = null, latencyP95Ms = null, generatorLagP95Ms = null } = {}) {
  if (errors > 0 || relayExit !== null) return 'FAILING: errors or exit';
  if (latencyP95Ms !== null && latencyP95Ms > 500) return 'DEGRADED: p95 over 500 ms';
  if (generatorLagP95Ms !== null && generatorLagP95Ms > 50) return 'DEGRADED: generator lag; latency not trustworthy';
  return 'OK';
}

export function summaryRows(steps) {
  return steps.map((step) => {
    const errors = errorCount(step.errors, step.relayExit);
    return {
      users: step.users,
      connectedUsers: step.connectedUsers,
      relayPeakRssMb: step.relay?.rssPeakBytes == null ? null : step.relay.rssPeakBytes / 1024 / 1024,
      relayEndRssMb: step.relay?.rssEndBytes == null ? null : step.relay.rssEndBytes / 1024 / 1024,
      cpuAveragePct: step.relay?.cpuAveragePct ?? null,
      cpuPeak5sPct: step.relay?.cpuPeak5sPct ?? null,
      syncP50Ms: step.syncLatencyMs?.p50 ?? null,
      syncP95Ms: step.syncLatencyMs?.p95 ?? null,
      joinP95Ms: step.joinMs?.p95 ?? null,
      errors,
      verdict: step.verdict ?? verdict({ errors, relayExit: step.relayExit, latencyP95Ms: step.syncLatencyMs?.p95, generatorLagP95Ms: step.generatorLagMs?.p95 }),
    };
  });
}
