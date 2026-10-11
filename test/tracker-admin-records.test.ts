import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { createTrackerAdminRoutes } from '../server/tracker/admin-routes.mjs';
import { maybeClearGate } from '../server/tracker/gate.mjs';
import { commentTicket, createTicket } from '../server/tracker/tickets.mjs';

class RouteError extends Error {
  status: number;
  code: string;
  extra?: unknown;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const directories: Array<ReturnType<typeof openDirectory>> = [];
const open = () => {
  const directory = openDirectory(':memory:');
  directories.push(directory);
  return directory;
};
afterEach(() => { for (const directory of directories.splice(0)) directory.close(); });

function errorOf(run: () => unknown) {
  try { run(); } catch (error) { return error; }
  throw new Error('Expected the route to throw');
}

function routeHarness(directory: ReturnType<typeof openDirectory>, options: Record<string, unknown> = {}) {
  let now = Date.parse('2026-10-11T12:00:00.000Z');
  const compiled: Array<{ method: string; path: string; handler: (args: any) => unknown; options: any }> = [];
  const events: string[] = [];
  const audit = (user: any, action: string, detail: Record<string, unknown>) => directory.audit(user.id, action, detail);
  const routes = createTrackerAdminRoutes({
    directory,
    compile(method: string, path: string, routeOptions: unknown, handler: (args: any) => unknown) {
      const route = { method, path, options: routeOptions, handler };
      compiled.push(route);
      return route;
    },
    audit,
    requireOwner(user: any) {
      if (user.role !== 'owner') throw new RouteError(403, 'forbidden', 'Only the workspace owner can do that');
    },
    errors: { HttpError: RouteError },
    now: () => now,
    backupStatus: () => ({ enabled: true, target: 's3', dirty: false, lastSuccessAt: now }),
    backupConfig: { intervalMinutes: 15, settleSeconds: 120, verifyHours: 24, keepDailyDays: 30 },
    ...options,
  } as any);
  const call = (method: string, path: string, args: { user?: any; body?: any } = {}) => {
    const route = compiled.find((candidate) => candidate.method === method && candidate.path === path);
    if (!route) throw new Error(`No route ${method} ${path}`);
    const res = { setHeader() {} };
    return route.handler({ user: args.user ?? { id: 'owner-id', role: 'owner' }, body: Object.hasOwn(args, 'body') ? args.body : {}, res });
  };
  return { routes, compiled, call, events, setNow(value: number) { now = value; } };
}

const validDrill = (overrides: Record<string, unknown> = {}) => ({
  at: '2026-10-10T11:30:00.000Z',
  kind: 'local',
  schema: 18,
  restoreSeconds: 120,
  dataLossSeconds: 60,
  boxes: [{ id: 'seed', result: 'pass' }, { id: 'slice8_connection_health', result: 'not_present' }],
  overall: 'pass',
  ...overrides,
});

describe('tracker admin records', () => {
  it('normalizes and stores a strict drill record, and rejects unknown fields or box ids', () => {
    const directory = open();
    const routes = routeHarness(directory);
    const [status, record] = routes.call('POST', 'admin/tracker/drill-record', { body: validDrill() }) as [number, any];
    expect(status).toBe(200);
    expect(record.at).toBe(Date.parse('2026-10-10T11:30:00.000Z'));
    expect(directory.getSetting('tracker.drill.last')).toBe(JSON.stringify(record));
    expect(directory.listAudit(10)[0]).toMatchObject({ action: 'tracker.drill_record', detail: { kind: 'local' } });
    for (const body of [
      validDrill({ unexpected: true }),
      validDrill({ boxes: [{ id: 'not_a_box', result: 'pass' }] }),
      validDrill({ at: '2026-02-30T11:30:00.000Z' }),
    ]) {
      expect(errorOf(() => routes.call('POST', 'admin/tracker/drill-record', { body }))).toMatchObject({ status: 400, code: 'drill_record_invalid' });
    }
    expect(errorOf(() => routes.call('POST', 'admin/tracker/drill-record', { body: null })))
      .toMatchObject({ status: 400, code: 'drill_record_invalid' });
  });

  it('stores only a real non-future cutover calendar date and audits the exact detail', () => {
    const directory = open();
    const routes = routeHarness(directory);
    expect(errorOf(() => routes.call('POST', 'admin/tracker/cutover-record', { body: { importVerifiedAt: '2026-02-30', lossReportAccepted: true } })))
      .toMatchObject({ status: 400, code: 'cutover_record_invalid' });
    expect(errorOf(() => routes.call('POST', 'admin/tracker/cutover-record', { body: { importVerifiedAt: '2026-10-12', lossReportAccepted: true } })))
      .toMatchObject({ status: 400, code: 'cutover_record_invalid' });
    expect(errorOf(() => routes.call('POST', 'admin/tracker/cutover-record', { body: null })))
      .toMatchObject({ status: 400, code: 'cutover_record_invalid' });
    const [status, record] = routes.call('POST', 'admin/tracker/cutover-record', {
      body: { importVerifiedAt: '2026-10-10', lossReportAccepted: true },
    }) as [number, any];
    expect(status).toBe(200);
    expect(record).toEqual({ importVerifiedAt: '2026-10-10', lossReportAccepted: true });
    expect(directory.getSetting('tracker.cutover.record')).toBe(JSON.stringify(record));
    expect(directory.listAudit(10)[0]).toMatchObject({ action: 'tracker.cutover_record', detail: { importVerifiedAt: '2026-10-10' } });
  });

  it('uses restore engine state, jumps counters, conditionally clears the gate, and keeps ticket text out of responses and audit', () => {
    const directory = open();
    const person = directory.createUser({ email: 'owner@example.com', role: 'owner' })!;
    const actor = { id: person.id, role: person.role, name: person.name };
    const privateTitle = 'UNIQUE_READINESS_TITLE_7f2c91';
    const privateComment = 'UNIQUE_COMMENT_BODY_3b8a14';
    const ticket = createTicket({ directory, actor, title: privateTitle });
    commentTicket({ directory, actor, key: ticket.key, body: privateComment });
    const now = Date.parse('2026-10-11T12:00:00.000Z');
    directory.setSetting('tracker.restore_gate', JSON.stringify({ since: now - 12_000, reason: 'restore', floor: 'pending' }));

    let running = false;
    const emitted: string[] = [];
    const routes = routeHarness(directory, {
      now: () => now,
      restore: { isRunning: () => running },
      emit: (event: string) => emitted.push(event),
    });
    const [readStatus, readiness] = routes.call('GET', 'admin/tracker/readiness') as [number, any];
    expect(readStatus).toBe(200);
    expect(Object.keys(readiness)).toEqual(['at', 'overall', 'gate', 'targets', 'checks']);
    expect(readiness.gate).toEqual({ closed: true, since: now - 12_000, floor: 'pending' });
    expect(readiness.checks.map((check: any) => check.id)).toHaveLength(12);
    const readJson = JSON.stringify(readiness);
    expect(readJson).not.toContain(privateTitle);
    expect(readJson).not.toContain(privateComment);

    running = true;
    expect(errorOf(() => routes.call('POST', 'admin/tracker/key-epoch', { body: { confirm: 'JUMP' } })))
      .toMatchObject({ status: 503, code: 'tracker_restoring', extra: { floor: 'pending' } });
    running = false;
    expect(errorOf(() => routes.call('POST', 'admin/tracker/key-epoch', { body: { confirm: 'wrong' } })))
      .toMatchObject({ status: 400, code: 'key_epoch_confirmation_mismatch' });
    // Part B has not reported the reconcile and the search rebuild: the jump marks the floor known, the gate stays closed.
    const [epochStatus, first] = routes.call('POST', 'admin/tracker/key-epoch', { body: { confirm: 'JUMP' } }) as [number, any];
    expect(epochStatus).toBe(200);
    expect(first).toMatchObject({ gateCleared: false, counters: [{ scope: 'trk_default', prefix: 'TAB', oldNext: 2, newNext: 1002 }] });
    expect(JSON.parse(String(directory.getSetting('tracker.restore_gate')))).toMatchObject({ floor: 'known' });
    directory.setSetting('tracker.reconcile_done', '1');
    expect(JSON.parse(String(directory.getSetting('tracker.restore_gate')))).toMatchObject({ floor: 'known' });
    const [, onlyOne] = routes.call('POST', 'admin/tracker/key-epoch', { body: { confirm: 'JUMP' } }) as [number, any];
    expect(onlyOne.gateCleared).toBe(false);
    directory.setSetting('tracker.fts_ready', '1');
    const [, epoch] = routes.call('POST', 'admin/tracker/key-epoch', { body: { confirm: 'JUMP' } }) as [number, any];
    expect(epoch).toMatchObject({ gateCleared: true });
    expect(directory.getSetting('tracker.restore_gate')).toBeNull();
    expect(emitted).toEqual(['tracker-key-floor-changed', 'tracker-key-floor-changed', 'tracker-key-floor-changed']);
    const serialized = JSON.stringify({ epoch, audit: directory.listAudit(20) });
    expect(serialized).not.toContain(privateTitle);
    expect(serialized).not.toContain(privateComment);
    expect(directory.listAudit(20).map((row) => row.action)).toEqual(['tracker.gate_cleared', 'tracker.key_epoch', 'tracker.key_epoch', 'tracker.key_epoch']);
  });

  it('clears a gate only when floor, reconcile and FTS signals are all true', () => {
    const directory = open();
    const writes: Array<[string, unknown]> = [];
    const now = 100_000;
    directory.setSetting('tracker.restore_gate', JSON.stringify({ since: now - 2000, reason: 'restore', floor: 'known' }));
    const audit = (action: string, detail: any) => {
      writes.push([action, detail]);
      directory.audit(null, action, detail);
    };
    expect(maybeClearGate(directory.db, { floorKnown: true, reconcileDone: false, ftsReady: true, now: () => now }, audit)).toBe(false);
    expect(directory.getSetting('tracker.restore_gate')).not.toBeNull();
    expect(maybeClearGate(directory.db, { floorKnown: true, reconcileDone: true, ftsReady: true, now: () => now }, audit)).toBe(true);
    expect(directory.getSetting('tracker.restore_gate')).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('tracker.gate_cleared');
    expect(writes[0][1]).toMatchObject({ closedSeconds: 2 });
    expect(directory.listAudit(10).some((row) => row.action === 'tracker.gate_cleared')).toBe(true);
  });

  it('requires an owner on every registered handler before inspecting request data', () => {
    const directory = open();
    const routes = routeHarness(directory);
    const admin = { id: 'admin-id', role: 'admin' };
    const member = { id: 'member-id', role: 'member' };
    const requests = [
      ['GET', 'admin/tracker/readiness', {}],
      ['POST', 'admin/tracker/key-epoch', { confirm: 'wrong' }],
      ['POST', 'admin/tracker/drill-record', {}],
      ['POST', 'admin/tracker/cutover-record', {}],
    ] as const;
    for (const [method, path, body] of requests) {
      for (const user of [member, admin]) {
        expect(errorOf(() => routes.call(method, path, { user, body }))).toMatchObject({ status: 403, code: 'forbidden' });
      }
    }
  });
});
