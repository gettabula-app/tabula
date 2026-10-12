import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDirectory } from '../server/directory.mjs';
import { loadConfig } from '../server/config.mjs';
import {
  computeKeyFloor,
  createKeyFloorReporter,
  epochJump,
  KEY_FLOOR_CHANGED_EVENT,
  readKeyFloorFile,
  writeKeyFloorFile,
} from '../server/tracker/key-floor.mjs';
import { createTicket } from '../server/tracker/tickets.mjs';

const directories: Array<ReturnType<typeof openDirectory>> = [];
const roots: string[] = [];
const open = () => {
  const directory = openDirectory(':memory:');
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) directory.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function timerRig() {
  let now = 1_000;
  let id = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, delay: number) {
      const key = ++id;
      pending.set(key, { at: now + delay, fn });
      return key;
    },
    clearTimeout(key: number) { pending.delete(key); },
    advance(ms: number) {
      now += ms;
      for (const [key, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && pending.delete(key)) timer.fn();
      }
    },
  };
}

describe('tracker key floors', () => {
  const restored = [{ scope: 'trk_default', prefix: 'TAB', next: 10, maxNumber: 9 }];

  it('merges restored counter and every optional floor source', () => {
    const result = computeKeyFloor({
      restored,
      liveBefore: [{ scope: 'trk_default', prefix: 'TAB', next: 15 }],
      manifestMax: [{ scope: 'trk_default', prefix: 'TAB', next: 22 }],
      controlPlane: { counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 30 }] },
      floorFile: { counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 61 }], at: 1 },
      restoredHasTickets: true,
    });
    expect(result).toEqual({ counters: [{ scope: 'trk_default', prefix: 'TAB', next: 61 }], known: true });
  });

  it('has a mutation proof that removing the restored database changes the floor', () => {
    const withRestored = computeKeyFloor({ restored: [{ scope: 'trk_default', prefix: 'TAB', next: 20, maxNumber: 19 }], restoredHasTickets: true });
    const withoutRestored = computeKeyFloor({ restored: [], restoredHasTickets: true });
    expect(withRestored.counters).toEqual([{ scope: 'trk_default', prefix: 'TAB', next: 20 }]);
    expect(withoutRestored.counters).toEqual([]);
    expect(withoutRestored.known).toBe(false);
  });

  it('keeps the restored maximum ticket number above the restored counter value', () => {
    expect(computeKeyFloor({
      restored: [{ scope: 'trk_default', prefix: 'TAB', next: 10, maxNumber: 20 }],
      restoredHasTickets: true,
    })).toEqual({ counters: [{ scope: 'trk_default', prefix: 'TAB', next: 21 }], known: false });
  });

  it.each([
    ['liveBefore', { liveBefore: [{ scope: 'trk_default', prefix: 'TAB', next: 20 }] }, 20],
    ['manifestMax', { manifestMax: [{ scope: 'trk_default', prefix: 'TAB', next: 20 }] }, 20],
    ['controlPlane', { controlPlane: [{ scope: 'trk_default', prefix: 'TAB', floor: 20 }] }, 45],
    ['floorFile', { floorFile: { counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 20 }], at: 1 } }, 20],
  ])('a mutation proof shows removing %s changes the floor', (_name, source, withSource) => {
    const withEvidence = computeKeyFloor({ restored, restoredHasTickets: true, ...source } as any);
    const withoutEvidence = computeKeyFloor({ restored, restoredHasTickets: true });
    expect(withEvidence.counters[0].next).toBe(withSource);
    expect(withoutEvidence.counters[0].next).toBe(10);
    expect(withEvidence.counters[0].next).not.toBe(withoutEvidence.counters[0].next);
  });

  it('keeps a floor unknown only when ticket evidence exists and no external source was supplied', () => {
    expect(computeKeyFloor({ restored, restoredHasTickets: true })).toMatchObject({ known: false, counters: [{ next: 10 }] });
    expect(computeKeyFloor({ restored: [], restoredHasTickets: false })).toEqual({ counters: [], known: true });
  });

  it('needs a row for every restored counter that has tickets: an empty source or another prefix is no evidence', () => {
    const tab = { scope: 'trk_default', prefix: 'TAB' };
    // disaster restore into an empty live directory, nothing else: pending
    expect(computeKeyFloor({ restored, restoredHasTickets: true, liveBefore: { counters: [] } }).known).toBe(false);
    expect(computeKeyFloor({ restored, restoredHasTickets: true, liveBefore: [], manifestMax: [], controlPlane: [], floorFile: null }).known).toBe(false);
    // a source that covers only a different prefix: pending
    expect(computeKeyFloor({ restored, restoredHasTickets: true, controlPlane: [{ scope: 'trk_default', prefix: 'OTH', floor: 50 }] }).known).toBe(false);
    expect(computeKeyFloor({ restored, restoredHasTickets: true, liveBefore: [{ scope: 'other_scope', prefix: 'TAB', next: 50 }] }).known).toBe(false);
    // a row covering the prefix: known (control plane, floor file, live counters of a healthy in-place restore)
    expect(computeKeyFloor({ restored, restoredHasTickets: true, controlPlane: [{ ...tab, floor: 5 }] }).known).toBe(true);
    expect(computeKeyFloor({ restored, restoredHasTickets: true, floorFile: [{ ...tab, floor: 10 }] }).known).toBe(true);
    expect(computeKeyFloor({ restored, restoredHasTickets: true, liveBefore: [{ ...tab, next: 10 }] }).known).toBe(true);
    // two counters, only one covered: pending
    const two = [...restored, { scope: 'trk_default', prefix: 'TWO', next: 4, maxNumber: 3 }];
    expect(computeKeyFloor({ restored: two, restoredHasTickets: true, liveBefore: [{ ...tab, next: 10 }] }).known).toBe(false);
    expect(computeKeyFloor({ restored: two, restoredHasTickets: true, liveBefore: [{ ...tab, next: 10 }, { scope: 'trk_default', prefix: 'TWO', next: 4 }] }).known).toBe(true);
    // a counter without tickets needs no evidence
    expect(computeKeyFloor({ restored: [{ ...tab, next: 1, maxNumber: 0 }], restoredHasTickets: true, liveBefore: [] }).known).toBe(false);
    expect(computeKeyFloor({ restored: [{ ...tab, next: 1, maxNumber: 0 }], restoredHasTickets: false }).known).toBe(true);
  });

  it('counts an external row only when its value reaches the restored counter', () => {
    const tab = { scope: 'trk_default', prefix: 'TAB' };
    const big = [{ ...tab, next: 500, maxNumber: 499 }];
    // a seeded live row with next 1 (a new or empty workspace) proves nothing
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, liveBefore: [{ ...tab, next: 1 }] })).toMatchObject({ known: false, counters: [{ next: 500 }] });
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, liveBefore: [{ ...tab, next: 499 }] }).known).toBe(false);
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, liveBefore: [{ ...tab, next: 500 }] }).known).toBe(true);
    // the control plane's reported floor gets the 25-key margin: 474 + 25 < 500, 475 + 25 >= 500
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, controlPlane: [{ ...tab, floor: 474 }] }).known).toBe(false);
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, controlPlane: [{ ...tab, floor: 475 }] }).known).toBe(true);
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, controlPlane: [{ ...tab, floor: 400 }] }).known).toBe(false);
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, controlPlane: [{ ...tab, floor: 480 }] }).known).toBe(true);
    // a floor file below the restored next proves nothing
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, floorFile: { counters: [{ ...tab, floor: 499 }], at: 1 } }).known).toBe(false);
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, floorFile: { counters: [{ ...tab, floor: 500 }], at: 1 } }).known).toBe(true);
    // a weak source beside a strong one: the strong one decides
    expect(computeKeyFloor({ restored: big, restoredHasTickets: true, liveBefore: [{ ...tab, next: 1 }], floorFile: { counters: [{ ...tab, floor: 600 }], at: 1 } })).toMatchObject({ known: true, counters: [{ next: 600 }] });
  });

  it('counts a kept manifest as evidence only when it is newer than the restored counter', () => {
    // the restored manifest carries the restored counter itself: that proves nothing about later keys
    expect(computeKeyFloor({ restored, restoredHasTickets: true, manifestMax: [{ scope: 'trk_default', prefix: 'TAB', next: 10 }] }).known).toBe(false);
    expect(computeKeyFloor({ restored, restoredHasTickets: true, manifestMax: [{ scope: 'trk_default', prefix: 'TAB', next: 11 }] }).known).toBe(true);
  });

  it('applies the 25-key safety jump to a reported control-plane floor', () => {
    expect(computeKeyFloor({ restored, restoredHasTickets: true, controlPlane: [{ scope: 'trk_default', prefix: 'TAB', floor: 72 }] }))
      .toEqual({ counters: [{ scope: 'trk_default', prefix: 'TAB', next: 97 }], known: true });
  });

  it('atomically jumps every counter past the maximum ticket number plus 1000', () => {
    const directory = open();
    const person = directory.createUser({ email: 'owner@example.com', role: 'owner' })!;
    const actor = { id: person.id, role: person.role, name: person.name };
    createTicket({ directory, actor, title: 'seed' });
    directory.db.prepare('UPDATE tickets SET number = 7 WHERE key = ?').run('TAB-1');
    directory.db.prepare('UPDATE ticket_counters SET next_number = 5 WHERE scope = ? AND prefix = ?').run('trk_default', 'TAB');
    expect(epochJump(directory.db, 1234)).toEqual([{ scope: 'trk_default', prefix: 'TAB', oldNext: 5, newNext: 1008 }]);
    expect(directory.db.prepare('SELECT next_number, updated_at FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB'))
      .toEqual({ next_number: 1008, updated_at: 1234 });
  });

  it('notifies listeners only after the outer ticket transaction commits', () => {
    const directory = open();
    const person = directory.createUser({ email: 'owner@example.com', role: 'owner' })!;
    const actor = { id: person.id, role: person.role, name: person.name };
    const observed: number[] = [];
    directory.transaction(() => {
      createTicket({
        directory,
        actor,
        title: 'After commit observer',
        onCounterAdvanced: () => observed.push(Number(directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?')
          .get('trk_default', 'TAB')!.next_number)),
      });
      expect(observed).toEqual([]);
      expect(Number(directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?')
        .get('trk_default', 'TAB')!.next_number)).toBe(2);
    });
    expect(observed).toEqual([2]);
  });

  it('tells the directory listener for any ticket creator, after commit, and survives a throwing listener', () => {
    const directory = open();
    const person = directory.createUser({ email: 'owner@example.com', role: 'owner' })!;
    const actor = { id: person.id, role: person.role, name: person.name };
    const seen: number[] = [];
    directory.setKeyFloorListener(() => seen.push(Number((directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?')
      .get('trk_default', 'TAB') as { next_number: number }).next_number)));
    createTicket({ directory, actor, title: 'one' });
    expect(seen).toEqual([2]);
    directory.setKeyFloorListener(() => { throw new Error('listener down'); });
    expect(createTicket({ directory, actor, title: 'two' }).key).toBe('TAB-2');
  });

  it('rolls the whole jump back with its transaction', () => {
    const directory = open();
    const before = directory.db.prepare('SELECT next_number FROM ticket_counters').all();
    expect(() => directory.transaction(() => {
      expect(epochJump(directory.db, 5)).toHaveLength(1);
      expect(directory.db.prepare('SELECT next_number FROM ticket_counters').all()).not.toEqual(before);
      throw new Error('audit failed');
    })).toThrow('audit failed');
    expect(directory.db.prepare('SELECT next_number FROM ticket_counters').all()).toEqual(before);
  });

  it('keeps reporting during a steady stream of creates: never more than 25 behind live', async () => {
    const directory = open();
    const timers = timerRig();
    const events = new EventEmitter();
    const reports: Array<Array<{ floor: number }>> = [];
    const reporter = createKeyFloorReporter({
      directory, events,
      cloud: { reportKeyFloor: async (counters: Array<{ floor: number }>) => { reports.push(counters); } },
      now: timers.now, setTimeout: timers.setTimeout as any, clearTimeout: timers.clearTimeout as any,
    });
    await reporter.flush();
    const live = () => Number((directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB') as { next_number: number }).next_number);
    let firstAfter25: number | null = null;
    for (let i = 1; i <= 200; i++) {
      directory.db.prepare('UPDATE ticket_counters SET next_number = next_number + 1 WHERE scope = ? AND prefix = ?').run('trk_default', 'TAB');
      events.emit(KEY_FLOOR_CHANGED_EVENT);
      timers.advance(1000);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      if (i === 25) firstAfter25 = i;
      const last = reports.at(-1)![0].floor;
      expect(live() - last, `after create ${i}`).toBeLessThanOrEqual(25);
    }
    expect(firstAfter25).toBe(25);
    expect(reports.length).toBeGreaterThanOrEqual(8);
    reporter.close();
  });

  it('reads and atomically writes a validated self-host floor file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-floor-'));
    roots.push(root);
    const file = path.join(root, 'nested', 'floor.json');
    const value = { counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 14 }], at: 123 };
    writeKeyFloorFile(file, value.counters, value.at);
    expect(readKeyFloorFile(file)).toEqual(value);
    fs.writeFileSync(file, '{');
    expect(readKeyFloorFile(file)).toBeNull();
  });

  it('keeps self-hosted floor files monotonic when the live counter is restored lower', async () => {
    const directory = open();
    const person = directory.createUser({ email: 'owner@example.com', role: 'owner' })!;
    const actor = { id: person.id, role: person.role, name: person.name };
    createTicket({ directory, actor, title: 'floor file seed' });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-floor-monotonic-'));
    roots.push(root);
    const file = path.join(root, 'floor.json');
    const events = new EventEmitter();
    const timers = timerRig();
    const reporter = createKeyFloorReporter({
      directory,
      events,
      floorFile: file,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    await reporter.flush();
    directory.db.prepare('UPDATE ticket_counters SET next_number = 100 WHERE scope = ? AND prefix = ?').run('trk_default', 'TAB');
    await reporter.flush();
    directory.db.prepare('UPDATE ticket_counters SET next_number = 2 WHERE scope = ? AND prefix = ?').run('trk_default', 'TAB');
    await reporter.flush();
    expect(readKeyFloorFile(file)?.counters).toEqual([{ scope: 'trk_default', prefix: 'TAB', floor: 100 }]);
    reporter.close();
  });

  it('rejects a floor file under DATA_DIR or a relative floor file at config load', () => {
    expect(loadConfig({ DATA_DIR: '/srv/tabula/data', TABULA_TRACKER_KEY_FLOOR_FILE: '/srv/tabula/floors.json' }).trackerKeyFloorFile)
      .toBe(path.resolve('/srv/tabula/floors.json'));
    expect(() => loadConfig({ DATA_DIR: '/srv/tabula/data', TABULA_TRACKER_KEY_FLOOR_FILE: '/srv/tabula/data/floors.json' }))
      .toThrow('TABULA_TRACKER_KEY_FLOOR_FILE must be outside DATA_DIR');
    expect(() => loadConfig({ DATA_DIR: '/srv/tabula/data', TABULA_TRACKER_KEY_FLOOR_FILE: 'floors.json' }))
      .toThrow('TABULA_TRACKER_KEY_FLOOR_FILE must be an absolute path outside DATA_DIR');
  });

  it('debounces reports at 25 keys and a failing post cannot fail ticket creation', async () => {
    const directory = open();
    const person = directory.createUser({ email: 'owner@example.com', role: 'owner' })!;
    const actor = { id: person.id, role: person.role, name: person.name };
    createTicket({ directory, actor, title: 'seed for reporting' });
    const events = new EventEmitter();
    const timers = timerRig();
    const reports: unknown[] = [];
    const reporter = createKeyFloorReporter({
      directory,
      events,
      cloud: { reportKeyFloor: async (counters: unknown) => { reports.push(counters); } },
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    await reporter.flush();
    const initial = directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB')!.next_number as number;
    directory.db.prepare('UPDATE ticket_counters SET next_number = ? WHERE scope = ? AND prefix = ?').run(initial + 24, 'trk_default', 'TAB');
    events.emit(KEY_FLOOR_CHANGED_EVENT);
    timers.advance(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reports).toHaveLength(1);
    directory.db.prepare('UPDATE ticket_counters SET next_number = ? WHERE scope = ? AND prefix = ?').run(initial + 25, 'trk_default', 'TAB');
    events.emit(KEY_FLOOR_CHANGED_EVENT);
    timers.advance(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual([{ scope: 'trk_default', prefix: 'TAB', floor: initial + 25 }]);
    timers.advance(24 * 60 * 60 * 1000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reports).toHaveLength(3);
    reporter.close();

    const failingEvents = new EventEmitter();
    let failOnce = true;
    let attempts = 0;
    const failing = createKeyFloorReporter({
      directory,
      events: failingEvents,
      cloud: { reportKeyFloor: async () => { attempts++; if (failOnce) { failOnce = false; throw new Error('offline'); } } },
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const nextBeforeFailure = Number(directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB')!.next_number);
    let created: ReturnType<typeof createTicket> | undefined;
    let createError: unknown;
    try {
      created = createTicket({
        directory,
        actor,
        title: 'Floor sink failure is harmless',
        onCounterAdvanced: () => failingEvents.emit(KEY_FLOOR_CHANGED_EVENT),
      });
    } catch (error) { createError = error; }
    await expect(failing.flush()).resolves.toBeDefined();
    expect(attempts).toBe(1);
    expect(createError).toBeUndefined();
    expect(created?.key).toBe(`TAB-${nextBeforeFailure}`);
    timers.advance(29_999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(attempts).toBe(1);
    timers.advance(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(attempts).toBe(2);
    failing.close();
  });
});
