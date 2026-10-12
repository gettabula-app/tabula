#!/usr/bin/env node
// Generates the Grafana dashboards in ../grafana/dashboards from the definitions below, so every panel is code that is
// reviewed in a diff. `node deploy/telemetry/scripts/gen-dashboards.mjs` rewrites the JSON; a test checks that it is in sync.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VM = { type: 'prometheus', uid: 'tabula-vm' };
const LOKI = { type: 'loki', uid: 'tabula-loki' };
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grafana', 'dashboards');

// Reports arrive once an hour, so every query reads an hour at a time: counters are per-hour increments
// (sum_over_time), gauges use last_over_time, and a panel step is never below one hour.
const WS = 'workspace=~"$workspace"';

let nextId = 1;

function panel(type, title, x, y, w, h, targets, { ds = VM, unit, options, fieldConfig, transformations, description } = {}) {
  const p = {
    id: nextId++, type, title, gridPos: { x, y, w, h }, datasource: ds,
    targets: targets.map((t, i) => ({ datasource: ds, ...t, refId: String.fromCharCode(65 + i) })),
    fieldConfig: { defaults: { ...(unit && { unit }), ...fieldConfig?.defaults }, overrides: fieldConfig?.overrides ?? [] },
  };
  if (options) p.options = options;
  if (transformations) p.transformations = transformations;
  if (description) p.description = description;
  return p;
}
const ts = (title, x, y, w, h, targets, opts = {}) => panel('timeseries', title, x, y, w, h, targets.map((t) => ((opts.ds ?? VM) === VM ? { interval: '1h', ...t } : t)), { ...opts, options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } } });
const stat = (title, x, y, w, h, expr, opts = {}) => panel('stat', title, x, y, w, h, [{ expr, instant: true }], { ...opts, options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'none', graphMode: 'none' } });
const logs = (title, x, y, w, h, expr) => panel('logs', title, x, y, w, h, [{ expr, queryType: 'range' }], { ds: LOKI, options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending' } });
const table = (title, x, y, w, h, targets, transformations = [{ id: 'merge', options: {} }], opts = {}) =>
  panel('table', title, x, y, w, h, targets.map((t) => ({ instant: true, format: 'table', ...t })), { ...opts, transformations });

const hourly = (name, filter = '') => `sum_over_time(${name}${filter}[1h])`;
const gauge = (name, filter = '') => `last_over_time(${name}${filter}[3h])`;
const quantile = (q, base, filter = '') => `histogram_quantile(${q}, sum by (le) (sum_over_time(${base}_bucket${filter}[1h])))`;

function dashboard(uid, title, panels, { templated = false, description = '' } = {}) {
  return {
    uid, title, description, schemaVersion: 39, version: 1, editable: false, graphTooltip: 1, timezone: 'utc',
    tags: ['tabula', 'telemetry'], time: { from: 'now-7d', to: 'now' }, refresh: '',
    templating: { list: templated ? [{
      name: 'workspace', label: 'Workspace', type: 'query', datasource: VM, query: { query: 'label_values(tabula_report_info, workspace)', refId: 'ws' },
      refresh: 2, includeAll: true, allValue: '.*', multi: true, current: { selected: true, text: 'All', value: '$__all' }, sort: 1,
    }] : [] },
    panels,
  };
}

const fleetGauge = (name) => `last_over_time(${name}[3h])`;
const lastSeenAge = 'time() - max by (workspace) (last_over_time(tabula_report_received_timestamp_seconds[14d]))';

const dashboards = {
  'fleet-overview': dashboard('tabula-fleet', 'Fleet overview', [
    stat('Workspaces reporting (last 3 h)', 0, 0, 4, 4, 'count(max by (workspace) (last_over_time(tabula_report_received_timestamp_seconds[3h])))'),
    stat('Silent for over 3 h (seen in 14 d)', 4, 0, 4, 4, `count((${lastSeenAge}) > 10800) or vector(0)`, { description: 'Workspaces that reported within 14 days but not in the last 3 hours.' }),
    stat('Connections now (sum)', 8, 0, 4, 4, `sum(${gauge('tabula_connections_now')})`),
    stat('Lowest disk free', 12, 0, 4, 4, `min(${gauge('tabula_disk_free_bytes')})`, { unit: 'bytes' }),
    stat('Failed backups, last 24 h', 16, 0, 4, 4, `sum(sum_over_time(tabula_backup_runs_hourly{result="failed"}[24h])) or vector(0)`),
    stat('5xx responses, last 24 h', 20, 0, 4, 4, `sum(sum_over_time(tabula_http_requests_hourly{status_class="5xx"}[24h])) or vector(0)`),
    table('Workspaces', 0, 4, 24, 9, [
      { expr: lastSeenAge, legendFormat: '' },
      { expr: gauge('tabula_connections_now'), legendFormat: '' },
      { expr: gauge('tabula_data_bytes'), legendFormat: '' },
      { expr: gauge('tabula_process_rss_bytes'), legendFormat: '' },
    ], [
      { id: 'joinByField', options: { byField: 'workspace', mode: 'outer' } },
      { id: 'organize', options: { excludeByName: { Time: true, 'Time 1': true, 'Time 2': true, 'Time 3': true, 'Time 4': true }, renameByName: { 'Value #A': 'Seconds since last report', 'Value #B': 'Connections now', 'Value #C': 'Data bytes', 'Value #D': 'RSS bytes' } } },
    ], { description: 'One row per workspace id. Ids only: no names or emails exist in the data.' }),
    ts('Version adoption (workspaces per version)', 0, 13, 12, 8, [{ expr: 'count by (app_version) (last_over_time(tabula_report_info[3h]))', legendFormat: '{{app_version}}' }]),
    ts('Connections peak by workspace', 12, 13, 12, 8, [{ expr: gauge('tabula_connections_peak'), legendFormat: '{{workspace}}' }]),
    ts('Requests per hour by status class', 0, 21, 12, 8, [{ expr: `sum by (status_class) (${hourly('tabula_http_requests_hourly')})`, legendFormat: '{{status_class}}' }]),
    ts('HTTP duration p95 (all routes)', 12, 21, 12, 8, [{ expr: quantile(0.95, 'tabula_http_duration_ms'), legendFormat: 'p95' }], { unit: 'ms' }),
    ts('Data size by workspace', 0, 29, 12, 8, [{ expr: gauge('tabula_data_bytes'), legendFormat: '{{workspace}}' }], { unit: 'bytes' }),
    ts('Disk free by workspace', 12, 29, 12, 8, [{ expr: gauge('tabula_disk_free_bytes'), legendFormat: '{{workspace}}' }], { unit: 'bytes' }),
    ts('Collector: reports accepted and rejected', 0, 37, 24, 7, [
      { expr: 'increase(tabula_collector_reports_accepted_total[1h])', legendFormat: 'accepted', interval: '1m' },
      { expr: 'sum by (reason) (increase(tabula_collector_reports_rejected_total[1h]))', legendFormat: 'rejected: {{reason}}', interval: '1m' },
    ]),
    // The control plane's own view (fleet snapshots): every workspace, also the ones that auto-stop and send no instance report.
    table('All workspaces, control plane view', 0, 44, 24, 9, [
      // Newest info sample per workspace: a changed label (state, machine, backup) leaves the old series in the 3 h window, and only the latest may show.
      { expr: 'topk by (workspace) (1, timestamp(last_over_time(tabula_fleet_workspace_info[3h])))', legendFormat: '' },
      { expr: fleetGauge('tabula_fleet_seats_used'), legendFormat: '' },
      { expr: fleetGauge('tabula_fleet_seats_paid'), legendFormat: '' },
      { expr: fleetGauge('tabula_fleet_members_used'), legendFormat: '' },
      { expr: fleetGauge('tabula_fleet_backup_age_hours'), legendFormat: '' },
      { expr: fleetGauge('tabula_fleet_disk_used_bytes'), legendFormat: '' },
      { expr: fleetGauge('tabula_fleet_disk_total_bytes'), legendFormat: '' },
    ], [
      { id: 'joinByField', options: { byField: 'workspace', mode: 'outer' } },
      { id: 'organize', options: {
        excludeByName: { Time: true, 'Time 1': true, 'Time 2': true, 'Time 3': true, 'Time 4': true, 'Time 5': true, 'Time 6': true, 'Time 7': true, 'Value #A': true, __name__: true, 'Value #A 1': true },
        renameByName: { 'Value #B': 'Seats used', 'Value #C': 'Seats paid', 'Value #D': 'Members', 'Value #E': 'Backup age (h)', 'Value #F': 'Disk used', 'Value #G': 'Disk total' },
      } },
    ], { description: 'One row per workspace id, from the control plane (state, plan, machine, seats, backup, disk). The image version is in the lake (events, workspace_hour), not in a label. Ids only: no names or emails exist in the data.' }),
    ts('Machines started and stopped', 0, 53, 8, 8, [
      { expr: `sum(${fleetGauge('tabula_fleet_machine_started')})`, legendFormat: 'started' },
      { expr: `count(${fleetGauge('tabula_fleet_machine_started')}) - sum(${fleetGauge('tabula_fleet_machine_started')})`, legendFormat: 'stopped or other' },
    ]),
    ts('Seats used by workspace', 8, 53, 8, 8, [{ expr: fleetGauge('tabula_fleet_seats_used'), legendFormat: '{{workspace}}' }]),
    ts('Hours since the last successful backup', 16, 53, 8, 8, [{ expr: fleetGauge('tabula_fleet_backup_age_hours'), legendFormat: '{{workspace}}' }]),
    ts('Disk used by workspace', 0, 61, 12, 8, [{ expr: fleetGauge('tabula_fleet_disk_used_bytes'), legendFormat: '{{workspace}}' }], { unit: 'bytes' }),
    ts('Disk used, share of the volume', 12, 61, 12, 8, [{ expr: `${fleetGauge('tabula_fleet_disk_used_bytes')} / ${fleetGauge('tabula_fleet_disk_total_bytes')}`, legendFormat: '{{workspace}}' }], { unit: 'percentunit' }),
  ], { description: 'All workspaces. Operating data only; ids are workspace ids.' }),

  'workspace-health': dashboard('tabula-workspace', 'Per-workspace health', [
    stat('Seconds since last report', 0, 0, 5, 4, `time() - max(last_over_time(tabula_report_received_timestamp_seconds{${WS}}[14d]))`, { unit: 's' }),
    stat('Version', 5, 0, 5, 4, `count by (app_version) (last_over_time(tabula_report_info{${WS}}[3h]))`, { description: 'The label shows the version.', options: { reduceOptions: { calcs: ['lastNotNull'] }, textMode: 'name', colorMode: 'none', graphMode: 'none' } }),
    stat('Connections now', 10, 0, 5, 4, `sum(${gauge('tabula_connections_now', `{${WS}}`)})`),
    stat('Connections peak', 15, 0, 5, 4, `sum(${gauge('tabula_connections_peak', `{${WS}}`)})`),
    stat('Seconds since last activity', 20, 0, 4, 4, `time() - max(${gauge('tabula_last_activity_timestamp_seconds', `{${WS}}`)})`, { unit: 's' }),
    ts('Requests per hour by status class', 0, 4, 12, 8, [{ expr: `sum by (status_class) (${hourly('tabula_http_requests_hourly', `{${WS}}`)})`, legendFormat: '{{status_class}}' }]),
    ts('HTTP duration p50 and p95', 12, 4, 12, 8, [
      { expr: quantile(0.5, 'tabula_http_duration_ms', `{${WS}}`), legendFormat: 'p50' },
      { expr: quantile(0.95, 'tabula_http_duration_ms', `{${WS}}`), legendFormat: 'p95' },
    ], { unit: 'ms' }),
    ts('Sync save and load p95', 0, 12, 12, 8, [
      { expr: quantile(0.95, 'tabula_sync_save_ms', `{${WS}}`), legendFormat: 'save p95' },
      { expr: quantile(0.95, 'tabula_sync_load_ms', `{${WS}}`), legendFormat: 'load p95' },
    ], { unit: 'ms' }),
    ts('Memory and event loop', 12, 12, 12, 8, [
      { expr: gauge('tabula_process_rss_bytes', `{${WS}}`), legendFormat: 'RSS {{workspace}}' },
      { expr: gauge('tabula_event_loop_lag_ms_p95', `{${WS}}`), legendFormat: 'loop lag p95 (ms) {{workspace}}' },
    ]),
    ts('CPU seconds per hour', 0, 20, 8, 8, [{ expr: hourly('tabula_cpu_seconds_hourly', `{${WS}}`), legendFormat: '{{workspace}}' }], { unit: 's' }),
    ts('Data and disk free', 8, 20, 8, 8, [
      { expr: gauge('tabula_data_bytes', `{${WS}}`), legendFormat: 'data {{workspace}}' },
      { expr: gauge('tabula_disk_free_bytes', `{${WS}}`), legendFormat: 'disk free {{workspace}}' },
    ], { unit: 'bytes' }),
    ts('Entities', 16, 20, 8, 8, [{ expr: `sum by (kind) (${gauge('tabula_entities_total', `{${WS}}`)})`, legendFormat: '{{kind}}' }]),
    logs('Error codes (counts and code names only)', 0, 28, 24, 8, '{job="tabula-telemetry", kind="error", workspace=~"$workspace"}'),
  ], { templated: true, description: 'Pick one or more workspace ids.' }),

  'backups-restore': dashboard('tabula-backups', 'Backups and restore', [
    stat('Backup runs, last 24 h', 0, 0, 6, 4, `sum(sum_over_time(tabula_backup_runs_hourly[24h])) or vector(0)`),
    stat('Failed backup runs, last 24 h', 6, 0, 6, 4, `sum(sum_over_time(tabula_backup_runs_hourly{result="failed"}[24h])) or vector(0)`),
    stat('Restore runs, last 7 d', 12, 0, 6, 4, `sum(sum_over_time(tabula_restore_runs_hourly[7d])) or vector(0)`),
    stat('Failed restores, last 7 d', 18, 0, 6, 4, `sum(sum_over_time(tabula_restore_runs_hourly{result="failed"}[7d])) or vector(0)`),
    table('Hours since the last successful backup, by workspace', 0, 4, 12, 9, [{ expr: '(time() - max by (workspace) (tlast_over_time(tabula_backup_runs_hourly{result="ok"}[14d]))) / 3600' }],
      [{ id: 'organize', options: { excludeByName: { Time: true }, renameByName: { Value: 'Hours' } } }], { description: 'Uses MetricsQL tlast_over_time (VictoriaMetrics).' }),
    table('Failed backups by workspace and error code, last 7 d', 12, 4, 12, 9, [{ expr: 'sum by (workspace, error_code) (sum_over_time(tabula_backup_runs_hourly{result="failed"}[7d])) > 0' }],
      [{ id: 'organize', options: { excludeByName: { Time: true }, renameByName: { Value: 'Failures' } } }]),
    ts('Backup runs per hour by result', 0, 13, 12, 8, [{ expr: `sum by (result) (${hourly('tabula_backup_runs_hourly')})`, legendFormat: '{{result}}' }]),
    ts('Backup duration p50 and p95', 12, 13, 12, 8, [
      { expr: quantile(0.5, 'tabula_backup_duration_ms'), legendFormat: 'p50' },
      { expr: quantile(0.95, 'tabula_backup_duration_ms'), legendFormat: 'p95' },
    ], { unit: 'ms' }),
    ts('Backup bytes per hour', 0, 21, 12, 8, [{ expr: `sum by (result) (${hourly('tabula_backup_bytes_hourly')})`, legendFormat: '{{result}}' }], { unit: 'bytes' }),
    ts('Restore runs per hour by kind and result', 12, 21, 12, 8, [{ expr: `sum by (kind, result) (${hourly('tabula_restore_runs_hourly')})`, legendFormat: '{{kind}} {{result}}' }]),
  ], { description: 'Backup and restore health from the hourly reports.' }),

  'product-usage': dashboard('tabula-usage', 'Product usage counts', [
    ts('MCP calls per hour by tool (top 10)', 0, 0, 12, 9, [{ expr: `topk(10, sum by (tool) (${hourly('tabula_mcp_calls_hourly')}))`, legendFormat: '{{tool}}' }]),
    ts('MCP calls by result', 12, 0, 12, 9, [{ expr: `sum by (result) (${hourly('tabula_mcp_calls_hourly')})`, legendFormat: '{{result}}' }]),
    ts('AI calls by feature', 0, 9, 12, 8, [{ expr: `sum by (feature) (${hourly('tabula_ai_calls_hourly')})`, legendFormat: '{{feature}}' }]),
    ts('Tracker operations', 12, 9, 12, 8, [{ expr: `sum by (op) (${hourly('tabula_tracker_ops_hourly')})`, legendFormat: '{{op}}' }]),
    ts('Chat messages', 0, 17, 8, 8, [{ expr: `sum by (kind) (${hourly('tabula_chat_messages_hourly')})`, legendFormat: '{{kind}}' }]),
    ts('Uploads by kind', 8, 17, 8, 8, [{ expr: `sum by (kind) (${hourly('tabula_uploads_hourly')})`, legendFormat: '{{kind}}' }]),
    ts('Upload bytes by size bucket', 16, 17, 8, 8, [{ expr: `sum by (size_bucket) (${hourly('tabula_upload_bytes_hourly')})`, legendFormat: '{{size_bucket}}' }], { unit: 'bytes' }),
    ts('Sessions by device class', 0, 25, 6, 8, [{ expr: `sum by (device) (${hourly('tabula_client_sessions_hourly')})`, legendFormat: '{{device}}' }]),
    ts('Sessions by browser family', 6, 25, 6, 8, [{ expr: `sum by (browser) (${hourly('tabula_client_sessions_hourly')})`, legendFormat: '{{browser}}' }]),
    ts('Sessions by operating system', 12, 25, 6, 8, [{ expr: `sum by (os) (${hourly('tabula_client_sessions_hourly')})`, legendFormat: '{{os}}' }]),
    ts('Sessions installed or in a browser', 18, 25, 6, 8, [{ expr: `sum by (installed) (${hourly('tabula_client_sessions_hourly')})`, legendFormat: '{{installed}}' }]),
    ts('OAuth events', 0, 33, 12, 8, [{ expr: `sum by (event) (${hourly('tabula_oauth_events_hourly')})`, legendFormat: '{{event}}' }]),
    ts('Entities (boards, tickets, users)', 12, 33, 12, 8, [{ expr: `sum by (kind) (${gauge('tabula_entities_total')})`, legendFormat: '{{kind}}' }]),
  ], { description: 'Counts only, never content. Product-analytics series are absent for workspaces whose owner turned that off.' }),

  errors: dashboard('tabula-errors', 'Errors', [
    ts('Error occurrences per hour by code', 0, 0, 12, 8, [{ expr: 'sum by (code) (sum_over_time({job="tabula-telemetry", kind="error"} | json | unwrap count [1h]))', legendFormat: '{{code}}', queryType: 'range' }], { ds: LOKI }),
    ts('Workspaces with errors per hour', 12, 0, 12, 8, [{ expr: 'count by (workspace) (count_over_time({job="tabula-telemetry", kind="error"}[1h]))', legendFormat: '{{workspace}}', queryType: 'range' }], { ds: LOKI }),
    ts('5xx responses per hour by workspace', 0, 8, 12, 8, [{ expr: `sum by (workspace) (${hourly('tabula_http_requests_hourly', '{status_class="5xx"}')})`, legendFormat: '{{workspace}}' }]),
    ts('Failed backups and restores per hour', 12, 8, 12, 8, [
      { expr: `sum(${hourly('tabula_backup_runs_hourly', '{result="failed"}')})`, legendFormat: 'backups' },
      { expr: `sum(${hourly('tabula_restore_runs_hourly', '{result="failed"}')})`, legendFormat: 'restores' },
    ]),
    logs('Error entries (fingerprint, code, kind, status, top frame, count)', 0, 16, 24, 10, '{job="tabula-telemetry", kind="error"}'),
    logs('Upgrade results', 0, 26, 12, 8, '{job="tabula-telemetry", kind="event", event="upgrade_result"}'),
    logs('Daily top error codes', 12, 26, 12, 8, '{job="tabula-telemetry", kind="event", event="error_rate_day"}'),
  ], { description: 'Error codes and counts. The schema has no message text, so none can appear here.' }),
};

for (const [file, body] of Object.entries(dashboards)) {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  fs.writeFileSync(path.join(out, `${file}.json`), text);
}
