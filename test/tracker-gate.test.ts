import { describe, expect, it } from 'vitest';
import {
  markGateFloorKnown, maybeClearGate, parseRestoreGate, readRestoreGate, restoreGateValue,
  setRestoreGate, trackerGateState,
} from '../server/tracker/gate.mjs';
import { requireTrackerGateOpen, TrackerRestoringError } from '../server/tracker/shared.mjs';

function open() {
  const settings = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      return {
        run(key: string) {
          if (sql.startsWith('DELETE FROM settings WHERE key = ?')) return { changes: Number(settings.delete(key)) };
          throw new Error('unexpected gate SQL');
        },
      };
    },
  };
  return {
    db,
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string) => { settings.set(key, value); },
    transaction: (fn: () => unknown) => fn(),
  } as any;
}

describe('tracker restore gate', () => {
  it('serializes the frozen settings shape and invalidates the gate cache on set and floor change', () => {
    const directory = open();
    let now = 10;
    const clock = () => now;
    expect(trackerGateState(directory, { now: clock })).toEqual({ closed: false, floor: null });
    const serialized = restoreGateValue({ since: 10, reason: 'restore', floor: 'pending' });
    expect(JSON.parse(serialized)).toEqual({ since: 10, reason: 'restore', floor: 'pending' });
    setRestoreGate(directory, { since: 10, reason: 'restore', floor: 'pending' });
    expect(trackerGateState(directory, { now: clock })).toMatchObject({ closed: true, floor: 'pending', since: 10 });
    expect(() => requireTrackerGateOpen(directory)).toThrow(TrackerRestoringError);
    expect(() => requireTrackerGateOpen(directory)).toThrow(expect.objectContaining({ code: 'tracker_restoring', floor: 'pending' }));

    expect(markGateFloorKnown(directory)).toBe(true);
    expect(trackerGateState(directory, { now: clock })).toMatchObject({ closed: true, floor: 'known' });
    expect(parseRestoreGate(readRestoreGate(directory))).toEqual({ since: 10, reason: 'restore', floor: 'known' });

    const audits: unknown[] = [];
    const collectAudit = (action: string, detail: unknown) => audits.push([action, detail]);
    expect(maybeClearGate(directory, { floorKnown: true, reconcileDone: false, ftsReady: true, now: () => 1010 }, collectAudit)).toBe(false);
    expect(maybeClearGate(directory, { floorKnown: true, reconcileDone: true, ftsReady: true, now: () => 2010 }, collectAudit)).toBe(true);
    expect(trackerGateState(directory, { now: clock })).toEqual({ closed: false, floor: null });
    expect(audits).toEqual([['tracker.gate_cleared', { closedSeconds: 2 }]]);
  });

  it('expires a cached read after one second when a setting changes outside the helpers', () => {
    const directory = open();
    let now = 20;
    const clock = () => now;
    expect(trackerGateState(directory, { now: clock }).closed).toBe(false);
    directory.setSetting('tracker.restore_gate', JSON.stringify({ since: 20, reason: 'restore', floor: 'known' }));
    expect(trackerGateState(directory, { now: clock }).closed).toBe(false);
    now += 1000;
    expect(trackerGateState(directory, { now: clock })).toMatchObject({ closed: true, floor: 'known' });
  });
});
