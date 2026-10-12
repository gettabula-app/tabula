import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention in days per lake stream (docs/telemetry-design.md section 8). 396 days is 13 months. */
export const RETENTION_DAYS = Object.freeze({
  reports_hourly: 396,
  events: 365,
  errors: 30,
  status: 90,
  alerts: 90,
});

/** @param {Record<string, string | undefined>} [env] */
export function loadConfig(env = process.env) {
  const int = (key, fallback) => {
    const value = Number(env[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  const dataDir = env.TELEMETRY_DATA_DIR || '/data';
  const stateDir = env.COLLECTOR_STATE_DIR || path.join(dataDir, 'state');
  return {
    host: env.COLLECTOR_HOST || '127.0.0.1',
    port: int('COLLECTOR_PORT', 8481),
    stateDir,
    registryFile: env.COLLECTOR_REGISTRY || path.join(stateDir, 'registry.json'),
    deletionsDir: path.join(stateDir, 'deletions'),
    workspacesFile: path.join(stateDir, 'workspaces.json'),
    seenDir: path.join(stateDir, 'seen'),
    fleetRatePerHour: int('COLLECTOR_FLEET_RATE_PER_HOUR', 5000),
    deleteWaitMs: Number.isSafeInteger(Number(env.COLLECTOR_DELETE_WAIT_MS)) && env.COLLECTOR_DELETE_WAIT_MS !== undefined && env.COLLECTOR_DELETE_WAIT_MS !== '' ? Number(env.COLLECTOR_DELETE_WAIT_MS) : 15_000,
    deletionLog: path.join(stateDir, 'deletions.log'),
    lakeDir: env.LAKE_DIR || path.join(dataDir, 'lake'),
    vmUrl: (env.VM_URL || 'http://victoriametrics:8428').replace(/\/+$/, ''),
    lokiUrl: (env.LOKI_URL || 'http://loki:3100').replace(/\/+$/, ''),
    duckdb: env.DUCKDB_BIN || 'duckdb',
    duckdbMemory: env.DUCKDB_MEMORY_LIMIT || '768MB',
    maxBodyBytes: int('COLLECTOR_MAX_BODY_BYTES', 262144),
    ratePerHour: int('COLLECTOR_RATE_PER_HOUR', 6),
    authFailuresPerMinute: int('COLLECTOR_AUTH_FAILURES_PER_MINUTE', 20),
    trustProxy: env.COLLECTOR_TRUST_PROXY === '1',
    maxReportAgeMs: int('COLLECTOR_MAX_REPORT_AGE_HOURS', 72) * 60 * 60 * 1000,
    sinkRetryMs: int('COLLECTOR_SINK_RETRY_MS', 30_000),
    sinkMaxAgeMs: 60 * 60 * 1000,
    sinkMaxQueue: int('COLLECTOR_SINK_MAX_QUEUE', 2000),
    sinkTimeoutMs: int('COLLECTOR_SINK_TIMEOUT_MS', 5000),
    heartbeatFile: path.join(stateDir, 'lake-heartbeat'),
    retentionDays: RETENTION_DAYS,
    dayMs: DAY_MS,
  };
}
