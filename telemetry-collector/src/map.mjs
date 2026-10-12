import { TELEMETRY_SCHEMA } from '../../server/telemetry/schema.mjs';

/**
 * Series naming. The instance sends per-hour values, so counters are per-hour increments, not running totals:
 * they are exported as `tabula_<name>_hourly` and read with sum_over_time, never rate().
 */
export function vmName(name, kind) {
  if (kind === 'counter') return `tabula_${name.replace(/_total$/u, '')}_hourly`;
  return `tabula_${name}`;
}

/** Every VictoriaMetrics series name the collector can write (used by tests to check the dashboards). */
export function allSeriesNames() {
  const names = new Set([
    'tabula_connections_now', 'tabula_connections_peak', 'tabula_last_activity_timestamp_seconds', 'tabula_report_info',
    'tabula_report_received_timestamp_seconds', 'tabula_schema_directory', 'tabula_schema_chat',
  ]);
  for (const [name, def] of Object.entries(TELEMETRY_SCHEMA.metrics)) {
    if (def.source === 'control_plane') continue;
    const base = vmName(name, def.kind);
    if (def.kind === 'histogram') for (const suffix of ['_bucket', '_sum', '_count']) names.add(base + suffix);
    else names.add(base);
  }
  return names;
}

function sample(name, labels, value, timestamp) {
  return { metric: { __name__: name, ...labels }, values: [value], timestamps: [timestamp] };
}

/** Clean report to VictoriaMetrics JSON-line import objects (one sample per series at the report hour). */
export function reportToVm(clean, receivedAt) {
  const ws = { workspace: clean.workspace };
  const at = clean.hour;
  const out = [];
  const gaugeEnvelope = [['connections_now', 'tabula_connections_now'], ['connections_peak', 'tabula_connections_peak'], ['schema_directory', 'tabula_schema_directory'], ['schema_chat', 'tabula_schema_chat']];
  for (const [field, name] of gaugeEnvelope) if (Number.isFinite(clean[field])) out.push(sample(name, ws, clean[field], at));
  if (Number.isFinite(clean.last_activity_at)) out.push(sample('tabula_last_activity_timestamp_seconds', ws, Math.floor(clean.last_activity_at / 1000), at));
  const info = { ...ws };
  for (const key of ['app_version', 'mode', 'platform']) if (typeof clean[key] === 'string') info[key] = clean[key];
  if (Number.isFinite(clean.node_major)) info.node_major = String(clean.node_major);
  out.push(sample('tabula_report_info', info, 1, at));
  out.push(sample('tabula_report_received_timestamp_seconds', ws, Math.floor(receivedAt / 1000), at));

  for (const metric of clean.metrics) {
    const def = TELEMETRY_SCHEMA.metrics[metric.name];
    if (!def) continue;
    const labels = { ...ws, ...metric.labels };
    const base = vmName(metric.name, def.kind);
    if (def.kind === 'histogram') {
      const bounds = def.buckets;
      const { count, sum, buckets } = metric.value;
      if (!Array.isArray(buckets) || buckets.length !== bounds.length + 1) continue;
      bounds.forEach((bound, i) => out.push(sample(`${base}_bucket`, { ...labels, le: String(bound) }, buckets[i], at)));
      out.push(sample(`${base}_bucket`, { ...labels, le: '+Inf' }, buckets[bounds.length], at));
      out.push(sample(`${base}_sum`, labels, sum, at));
      out.push(sample(`${base}_count`, labels, count, at));
    } else {
      out.push(sample(base, labels, metric.value, at));
    }
  }
  return out;
}

const OPERATING_EVENTS = new Set(['upgrade_result', 'error_rate_day']);

/**
 * Loki streams: one line per error fingerprint (code, kind, status, top frame, count: no message text exists in the schema),
 * the operating events, and one counts-only line per report. Labels are low-cardinality; `workspace` is a label so
 * deletion by workspace id is a single selector.
 */
export function reportToLoki(clean) {
  const ts = `${BigInt(clean.hour) * 1_000_000n}`;
  const streams = new Map();
  const add = (kind, line, extra = {}) => {
    const labels = { job: 'tabula-telemetry', workspace: clean.workspace, kind, ...extra };
    const key = JSON.stringify(labels);
    if (!streams.has(key)) streams.set(key, { stream: labels, values: [] });
    streams.get(key).values.push([ts, JSON.stringify(line)]);
  };
  add('report', { metrics: clean.metrics.length, errors: clean.errors.length, events: clean.events.length, app_version: clean.app_version, mode: clean.mode });
  for (const error of clean.errors) add('error', error, { error_kind: error.kind });
  for (const event of clean.events) if (OPERATING_EVENTS.has(event.event)) add('event', event, { event: event.event });
  return { streams: [...streams.values()] };
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Flat rows for the lake spool (one fixed column set; see lake.mjs LAKE_COLUMNS). */
export function reportToRows(clean, receivedAt) {
  const dt = dayOf(clean.hour);
  const base = { dt, workspace: clean.workspace, hour: clean.hour, schema: clean.schema, received_at: receivedAt };
  const rows = [];
  rows.push({
    ...base, stream: 'status', name: 'status', kind: null,
    data: JSON.stringify({
      app_version: clean.app_version, mode: clean.mode, platform: clean.platform, node_major: clean.node_major,
      schema_directory: clean.schema_directory, schema_chat: clean.schema_chat,
      connections_now: clean.connections_now, connections_peak: clean.connections_peak, last_activity_at: clean.last_activity_at,
    }),
  });
  for (const metric of clean.metrics) {
    const def = TELEMETRY_SCHEMA.metrics[metric.name];
    const row = { ...base, stream: 'reports_hourly', name: metric.name, kind: def?.kind ?? null, labels: JSON.stringify(metric.labels ?? {}) };
    if (def?.kind === 'histogram') {
      row.count = metric.value.count;
      row.sum = metric.value.sum;
      row.buckets = JSON.stringify(metric.value.buckets);
    } else {
      row.value = metric.value;
    }
    rows.push(row);
  }
  for (const error of clean.errors) {
    rows.push({ ...base, stream: 'errors', name: error.code, kind: error.kind, status: error.status, fingerprint: error.fingerprint, top_frame: error.top_frame, count: error.count });
  }
  for (const { event, ...fields } of clean.events) {
    rows.push({ ...base, stream: 'events', name: event, data: JSON.stringify(fields) });
  }
  return rows;
}
