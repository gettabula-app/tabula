import { TELEMETRY_SCHEMA, getMetricDefinition } from '../server/telemetry/schema.mjs';

const schema = TELEMETRY_SCHEMA as any;
export const WORKSPACE = 'ws_8M2kW4p7nQ1Z';
export const HOUR = 1791676800000; // 2026-10-11T00:00:00Z

function metric(name: string): any {
  const definition = getMetricDefinition(name) as any;
  const labels = Object.fromEntries(Object.entries(definition.labels ?? {}).map(([key, label]: [string, any]) => [key, label.values.find((value: string) => value !== 'other')]));
  const value = definition.kind === 'histogram'
    ? { count: 1, sum: 1, buckets: Array(definition.buckets.length + 1).fill(1) }
    : 1;
  return { name, labels, value };
}

export function validReport(overrides: Record<string, unknown> = {}): any {
  return {
    schema: 1,
    hour: HOUR,
    app_version: 'v1.2.3',
    schema_directory: 5,
    schema_chat: 3,
    node_major: 22,
    platform: 'linux',
    mode: 'hosted',
    connections_now: 2,
    connections_peak: 5,
    last_activity_at: 1791676740000,
    workspace: WORKSPACE,
    metrics: Object.keys(schema.metrics).filter((name) => schema.metrics[name].source !== 'control_plane').map(metric),
    errors: [{ fingerprint: 'abcdef0123456789', code: 'not_found', kind: 'api', status: 404, top_frame: 'server/api.mjs:27', count: 3 }],
    events: [],
    alerts: [],
    ...overrides,
  };
}

/** The events only the control plane may send (the scrubber drops them from an instance report): for reports posted with a control-plane token. */
export const CONTROL_PLANE_EVENTS = [
  { event: 'workspace_day', dau: 4, wau: 8, boards: 3, tickets: 2, features_used: ['board_text', 'chat'], app_version: 'v1.2.3', mode: 'hosted' },
  { event: 'upgrade_result', from: 'v1.2.2', to: 'v1.2.3', result: 'ok', duration_ms: 1200 },
  { event: 'error_rate_day', top_codes: [{ code: 'not_found', count: 2 }] },
];
