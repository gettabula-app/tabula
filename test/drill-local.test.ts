import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../server/directory.mjs';
import { DRILL_BOX_IDS, validateDrill } from '../server/tracker/admin-routes.mjs';
import { buildTrackerDrillRecord, checklist, TRACKER_BOXES } from '../scripts/drill-local.mjs';

function report(assertions: Array<{ title: string; status: string; duration?: number; failureMessages?: string[] }>) {
  return { testResults: [{ assertionResults: assertions }] };
}

describe('local drill report', () => {
  it('marks failed, skipped and missing tracker boxes as failures in the record', () => {
    const rows = checklist(report([
      { title: '[tracker.seed] workspace seeded', status: 'passed', duration: 15 },
      { title: '[tracker.barrier_backup] snapshot is clean', status: 'failed', duration: 25, failureMessages: ['summary mismatch'] },
      { title: '[tracker.lost_keys_not_reissued] keys survive', status: 'skipped', duration: 0 },
    ]));
    const record = buildTrackerDrillRecord(rows, {
      trackerRestoreSeconds: 18.5,
      trackerDataAgeAtRestoreSeconds: 7,
    }, { at: 1_800_000_000_000 });

    expect(record).toMatchObject({
      at: 1_800_000_000_000,
      kind: 'local',
      schema: MIGRATIONS.length,
      restoreSeconds: 18.5,
      dataLossSeconds: 7,
      overall: 'fail',
    });
    expect(record?.boxes.find((box) => box.id === 'seed')).toEqual({ id: 'seed', result: 'pass' });
    expect(record?.boxes.find((box) => box.id === 'barrier_backup')).toEqual({ id: 'barrier_backup', result: 'fail' });
    expect(record?.boxes.find((box) => box.id === 'lost_keys_not_reissued')).toEqual({ id: 'lost_keys_not_reissued', result: 'fail' });
    expect(record?.boxes.find((box) => box.id === 'restore_workspace')).toEqual({ id: 'restore_workspace', result: 'fail' });
    expect(record?.boxes.filter((box) => box.id.startsWith('slice8_')).every((box) => box.result === 'not_present')).toBe(true);
  });

  it('uses only the server box ids and result strings accepted by the drill-record validator', () => {
    const assertions = TRACKER_BOXES.filter((box) => !box.note)
      .map((box) => ({ title: '[tracker.' + box.id + '] passed', status: 'passed' }));
    const record = buildTrackerDrillRecord(checklist(report(assertions)), {}, { at: 1_800_000_000_000 });
    expect(record?.overall).toBe('pass');
    for (const box of record?.boxes ?? []) {
      expect(DRILL_BOX_IDS.has(box.id)).toBe(true);
      expect(box.result).toMatch(/^[a-z0-9_ .:-]+$/i);
      expect(box.result.length).toBeLessThanOrEqual(40);
    }
  });

  it('does not print a tracker record until a tracker test actually ran', () => {
    expect(buildTrackerDrillRecord(checklist(report([])))).toBeNull();
    expect(buildTrackerDrillRecord(checklist(report([
      { title: '[tracker.seed] not run', status: 'skipped' },
    ])))).toBeNull();
  });
  it('prints a record the server accepts when every tracker box passes', () => {
    const titles = [...TRACKER_BOXES].map((box: { id: string }) => `[tracker.${box.id}] box`);
    const rows = checklist(report(titles.map((title) => ({ title, status: 'passed', duration: 10 }))));
    const record = buildTrackerDrillRecord(rows, { trackerRestoreSeconds: 2.8, trackerDataAgeAtRestoreSeconds: 0 }, { at: Date.now() });
    expect(record?.overall).toBe('pass');
    const accepted = validateDrill(JSON.parse(JSON.stringify(record)), Date.now());
    expect(accepted).not.toBeNull();
    expect(accepted?.boxes).toHaveLength(record!.boxes.length);
    // and the validator really can say no: an id outside the closed list is refused
    expect(validateDrill({ ...record, boxes: [{ id: 'not_a_box', result: 'pass' }] }, Date.now())).toBeNull();
  });
});
