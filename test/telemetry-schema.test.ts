import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_HASH,
  TELEMETRY_SCHEMA,
  deepFreezeJson,
  getEventDefinition,
  getMetricDefinition,
} from '../server/telemetry/schema.mjs';

const metricNames = [
  'http_requests_total', 'http_duration_ms', 'ws_connections_peak', 'ws_connections_avg', 'rooms_open_peak',
  'sync_save_ms', 'sync_load_ms', 'process_rss_bytes', 'event_loop_lag_ms_p95', 'cpu_seconds', 'data_bytes',
  'disk_free_bytes', 'entities_total', 'mcp_calls_total', 'oauth_events_total', 'backup_runs_total',
  'backup_duration_ms', 'backup_bytes', 'restore_runs_total', 'tracker_ops_total', 'chat_messages_total',
  'uploads_total', 'upload_bytes', 'ai_calls_total', 'client_sessions_total', 'ui_events_total', 'scrubber_dropped_total',
];
const metricLabels: Record<string, string[]> = {
  http_requests_total: ['route', 'status_class'],
  http_duration_ms: ['route'],
  ws_connections_peak: [],
  ws_connections_avg: [],
  rooms_open_peak: [],
  sync_save_ms: [],
  sync_load_ms: [],
  process_rss_bytes: [],
  event_loop_lag_ms_p95: [],
  cpu_seconds: [],
  data_bytes: [],
  disk_free_bytes: [],
  entities_total: ['kind'],
  mcp_calls_total: ['auth', 'result', 'tool'],
  oauth_events_total: ['client_kind', 'event'],
  backup_runs_total: ['error_code', 'result'],
  backup_duration_ms: ['error_code', 'result'],
  backup_bytes: ['error_code', 'result'],
  restore_runs_total: ['kind', 'result'],
  tracker_ops_total: ['op'],
  chat_messages_total: ['kind'],
  uploads_total: ['kind', 'size_bucket'],
  upload_bytes: ['kind', 'size_bucket'],
  ai_calls_total: ['feature', 'result'],
  client_sessions_total: ['browser', 'device', 'installed', 'os'],
  ui_events_total: ['event'],
  scrubber_dropped_total: ['reason'],
};

type FieldDescriptor = {
  type: string;
  values?: unknown[];
  fields?: Record<string, FieldDescriptor>;
  items?: FieldDescriptor;
};
type MetricDescriptor = { labels?: Record<string, FieldDescriptor> } & (
  | { kind: 'histogram'; buckets: number[] }
  | { kind: 'counter' | 'gauge'; min: number; max: number }
);
type EventDescriptor = { kind: string; fields: Record<string, FieldDescriptor> };

function expectAt(path: string, condition: boolean): void {
  expect([path, condition]).toEqual([path, true]);
}

function validateIntegerDescriptor(descriptor: any, path: string): void {
  expectAt(path, Number.isSafeInteger(descriptor.min));
  expectAt(path, Number.isSafeInteger(descriptor.max));
  expect(descriptor.min).toBeLessThanOrEqual(descriptor.max);
  expectAt(path, descriptor.multipleOf === undefined || descriptor.multipleOf > 0);
}

function validateEnumDescriptor(descriptor: any, path: string): void {
  expectAt(path, Array.isArray(descriptor.values));
  expect(descriptor.values.length).toBeGreaterThan(0);
  expect(new Set(descriptor.values).size).toBe(descriptor.values.length);
}

function validateStringDescriptor(descriptor: any, path: string): void {
  expectAt(path, typeof descriptor.pattern === 'string');
  expectAt(path, descriptor.pattern.startsWith('^'));
  expectAt(path, descriptor.pattern.endsWith('$'));
  expectAt(path, Number.isSafeInteger(descriptor.maxLength));
  expect(descriptor.maxLength).toBeGreaterThan(0);
}

function validateArrayDescriptor(descriptor: any, path: string): void {
  expectAt(path, Number.isSafeInteger(descriptor.maxItems));
  expect(descriptor.maxItems).toBeGreaterThanOrEqual(0);
  validateFieldDescriptor(descriptor.items, `${path}[]`);
}

function validateObjectDescriptor(descriptor: any, path: string): void {
  for (const [name, field] of Object.entries(descriptor.fields)) validateFieldDescriptor(field, `${path}.${name}`);
}

function validateFieldDescriptor(descriptor: any, path: string): void {
  expect(descriptor).toBeTruthy();
  const validators: Record<string, (field: any, fieldPath: string) => void> = {
    int: validateIntegerDescriptor,
    enum: validateEnumDescriptor,
    string: validateStringDescriptor,
    array: validateArrayDescriptor,
    object: validateObjectDescriptor,
    bool: () => {},
  };
  const validate = validators[descriptor.type];
  if (!validate) throw new Error(`${path} has an unconstrained or unsupported field type`);
  validate(descriptor, path);
}

describe('telemetry schema catalogue', () => {
  it('declares every design metric with a bounded value and closed label sets', () => {
    expect(Object.keys(TELEMETRY_SCHEMA.metrics).sort()).toEqual([...metricNames].sort());
    for (const [name, descriptor] of Object.entries(TELEMETRY_SCHEMA.metrics as Record<string, MetricDescriptor>)) {
      expect(['counter', 'gauge', 'histogram']).toContain(descriptor.kind);
      expect(Object.keys(descriptor.labels ?? {}).sort()).toEqual(metricLabels[name]);
      const validValueDefinition = descriptor.kind === 'histogram'
        ? Array.isArray(descriptor.buckets) && descriptor.buckets.length > 0 && descriptor.buckets.every((value: number, index: number) => index === 0 || descriptor.buckets[index - 1] < value)
        : Number.isSafeInteger(descriptor.min) && Number.isSafeInteger(descriptor.max) && descriptor.min <= descriptor.max;
      expectAt(name, validValueDefinition);
      for (const [labelName, label] of Object.entries(descriptor.labels ?? {})) {
        validateFieldDescriptor(label, `${name}.${labelName}`);
        expect(label.values).toContain('other');
      }
    }
  });

  it('declares every event, error, alert and envelope field with explicit constraints', () => {
    expect(Object.keys(TELEMETRY_SCHEMA.events).sort()).toEqual([
      'error_rate_day', 'feature_used', 'milestone', 'upgrade_result', 'workspace_day', 'workspace_hour',
    ]);
    expect(Object.keys(TELEMETRY_SCHEMA.envelope.fields).sort()).toEqual([
      'app_version', 'connections_now', 'connections_peak', 'hour', 'last_activity_at', 'mode', 'node_major',
      'platform', 'schema', 'schema_chat', 'schema_directory', 'workspace',
    ]);
    expect(Object.keys(TELEMETRY_SCHEMA.fleetEnvelope.fields).sort()).toEqual(['hour', 'kind', 'schema', 'workspace']);
    expect(Object.keys(TELEMETRY_SCHEMA.errors.fields).sort()).toEqual(['code', 'count', 'fingerprint', 'kind', 'status', 'top_frame']);
    expect(Object.keys(TELEMETRY_SCHEMA.alerts.fields).sort()).toEqual(['at', 'kind', 'severity', 'workspace']);
    const eventFields = {
      workspace_day: ['app_version', 'boards', 'dau', 'features_used', 'mode', 'tickets', 'wau'],
      workspace_hour: ['app_version', 'backup_age_hours', 'backup_state', 'disk_total_bytes', 'disk_used_bytes', 'guests_used', 'machine', 'members_used', 'plan', 'seats_paid', 'seats_used', 'state'],
      feature_used: ['count', 'feature'],
      milestone: ['name'],
      upgrade_result: ['duration_ms', 'from', 'result', 'to'],
      error_rate_day: ['top_codes'],
    };
    for (const [name, fields] of Object.entries(eventFields)) {
      expect(Object.keys(TELEMETRY_SCHEMA.events[name].fields).sort()).toEqual(fields);
    }
    for (const [name, descriptor] of Object.entries(TELEMETRY_SCHEMA.envelope.fields)) validateFieldDescriptor(descriptor, `envelope.${name}`);
    for (const [name, descriptor] of Object.entries(TELEMETRY_SCHEMA.fleetEnvelope.fields)) validateFieldDescriptor(descriptor, `fleetEnvelope.${name}`);
    for (const [name, descriptor] of Object.entries(TELEMETRY_SCHEMA.events as Record<string, EventDescriptor>)) {
      expect(descriptor.kind).toBe('event');
      for (const [fieldName, field] of Object.entries(descriptor.fields)) validateFieldDescriptor(field, `${name}.${fieldName}`);
    }
    const eventGroups = {
      errors: TELEMETRY_SCHEMA.errors,
      alerts: TELEMETRY_SCHEMA.alerts,
    } as Record<string, EventDescriptor>;
    for (const [name, descriptor] of Object.entries(eventGroups)) {
      expect(descriptor.kind).toBe('event');
      for (const [fieldName, field] of Object.entries(descriptor.fields)) validateFieldDescriptor(field, `${name}.${fieldName}`);
    }
  });

  it('includes the approved feature and milestone enum values', () => {
    expect(TELEMETRY_SCHEMA.events.workspace_hour.source).toBe('control_plane');
    expect(TELEMETRY_SCHEMA.events.workspace_hour.fields.state.values).toEqual([
      'pending_checkout', 'provisioning', 'trialing', 'active', 'past_due', 'read_only', 'suspended', 'deleting', 'deleted', 'failed', 'other',
    ]);
    expect(TELEMETRY_SCHEMA.events.workspace_hour.fields.machine.values).toEqual(['started', 'stopped', 'other']);
    expect(TELEMETRY_SCHEMA.events.workspace_hour.fields.plan.values).toEqual(['paid', 'comp', 'other']);
    expect(TELEMETRY_SCHEMA.events.workspace_hour.fields.backup_state.values).toEqual([
      'off', 'unsupported', 'ok', 'failing', 'stale', 'never', 'unreachable', 'unknown',
    ]);
    for (const name of ['seats_paid', 'seats_used', 'guests_used', 'members_used', 'disk_used_bytes', 'disk_total_bytes', 'backup_age_hours', 'app_version']) {
      expect(TELEMETRY_SCHEMA.events.workspace_hour.fields[name].optional).toBe(true);
      expect(TELEMETRY_SCHEMA.events.workspace_hour.fields[name]).not.toHaveProperty('nullable');
    }
    expect(TELEMETRY_SCHEMA.events.workspace_hour.fields.backup_age_hours.max).toBe(87600);
    expect(TELEMETRY_SCHEMA.fleetEnvelope.fields.kind.values).toEqual(['fleet']);
    expect(TELEMETRY_SCHEMA.fleetEnvelope.fields.hour.multipleOf).toBe(3600000);
    expect(TELEMETRY_SCHEMA.events.workspace_day.fields.features_used.items.values).toEqual([
      'board_text', 'board_kanban', 'board_sticky', 'board_drawing', 'board_image', 'tracker_ticket', 'tracker_view',
      'tracker_import', 'chat', 'mcp_token', 'mcp_oauth', 'backup_restore', 'ai_assist', 'export', 'guest_invite',
    ]);
    expect(TELEMETRY_SCHEMA.events.milestone.fields.name.values).toEqual([
      'first_board', 'first_ticket', 'first_member_invited', 'first_mcp_connect', 'first_oauth_grant', 'first_backup',
      'first_chat_message', 'tracker_enabled',
    ]);
  });

  it('freezes the parsed JSON helpers and hashes the exact schema bytes', () => {
    const source = readFileSync(new URL('../server/telemetry/schema.json', import.meta.url));
    expect(SCHEMA_HASH).toBe(createHash('sha256').update(source).digest('hex'));
    expect(SCHEMA_HASH).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(TELEMETRY_SCHEMA)).toBe(true);
    expect(Object.isFrozen(TELEMETRY_SCHEMA.metrics.http_requests_total.labels.route.values)).toBe(true);
    expect(getMetricDefinition('http_requests_total')).toBe(TELEMETRY_SCHEMA.metrics.http_requests_total);
    expect(getMetricDefinition('constructor')).toBeUndefined();
    expect(getMetricDefinition('__proto__')).toBeUndefined();
    expect(getEventDefinition('workspace_day')).toBe(TELEMETRY_SCHEMA.events.workspace_day);
    expect(getEventDefinition('workspace_hour')).toBe(TELEMETRY_SCHEMA.events.workspace_hour);
    expect(getEventDefinition('unknown')).toBeUndefined();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(deepFreezeJson(cyclic)).toBe(cyclic);
    expect(Object.isFrozen(cyclic)).toBe(true);
  });

  it('states the required hard limits and uses only bounded drop reasons', () => {
    expect(TELEMETRY_SCHEMA.schema).toBe(1);
    expect(TELEMETRY_SCHEMA.limits).toEqual({
      maxBytes: 262144,
      maxEvents: 1000,
      maxLabelCombinationsPerMetric: 200,
      maxErrorFingerprints: 50,
    });
    expect(TELEMETRY_SCHEMA.droppedReasons).toContain('invalid_label');
    expect(new Set(TELEMETRY_SCHEMA.droppedReasons).size).toBe(TELEMETRY_SCHEMA.droppedReasons.length);
  });
});
