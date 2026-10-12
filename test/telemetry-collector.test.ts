import { describe, expect, it } from 'vitest';
import { createTelemetryCollector } from '../server/telemetry/collector.mjs';
import { getMetricDefinition } from '../server/telemetry/schema.mjs';

type LabelDescriptor = { values: string[] } | string[];
const labelsFor = (name: string) => Object.fromEntries(Object.entries(
  (getMetricDefinition(name) as { labels?: Record<string, LabelDescriptor> } | undefined)?.labels ?? {},
).map(([key, definition]) => {
  const values = Array.isArray(definition) ? definition : definition.values;
  return [key, values[0]];
}));

const envelope = () => ({
  schema: 1,
  hour: 1_800_000_000_000,
  app_version: 'v0.1.0',
  schema_directory: 12,
  schema_chat: 1,
  node_major: 24,
  platform: 'linux',
  mode: 'hosted',
  workspace: 'ws_telemetry',
  connections_now: 0,
  connections_peak: 0,
  last_activity_at: null,
});

describe('hourly telemetry collector', () => {
  it('aggregates counters, fixed-bucket histograms and gauges into a scrubbed preview', () => {
    let now = 1_800_000_000_100;
    const collector = createTelemetryCollector({ enabled: () => true, now: () => now, envelope });
    expect(collector.count('http_requests_total', labelsFor('http_requests_total'), 3)).toBe(true);
    expect(collector.observe('http_duration_ms', 12, labelsFor('http_duration_ms'))).toBe(true);
    expect(collector.gauge('process_rss_bytes', 4096)).toBe(true);

    const result = collector.snapshot() as { clean: { hour: number; metrics: unknown[] } | null; dropped: { total: number } };
    const clean = result.clean!;
    expect(clean).toMatchObject({ schema: 1, hour: 1_800_000_000_000 });
    expect(clean.metrics).toContainEqual(expect.objectContaining({ name: 'http_requests_total', value: 3 }));
    expect(clean.metrics).toContainEqual(expect.objectContaining({
      name: 'http_duration_ms',
      value: expect.objectContaining({ count: 1, sum: 12, buckets: expect.any(Array) }),
    }));
    expect(clean.metrics).toContainEqual(expect.objectContaining({ name: 'process_rss_bytes', value: 4096 }));
    expect(result.dropped.total).toBe(0);
    now += 3_600_000;
    const next = collector.snapshot().clean as unknown as { hour: number; metrics: unknown[] };
    expect(next.hour).toBe(1_800_003_600_000);
    expect(next.metrics).toEqual([]);
  });

  it('stores nothing while disabled and clears accumulated values when disabled', () => {
    let active = true;
    const collector = createTelemetryCollector({ enabled: () => active, now: () => 1_800_000_000_100, envelope });
    expect(collector.count('http_requests_total', labelsFor('http_requests_total'))).toBe(true);
    active = false;
    expect(collector.count('http_requests_total', labelsFor('http_requests_total'))).toBe(false);
    active = true;
    expect((collector.snapshot().clean as unknown as { metrics: unknown[] }).metrics).toEqual([]);
  });

  it('keeps hosted operating data and omits every feature-use metric from an analytics-off report', () => {
    let analytics = true;
    const now = 1_800_000_000_100;
    const collector = createTelemetryCollector({ enabled: () => true, analyticsEnabled: () => analytics, now: () => now, envelope });
    expect(collector.count('http_requests_total', labelsFor('http_requests_total'), 2)).toBe(true);
    expect(collector.count('chat_messages_total', labelsFor('chat_messages_total'), 3)).toBe(true);
    expect(collector.count('ai_calls_total', labelsFor('ai_calls_total'), 1)).toBe(true);
    expect(collector.count('client_sessions_total', labelsFor('client_sessions_total'), 4)).toBe(true);
    expect(collector.count('backup_runs_total', labelsFor('backup_runs_total'), 2)).toBe(true);
    expect(collector.observe('backup_duration_ms', 45, labelsFor('backup_duration_ms'))).toBe(true);
    expect(collector.count('backup_bytes', labelsFor('backup_bytes'), 4096)).toBe(true);
    expect(collector.count('restore_runs_total', labelsFor('restore_runs_total'), 1)).toBe(true);
    expect(collector.gauge('entities_total', 7, { kind: 'boards' })).toBe(true);

    analytics = false;
    const report = collector.snapshot().clean as unknown as { metrics: { name: string; labels: Record<string, string>; value: unknown }[]; errors: unknown[] };
    const names = report.metrics.map((metric) => metric.name);
    expect(names).toContain('http_requests_total');
    expect(report.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'backup_runs_total' }),
      expect.objectContaining({ name: 'backup_duration_ms' }),
      expect.objectContaining({ name: 'backup_bytes' }),
      expect.objectContaining({ name: 'restore_runs_total' }),
      expect.objectContaining({ name: 'entities_total', labels: { kind: 'boards' }, value: 7 }),
    ]));
    expect(report.errors).toEqual([]);
    expect(names).not.toContain('chat_messages_total');
    expect(names).not.toContain('ai_calls_total');
    expect(names).not.toContain('client_sessions_total');
    expect(JSON.stringify(report)).not.toMatch(/feature_used|chat_messages_total|ai_calls_total|client_sessions_total|ui_events_total|mcp_calls_total|oauth_events_total|tracker_ops_total|uploads_total|upload_bytes/u);
    expect(collector.count('chat_messages_total', labelsFor('chat_messages_total'))).toBe(false);
    expect(collector.count('http_requests_total', labelsFor('http_requests_total'))).toBe(true);

    collector.resetProductAnalytics();
    analytics = true;
    expect((collector.snapshot().clean as unknown as { metrics: { name: string }[] }).metrics.map((metric) => metric.name)).not.toContain('chat_messages_total');
    expect((collector.snapshot().clean as unknown as { metrics: { name: string }[] }).metrics.map((metric) => metric.name)).toContain('backup_runs_total');
  });

  it('maps invalid metric label values to the closed other label without retaining submitted text', () => {
    const labels = labelsFor('http_requests_total');
    const first = Object.keys(labels)[0];
    const collector = createTelemetryCollector({ enabled: () => true, now: () => 1_800_000_000_100, envelope });
    collector.count('http_requests_total', { ...labels, [first]: 'https://private.example.test/path?id=secret' });
    const serialized = JSON.stringify(collector.snapshot().clean);
    expect(serialized).not.toContain('private.example.test');
    expect(serialized).toContain('"other"');
  });
});
