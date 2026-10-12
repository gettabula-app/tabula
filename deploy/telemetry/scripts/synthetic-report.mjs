#!/usr/bin/env node
// Prints one small, valid synthetic hourly report (workspace id from argv[2]) for the current hour. For smoke tests only.
const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const workspace = process.argv[2] || 'ws_smoketest0001';
const buckets = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
const cumulative = [...buckets.map((_, i) => (i < 4 ? 0 : 10)), 10];
process.stdout.write(JSON.stringify({
  schema: 1, hour, app_version: 'v0.0.1', schema_directory: 1, schema_chat: 1, node_major: 22, platform: 'linux', mode: 'self',
  connections_now: 3, connections_peak: 7, last_activity_at: Math.floor(hour / 60_000) * 60_000, workspace,
  metrics: [
    { name: 'http_requests_total', labels: { route: 'health', status_class: '2xx' }, value: 120 },
    { name: 'http_requests_total', labels: { route: 'boards/:id', status_class: '5xx' }, value: 2 },
    { name: 'http_duration_ms', labels: { route: 'health' }, value: { count: 10, sum: 300, buckets: cumulative } },
    { name: 'process_rss_bytes', labels: {}, value: 150_000_000 },
    { name: 'data_bytes', labels: {}, value: 5_000_000 },
    { name: 'disk_free_bytes', labels: {}, value: 20_000_000_000 },
    { name: 'backup_runs_total', labels: { result: 'ok', error_code: 'other' }, value: 4 },
  ],
  errors: [{ fingerprint: '0123456789abcdef', code: 'not_found', kind: 'api', status: 404, top_frame: 'server/api.mjs:27', count: 2 }],
  events: [], alerts: [],
}));
