import { readKeyFloorFile } from './key-floor.mjs';
import { parseRestoreGate } from './gate.mjs';

export const READINESS_TARGETS = Object.freeze({ rpoMinutes: 15, rtoHours: 4, retentionDays: 30 });
const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_CODES = new Set([
  'provider_unavailable', 'backup_target_missing', 'pull_route_disabled', 'pull_status_unavailable', 'pull_older_than_24h',
  'no_backup_manifest', 'unchanged_since_manifest', 'snapshot_end_unavailable', 'backup_dirty_state_unavailable',
  'backup_schedule_unavailable', 'deep_verify_missing', 'deep_verify_status_unavailable', 'deep_verify_ok',
  'key_coverage_failed', 'key_coverage_unavailable', 'manifest_has_no_tracker_field', 'gate_open_over_10_min',
  'gate_floor_pending', 'floor_report_missing', 'floor_report_stale_24h', 'floor_below_live_minus_25',
  'self_host_epoch_action_documented', 'floor_file_unavailable', 'floor_file_stale_24h', 'check_not_available',
  'outbox_oldest_over_24h', 'search_counts_unavailable', 'tables_not_present', 'slice8_check_missing',
  'no_drill_record', 'local_record_not_enough', 'drill_older_than_30d', 'drill_schema_mismatch',
  'drill_failed', 'drill_targets_missed', 'retention_setting_unavailable', 'no_cutover_record',
]);
const STATES = new Set(['pass', 'fail', 'unknown', 'na']);

function safeDetail(value) {
  if (typeof value !== 'string' || value.length > 120 || !/^[a-z0-9_]+$/.test(value)) return false;
  return DETAIL_CODES.has(value)
    || /^age_minutes_\d+_(?:unchanged|target_15)$/.test(value)
    || /^interval_minutes_\d+_settle_seconds_\d+(?:_target_15)?$/.test(value)
    || /^deep_verify_stale_hours_\d+$/.test(value)
    || /^deep_damaged_\d+$/.test(value)
    || /^findings_\d+(?:_(?:counter_below_max|key_mismatch|orphan_event|event_missing|duplicate_active_link|link_without_board_link|link_to_missing_ticket|alias_collision|fts_missing|outbox_stale|finding)){0,3}$/.test(value)
    || /^link_findings_\d+$/.test(value)
    || /^outbox_pending_\d+$/.test(value)
    || /^search_rows_\d+_tickets_\d+$/.test(value)
    || /^retention_days_\d+(?:_target_30)?$/.test(value);
}

export const READINESS_CHECKS = Object.freeze([
  { id: 'offsite_enabled', label: 'Offsite backups enabled' },
  { id: 'latest_backup_fresh', label: 'Latest backup within RPO' },
  { id: 'schedule_meets_rpo', label: 'Backup schedule meets RPO' },
  { id: 'backup_decrypts', label: 'Backup decrypts' },
  { id: 'tracker_data_clean', label: 'Tracker backup data clean' },
  { id: 'counters_floor_ok', label: 'Ticket key floor known' },
  { id: 'links_consistent', label: 'Ticket and board links consistent' },
  { id: 'search_ok', label: 'Ticket search index complete' },
  { id: 'slice8_secrets', label: 'Slice 8 secrets ready' },
  { id: 'restore_drill_recent', label: 'Recent restore drill' },
  { id: 'retention_30d', label: '30 day retention' },
  { id: 'import_verified', label: 'Linear import verified' },
]);

function cleanProviderResult(value) {
  if (!value || typeof value !== 'object' || !STATES.has(value.state)) return null;
  const result = { state: value.state };
  if (value.detail !== undefined) {
    if (!safeDetail(value.detail)) return null;
    result.detail = value.detail;
  }
  if (value.since !== undefined) {
    if (!Number.isFinite(value.since)) return null;
    result.since = value.since;
  }
  return result;
}

/**
 * Pure aggregation of injectable readiness providers. A broken provider is reported as unknown.
 * @param {any} [options]
 */
export function aggregateReadiness({ providers = {}, ctx = {}, now = Date.now, gate = null } = {}) {
  const checks = READINESS_CHECKS.map(({ id, label }) => {
    let value = null;
    try {
      if (typeof providers[id] === 'function') value = cleanProviderResult(providers[id](ctx));
    } catch {
      value = null;
    }
    const result = value ?? { state: 'unknown', detail: 'provider_unavailable' };
    return { id, label, ...result };
  });
  const overall = checks.some((check) => check.state === 'fail') ? 'no_go'
    : checks.some((check) => check.state === 'unknown') ? 'unknown' : 'go';
  const safeGate = gate && typeof gate.closed === 'boolean' && Number.isFinite(gate.since)
    && ['pending', 'known'].includes(gate.floor)
    ? { closed: gate.closed, since: gate.since, floor: gate.floor }
    : null;
  return { at: now(), overall, gate: safeGate, targets: { ...READINESS_TARGETS }, checks };
}

function parseSetting(directory, key) {
  try {
    const raw = directory.getSetting(key);
    if (typeof raw !== 'string' || raw.length > 32_768) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function tableNames(db) {
  try {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

/** One bounded set of indexed counts for live readiness checks. No ticket text is selected. */
export function readReadinessLiveFacts(db) {
  const unknown = { counts: null, counters: [], tables: new Set() };
  try {
    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM tickets) AS tickets,
      (SELECT COUNT(*) FROM tickets WHERE archived_at IS NULL) AS active_tickets,
      (SELECT COUNT(*) FROM ticket_search) AS search_rows,
      (SELECT COUNT(*) FROM ticket_projection_outbox WHERE applied_at IS NULL) AS outbox_pending,
      (SELECT MIN(created_at) FROM ticket_projection_outbox WHERE applied_at IS NULL) AS outbox_oldest`).get();
    const counters = db.prepare('SELECT scope, prefix, next_number FROM ticket_counters ORDER BY scope, prefix LIMIT 100').all()
      .filter((row) => typeof row.scope === 'string' && typeof row.prefix === 'string' && Number.isSafeInteger(Number(row.next_number)) && Number(row.next_number) > 0)
      .map((row) => ({ scope: row.scope, prefix: row.prefix, next: Number(row.next_number) }));
    return { counts, counters, tables: tableNames(db) };
  } catch {
    return { ...unknown, tables: tableNames(db) };
  }
}

/**
 * @param {any} [options]
 */
export function createReadinessProviders({ checkTrackerData = null, log = () => {}, now = Date.now } = {}) {
  const loggedGates = new Set();
  return {
    offsite_enabled(ctx) {
      const target = ctx.backup?.target ?? ctx.backupConfig?.target;
      if (target === 's3') return { state: 'pass' };
      if (target !== 'dir') return { state: 'fail', detail: 'backup_target_missing' };
      if (!ctx.backupConfig?.pullTokenSha256) return { state: 'fail', detail: 'pull_route_disabled' };
      const pulledAt = ctx.backup?.pullLastSuccessAt;
      if (!Number.isFinite(pulledAt)) return { state: 'unknown', detail: 'pull_status_unavailable' };
      return now() - pulledAt <= DAY_MS && now() >= pulledAt
        ? { state: 'pass', since: pulledAt }
        : { state: 'fail', detail: 'pull_older_than_24h', since: pulledAt };
    },
    latest_backup_fresh(ctx) {
      const backup = ctx.backup ?? {};
      if (!backup.lastManifest && !Number.isFinite(backup.snapshotEndedAt)) return { state: 'fail', detail: 'no_backup_manifest' };
      const at = backup.snapshotEndedAt;
      if (backup.dirty === false) {
        if (!Number.isFinite(at)) return { state: 'pass', detail: 'unchanged_since_manifest' };
        const age = Math.max(0, Math.floor((now() - at) / 60_000));
        return { state: 'pass', detail: `age_minutes_${age}_unchanged`, since: at };
      }
      if (!Number.isFinite(at)) return { state: 'unknown', detail: 'snapshot_end_unavailable' };
      const age = Math.max(0, Math.floor((now() - at) / 60_000));
      if (backup.dirty !== true) return { state: 'unknown', detail: 'backup_dirty_state_unavailable', since: at };
      return age <= READINESS_TARGETS.rpoMinutes
        ? { state: 'pass', detail: `age_minutes_${age}_target_15`, since: at }
        : { state: 'fail', detail: `age_minutes_${age}_target_15`, since: at };
    },
    schedule_meets_rpo(ctx) {
      const interval = ctx.backupConfig?.intervalMinutes ?? ctx.backup?.intervalMinutes;
      const settle = ctx.backupConfig?.settleSeconds ?? ctx.backup?.settleSeconds;
      if (!Number.isSafeInteger(interval) || !Number.isFinite(settle)) return { state: 'unknown', detail: 'backup_schedule_unavailable' };
      return interval <= READINESS_TARGETS.rpoMinutes && settle > 0
        ? { state: 'pass', detail: `interval_minutes_${interval}_settle_seconds_${Math.floor(settle)}` }
        : { state: 'fail', detail: `interval_minutes_${interval}_settle_seconds_${Math.floor(settle)}_target_15` };
    },
    backup_decrypts(ctx) {
      const backup = ctx.backup ?? {};
      const verifyHours = ctx.backupConfig?.verifyHours;
      if (!Number.isFinite(backup.deepVerifiedAt) || !Number.isFinite(verifyHours) || verifyHours <= 0) {
        return { state: 'fail', detail: 'deep_verify_missing' };
      }
      const age = now() - backup.deepVerifiedAt;
      if (age < 0 || age > verifyHours * 60 * 60 * 1000) return { state: 'fail', detail: `deep_verify_stale_hours_${Math.floor(Math.max(0, age) / 3_600_000)}` };
      if (!Number.isSafeInteger(backup.deepDamaged) || backup.deepDamaged < 0) return { state: 'unknown', detail: 'deep_verify_status_unavailable' };
      if (backup.deepDamaged !== 0) return { state: 'fail', detail: `deep_damaged_${Number.isSafeInteger(backup.deepDamaged) ? backup.deepDamaged : 1}` };
      if (backup.keyCoverageOk === true) return { state: 'pass', detail: 'deep_verify_ok' };
      if (backup.keyCoverageOk === false) return { state: 'fail', detail: 'key_coverage_failed' };
      return { state: 'unknown', detail: 'key_coverage_unavailable' };
    },
    tracker_data_clean(ctx) {
      const tracker = ctx.backup?.tracker;
      if (!tracker || !Array.isArray(tracker.findings)) return { state: 'unknown', detail: 'manifest_has_no_tracker_field' };
      const findings = tracker.findings.filter((item) => item && Number.isSafeInteger(item.count) && item.count > 0);
      if (!findings.length) return { state: 'pass' };
      const codes = findings.map((item) => typeof item.code === 'string' && /^[a-z0-9_]{1,40}$/i.test(item.code) ? item.code : 'finding')
        .sort().slice(0, 3).join('_');
      return { state: 'fail', detail: `findings_${findings.length}_${codes}` };
    },
    counters_floor_ok(ctx) {
      const gate = ctx.gate;
      const gateId = gate ? `${gate.since}:${gate.reason}` : null;
      if (gate && now() - gate.since > 10 * 60_000) {
        if (!loggedGates.has(gateId)) {
          loggedGates.add(gateId);
          log(`tracker gate open over 10 minutes since_ms_${Math.floor(gate.since)}`);
        }
        return { state: 'fail', detail: 'gate_open_over_10_min', since: gate.since };
      }
      if (gate?.floor === 'pending') return { state: 'unknown', detail: 'gate_floor_pending', since: gate.since };
      const rows = ctx.live?.counters ?? [];
      if (ctx.cloud) {
        const report = ctx.floorReport;
        if (!report || !Number.isFinite(report.cloudLastSuccessAt)) return { state: 'fail', detail: 'floor_report_missing' };
        if (now() - report.cloudLastSuccessAt > DAY_MS || now() < report.cloudLastSuccessAt) return { state: 'fail', detail: 'floor_report_stale_24h', since: report.cloudLastSuccessAt };
        const floors = new Map((report.cloudCounters ?? []).map((row) => [`${row.scope}\u0000${row.prefix}`, row.floor]));
        const lagging = rows.some((row) => !Number.isSafeInteger(floors.get(`${row.scope}\u0000${row.prefix}`))
          || floors.get(`${row.scope}\u0000${row.prefix}`) < row.next - 25);
        return lagging ? { state: 'fail', detail: 'floor_below_live_minus_25' } : { state: 'pass' };
      }
      if (!ctx.floorFileConfigured) return { state: 'na', detail: 'self_host_epoch_action_documented' };
      const floorFile = ctx.floorFile;
      if (!floorFile) return { state: 'fail', detail: 'floor_file_unavailable' };
      if (now() - floorFile.at > DAY_MS || now() < floorFile.at) return { state: 'fail', detail: 'floor_file_stale_24h', since: floorFile.at };
      const floors = new Map(floorFile.counters.map((row) => [`${row.scope}\u0000${row.prefix}`, row.floor]));
      const lagging = rows.some((row) => !Number.isSafeInteger(floors.get(`${row.scope}\u0000${row.prefix}`))
        || floors.get(`${row.scope}\u0000${row.prefix}`) < row.next - 25);
      return lagging ? { state: 'fail', detail: 'floor_below_live_minus_25' } : { state: 'pass' };
    },
    links_consistent(ctx) {
      if (typeof checkTrackerData !== 'function') return { state: 'unknown', detail: 'check_not_available' };
      const checked = checkTrackerData(ctx.directory.db);
      if (!checked || typeof checked !== 'object') return { state: 'unknown', detail: 'check_not_available' };
      const findings = Array.isArray(checked.findings) ? checked.findings : [];
      const links = findings.filter((item) => item && Number.isSafeInteger(item.count) && item.count > 0
        && (item.code === 'duplicate_active_link' || (typeof item.code === 'string' && item.code.startsWith('link_'))));
      if (links.length) return { state: 'fail', detail: `link_findings_${links.length}` };
      const pending = ctx.live?.counts?.outbox_pending;
      const oldest = ctx.live?.counts?.outbox_oldest;
      if (!Number.isSafeInteger(pending) || pending > 100) return { state: 'fail', detail: `outbox_pending_${Number.isSafeInteger(pending) ? pending : 101}` };
      if (pending > 0 && (!Number.isFinite(oldest) || now() - oldest >= DAY_MS)) return { state: 'fail', detail: 'outbox_oldest_over_24h' };
      return { state: 'pass', detail: `outbox_pending_${pending}` };
    },
    search_ok(ctx) {
      const counts = ctx.live?.counts;
      if (!counts || !Number.isSafeInteger(counts.search_rows) || !Number.isSafeInteger(counts.active_tickets)) return { state: 'unknown', detail: 'search_counts_unavailable' };
      return counts.search_rows >= counts.active_tickets
        ? { state: 'pass', detail: `search_rows_${counts.search_rows}_tickets_${counts.active_tickets}` }
        : { state: 'fail', detail: `search_rows_${counts.search_rows}_tickets_${counts.active_tickets}` };
    },
    slice8_secrets(ctx) {
      const tables = ctx.live?.tables ?? new Set();
      const names = ['integration_connections', 'webhooks', 'webhook_deliveries', 'integration_inbox'];
      if (!names.some((name) => tables.has(name))) return { state: 'na', detail: 'tables_not_present' };
      return { state: 'unknown', detail: 'slice8_check_missing' };
    },
    restore_drill_recent(ctx) {
      const drill = ctx.drill;
      if (!drill) return { state: 'fail', detail: 'no_drill_record' };
      if (ctx.cloud && drill.kind !== 'production') return { state: 'fail', detail: 'local_record_not_enough' };
      if (!Number.isFinite(drill.at) || drill.at > now() || now() - drill.at > 30 * DAY_MS) return { state: 'fail', detail: 'drill_older_than_30d' };
      if (drill.schema !== ctx.schema) return { state: 'fail', detail: 'drill_schema_mismatch' };
      if (drill.overall !== 'pass') return { state: 'fail', detail: 'drill_failed' };
      if (!Number.isFinite(drill.restoreSeconds) || drill.restoreSeconds > 4 * 60 * 60
        || !Number.isFinite(drill.dataLossSeconds) || drill.dataLossSeconds > 15 * 60) return { state: 'fail', detail: 'drill_targets_missed' };
      return { state: 'pass', since: drill.at };
    },
    retention_30d(ctx) {
      const days = ctx.backupConfig?.keepDailyDays;
      if (!Number.isSafeInteger(days)) return { state: 'unknown', detail: 'retention_setting_unavailable' };
      return days >= READINESS_TARGETS.retentionDays
        ? { state: 'pass', detail: `retention_days_${days}` }
        : { state: 'fail', detail: `retention_days_${days}_target_30` };
    },
    import_verified(ctx) {
      if (!ctx.cutover || ctx.cutover.lossReportAccepted !== true || typeof ctx.cutover.importVerifiedAt !== 'string') {
        return { state: 'fail', detail: 'no_cutover_record' };
      }
      return { state: 'pass' };
    },
  };
}

/**
 * Build the report context from status, settings and bounded counts only.
 * @param {any} [options]
 */
export function createTrackerReadiness({
  directory,
  backupStatus = () => ({}),
  backupConfig = null,
  cloud = null,
  reporter = null,
  floorFilePath = null,
  checkTrackerData = null,
  now = Date.now,
  log = () => {},
} = {}) {
  const providers = createReadinessProviders({ checkTrackerData, log, now });
  let cached = null;
  function build() {
    let backup = {};
    try { backup = backupStatus() ?? {}; } catch { /* status providers report unknown */ }
    let floorReport = null;
    try { floorReport = reporter?.status?.() ?? null; } catch { /* status providers report unknown */ }
    const live = readReadinessLiveFacts(directory.db);
    let gate = null;
    try { gate = parseRestoreGate(directory.getSetting('tracker.restore_gate')); } catch { /* an unreadable gate is not reported as open */ }
    const drill = parseSetting(directory, 'tracker.drill.last');
    const cutover = parseSetting(directory, 'tracker.cutover.record');
    let schema = null;
    try { schema = directory.schemaReport()?.build?.schema ?? null; } catch { /* drill check will fail closed */ }
    const floorFile = floorFilePath ? readKeyFloorFile(floorFilePath) : null;
    const drillAt = typeof drill?.at === 'number' ? drill.at : typeof drill?.at === 'string' ? Date.parse(drill.at) : NaN;
    const ctx = {
      directory,
      backup,
      backupConfig,
      cloud,
      reporter,
      floorReport,
      floorFile,
      floorFileConfigured: Boolean(floorFilePath),
      live,
      gate,
      drill: drill ? { ...drill, at: drillAt } : null,
      cutover,
      schema,
    };
    const gateView = gate ? { closed: true, since: gate.since, floor: gate.floor } : null;
    return aggregateReadiness({ providers, ctx, now, gate: gateView });
  }
  return {
    get() {
      const current = now();
      if (!cached || current < cached.at || current - cached.at >= 30_000) {
        cached = { at: current, value: build() };
      }
      return cached.value;
    },
    invalidate() { cached = null; },
  };
}

export function readFloorFileForReadiness(file) {
  return file ? readKeyFloorFile(file) : null;
}
