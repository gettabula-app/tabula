import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import {
  aggregateReadiness,
  createReadinessProviders,
  createTrackerReadiness,
  READINESS_CHECKS,
  READINESS_TARGETS,
} from '../server/tracker/readiness.mjs';

const directories: Array<ReturnType<typeof openDirectory>> = [];
const open = () => {
  const directory = openDirectory(':memory:');
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) directory.close();
  vi.restoreAllMocks();
});

const allPass = () => Object.fromEntries(READINESS_CHECKS.map(({ id }) => [id, () => ({ state: 'pass' })]));

describe('tracker readiness aggregation', () => {
  it('uses the frozen twelve ids, exact targets, na and go rules', () => {
    const expectedIds = [
      'offsite_enabled', 'latest_backup_fresh', 'schedule_meets_rpo', 'backup_decrypts', 'tracker_data_clean',
      'counters_floor_ok', 'links_consistent', 'search_ok', 'slice8_secrets', 'restore_drill_recent',
      'retention_30d', 'import_verified',
    ];
    const providers = allPass();
    providers.slice8_secrets = () => ({ state: 'na', detail: 'tables_not_present' });
    const report = aggregateReadiness({ providers, now: () => 42, gate: { closed: true, since: 12, floor: 'known' } });
    expect(report).toEqual({
      at: 42,
      overall: 'go',
      gate: { closed: true, since: 12, floor: 'known' },
      targets: READINESS_TARGETS,
      checks: expectedIds.map((id, index) => ({
        id,
        label: READINESS_CHECKS[index].label,
        state: id === 'slice8_secrets' ? 'na' : 'pass',
        ...(id === 'slice8_secrets' ? { detail: 'tables_not_present' } : {}),
      })),
    });
  });

  it('makes any fail no_go, otherwise unknown wins over go', () => {
    const fail = allPass();
    fail.offsite_enabled = () => ({ state: 'fail', detail: 'backup_target_missing' });
    fail.latest_backup_fresh = () => ({ state: 'unknown', detail: 'snapshot_end_unavailable' });
    expect(aggregateReadiness({ providers: fail }).overall).toBe('no_go');
    const unknown = allPass();
    unknown.search_ok = () => ({ state: 'unknown', detail: 'search_counts_unavailable' });
    expect(aggregateReadiness({ providers: unknown }).overall).toBe('unknown');
  });

  it('turns missing, throwing and unsafe-detail providers into unknown provider_unavailable', () => {
    const report = aggregateReadiness({
      providers: {
        offsite_enabled: () => { throw new Error('private path or ticket text'); },
        latest_backup_fresh: () => ({ state: 'pass', detail: 'a ticket title leaked here' }),
        schedule_meets_rpo: () => ({ state: 'pass', detail: 'UNIQUE_READINESS_TITLE_7f2c91' }),
      },
      now: () => 10,
    });
    expect(report.checks[0]).toMatchObject({ state: 'unknown', detail: 'provider_unavailable' });
    expect(report.checks[1]).toMatchObject({ state: 'unknown', detail: 'provider_unavailable' });
    expect(report.checks[2]).toMatchObject({ state: 'unknown', detail: 'provider_unavailable' });
    expect(report.checks.slice(2).every((check: any) => check.state === 'unknown' && check.detail === 'provider_unavailable')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private path or ticket text');
  });

  it('keeps the part A/B hooks unknown and treats absent slice 8 tables as na', () => {
    const providers = createReadinessProviders({ checkTrackerData: null, now: () => 10_000 });
    expect(providers.tracker_data_clean({ backup: {} })).toEqual({ state: 'unknown', detail: 'manifest_has_no_tracker_field' });
    expect(providers.links_consistent({ directory: { db: {} } })).toEqual({ state: 'unknown', detail: 'check_not_available' });
    expect(providers.slice8_secrets({ live: { tables: new Set() } })).toEqual({ state: 'na', detail: 'tables_not_present' });
    expect(providers.slice8_secrets({ live: { tables: new Set(['integration_connections', 'webhooks', 'webhook_deliveries', 'integration_inbox']) } }))
      .toEqual({ state: 'unknown', detail: 'slice8_check_missing' });
  });

  it('keeps key coverage unknown when backup status has no coverage result', () => {
    const providers = createReadinessProviders({ now: () => 2 * 60 * 60 * 1000 });
    expect(providers.backup_decrypts({
      backup: { deepVerifiedAt: 60 * 60 * 1000, deepDamaged: 0 },
      backupConfig: { verifyHours: 24 },
    })).toEqual({ state: 'unknown', detail: 'key_coverage_unavailable' });
  });

  it('measures backup freshness from the manifest snapshot end and accepts an unchanged manifest', () => {
    const now = 1_000_000;
    const providers = createReadinessProviders({ now: () => now });
    expect(providers.latest_backup_fresh({
      backup: { lastManifest: '20261011T120000Z.json.enc', snapshotEndedAt: now - 16 * 60_000, dirty: true },
    })).toMatchObject({ state: 'fail', detail: 'age_minutes_16_target_15' });
    expect(providers.latest_backup_fresh({
      backup: { lastManifest: '20261011T120000Z.json.enc', snapshotEndedAt: null, dirty: false },
    })).toEqual({ state: 'pass', detail: 'unchanged_since_manifest' });
    expect(providers.latest_backup_fresh({
      backup: { lastManifest: '20261011T120000Z.json.enc', snapshotEndedAt: null, dirty: true },
    })).toEqual({ state: 'unknown', detail: 'snapshot_end_unavailable' });
  });

  it('forces an over-ten-minute gate to fail and logs once for that gate', () => {
    const log = vi.fn<(message: string) => void>();
    const now = 1_000_000;
    const providers = createReadinessProviders({ now: () => now, log });
    const ctx = { gate: { since: now - 600_001, reason: 'restore', floor: 'pending' }, live: { counters: [] } };
    expect(providers.counters_floor_ok(ctx)).toEqual({ state: 'fail', detail: 'gate_open_over_10_min', since: now - 600_001 });
    expect(providers.counters_floor_ok(ctx)).toMatchObject({ state: 'fail', detail: 'gate_open_over_10_min' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^[a-z0-9 _.:+-]+$/i);
  });

  it('caches the status and bounded live query result for 30 seconds', () => {
    const directory = open();
    let current = 50_000;
    let calls = 0;
    const readiness = createTrackerReadiness({ directory, now: () => current, backupStatus: () => { calls++; return {}; } });
    const first = readiness.get();
    expect(readiness.get()).toBe(first);
    expect(calls).toBe(1);
    current += 30_000;
    const next = readiness.get();
    expect(next).not.toBe(first);
    expect(next.at).toBe(current);
    expect(calls).toBe(2);
    expect(Object.keys(next)).toEqual(['at', 'overall', 'gate', 'targets', 'checks']);
    expect(next.checks.map((check: any) => check.id)).toEqual(READINESS_CHECKS.map(({ id }) => id));
  });
});
