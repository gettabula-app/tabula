import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { createSyncGuard, MAX_KEY, plainBounded } from '../server/sync-guard.mjs';
import { createCommentGuard } from '../server/comment-authz.mjs';

type FakeRoom = { kind: 'board' | 'comments'; doc: Y.Doc; held: Uint8Array[] | null; sent: Uint8Array[]; broadcastUpdate(u: Uint8Array): void; syncUndo?: Y.UndoManager };
const room = (kind: 'board' | 'comments'): FakeRoom => {
  const doc = new Y.Doc({ gc: true });
  const r: FakeRoom = { kind, doc, held: null, sent: [], broadcastUpdate(u) { r.sent.push(u); } };
  doc.on('update', (u: Uint8Array) => { if (r.held) r.held.push(u); else r.sent.push(u); });
  return r;
};
const ws = {} as { close?: () => void; syncValidateStrikes?: number[] };
const ctx = { writer: { id: 'u1', name: 'Lea' }, isBoardMember: () => true, canEditObject: () => true };
const sticky = (extra: Record<string, unknown> = {}) => new Y.Map<unknown>(Object.entries({ id: 'x', type: 'sticky', x: 1, y: 2, w: 3, h: 4, rotation: 0, z: 'a', ...extra }));
const put = (r: FakeRoom, origin: object, id: string, m: Y.Map<unknown>) => r.doc.transact(() => r.doc.getMap('objects').set(id, m), origin);

describe('sync guard', () => {
  it('report mode: counts by code and kind, changes nothing, and logs one summary line without ids', () => {
    const lines: string[] = [];
    let t = 0;
    const guard = createSyncGuard({ mode: 'report', log: (...a: unknown[]) => lines.push(a.join(' ')), now: () => t });
    const r = room('board');
    guard.run(r, ws, ctx, () => put(r, ws, 'secret-board-object', sticky({ id: 'secret-board-object', x: 'no' })));
    expect(r.doc.getMap('objects').has('secret-board-object')).toBe(true);
    expect(guard.stats()).toMatchObject({ mode: 'report', updates: 1, violations: 1, rejected: 0, byCode: { bad_type: 1 }, byKind: { object: 1 } });
    expect(lines).toEqual([]);
    t = 61_000;
    guard.run(r, ws, ctx, () => put(r, ws, 'ok', sticky({ id: 'ok' })));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/1 violations \{"bad_type":1\}/);
    expect(lines[0]).not.toMatch(/secret|u1/);
    t = 62_000;
    guard.run(r, ws, ctx, () => put(r, ws, 'ok2', sticky({ id: 'ok2' })));
    expect(lines).toHaveLength(1);
  });

  it('never throws into the sync path, and rethrows what the message itself threw', () => {
    const guard = createSyncGuard({ mode: 'report' });
    const r = room('board');
    expect(() => guard.run(r, ws, { ...ctx, isBoardMember: () => { throw new Error('boom'); } }, () => put(r, ws, 'c', sticky({ id: 'c', ownerId: 'x', type: 'card' })))).not.toThrow();
    expect(() => guard.run(r, ws, ctx, () => { throw new Error('bad frame'); })).toThrow('bad frame');
    const off = createSyncGuard({ mode: 'off' });
    expect(off.enabled).toBe(false);
  });

  it('bounds the keys examined and counts the rest as skipped', () => {
    const guard = createSyncGuard({ mode: 'report', maxKeys: 3 });
    const r = room('board');
    guard.run(r, ws, ctx, () => r.doc.transact(() => { for (let i = 0; i < 10; i++) r.doc.getMap('objects').set(`k${i}`, sticky({ id: `k${i}`, x: 'no' })); }, ws));
    expect(guard.stats()).toMatchObject({ keys: 3, skipped: 7, violations: 3 });
  });

  it('enforce mode: reverts the whole message, broadcasts the revert with it, and keeps earlier data', () => {
    const guard = createSyncGuard({ mode: 'enforce' });
    const r = room('board');
    guard.run(r, ws, ctx, () => put(r, ws, 'good', sticky({ id: 'good' })));
    expect(r.doc.getMap('objects').has('good')).toBe(true);
    r.sent.length = 0;
    guard.run(r, ws, ctx, () => r.doc.transact(() => {
      r.doc.getMap('objects').set('bad', sticky({ id: 'bad', w: Number.POSITIVE_INFINITY }));
      (r.doc.getMap('objects').get('good') as Y.Map<unknown>).set('text', 'edited');
    }, ws));
    expect(r.doc.getMap('objects').has('bad')).toBe(false);
    expect((r.doc.getMap('objects').get('good') as Y.Map<unknown>).get('text')).toBeUndefined();
    expect(r.held).toBeNull();
    // one broadcast holds the change and its revert: a fresh client applying it ends on the reverted state
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(r.doc));
    for (const u of r.sent) Y.applyUpdate(other, u);
    expect(other.getMap('objects').has('bad')).toBe(false);
    expect(guard.stats()).toMatchObject({ rejected: 1 });
    // a report-only violation (a text cap) does not revert
    guard.run(r, ws, ctx, () => put(r, ws, 'long', sticky({ id: 'long', text: 'x'.repeat(20_001) })));
    expect(r.doc.getMap('objects').has('long')).toBe(true);
    expect(guard.stats().rejected).toBe(1);
  });

  it('enforce mode: 20 violations from one socket close it', () => {
    let closed = 0;
    const socket = { close: () => { closed++; } } as unknown as typeof ws;
    const guard = createSyncGuard({ mode: 'enforce' });
    const r = room('board');
    for (let i = 0; i < 25; i++) guard.run(r, socket, ctx, () => put(r, socket, `b${i}`, sticky({ id: `b${i}`, x: 'no' })));
    expect(closed).toBeGreaterThan(0);
    expect(guard.stats().closed).toBeGreaterThan(0);
    const other = { close: () => { closed = -100; } } as unknown as typeof ws;
    guard.run(r, other, ctx, () => put(r, other, 'one', sticky({ id: 'one', x: 'no' })));
    expect(closed).toBeGreaterThan(0);
  });

  it('comments room: what the comments guard repairs is counted as repaired, not as a violation', () => {
    const guard = createSyncGuard({ mode: 'enforce' });
    const r = room('comments');
    const comments = createCommentGuard(r.doc, { isAccount: () => true });
    const actor = { id: 'u1', role: 'commenter', name: 'Lea' };
    const thread = (author: string) => new Y.Map<unknown>(Object.entries({
      id: 't1', createdAt: 1_700_000_000_000, authorId: author, authorName: 'Lea', authorColor: '#326DD3', text: 'Hello', anchor: { x: 1, y: 2 }, resolved: false, replies: new Y.Map(),
    }));
    guard.run(r, ws, { ...ctx, writer: { id: 'u1', name: 'Lea' } }, () => comments.run(actor, () => r.doc.transact(() => r.doc.getMap('threads').set('t1', thread('someone-else')), ws)));
    const stored = (r.doc.getMap('threads').get('t1') as Y.Map<unknown>).toJSON();
    expect(stored.authorId).toBe('u1');
    expect(guard.stats()).toMatchObject({ violations: 0, rejected: 0 });
    expect(guard.stats().repaired).toBeGreaterThanOrEqual(1);
    // a malformed thread the guard cannot repair is reverted
    guard.run(r, ws, ctx, () => comments.run(actor, () => r.doc.transact(() => r.doc.getMap('threads').set('t2', new Y.Map<unknown>(Object.entries({ id: 't2', createdAt: 1, authorId: 'u1', authorName: 'Lea', authorColor: 'blue', text: 'x', anchor: { x: 1, y: 2 }, resolved: false, replies: new Y.Map() }))), ws)));
    expect(r.doc.getMap('threads').has('t2')).toBe(false);
    expect(r.doc.getMap('threads').has('t1')).toBe(true);
  });

  it('enforce mode: a message with keys left unexamined is reverted, so a bad object after the 5,000th key is not accepted', () => {
    const guard = createSyncGuard({ mode: 'enforce' });
    const r = room('board');
    guard.run(r, ws, ctx, () => r.doc.transact(() => {
      const objects = r.doc.getMap('objects');
      for (let i = 0; i < 5000; i++) objects.set(`k${i}`, sticky({ id: `k${i}` }));
      objects.set('late-bad', sticky({ id: 'late-bad', x: 'no' }));
    }, ws));
    expect(r.doc.getMap('objects').size).toBe(0);
    expect(guard.stats()).toMatchObject({ rejected: 1, tooManyKeys: 1, byCode: { too_many_keys: 1 } });
    // 5,000 good keys are within the cap and stay
    guard.run(r, ws, ctx, () => r.doc.transact(() => { for (let i = 0; i < 5000; i++) r.doc.getMap('objects').set(`g${i}`, sticky({ id: `g${i}` })); }, ws));
    expect(r.doc.getMap('objects').size).toBe(5000);
  });

  it('report mode: counts the keys it did not examine and still accepts the message', () => {
    const guard = createSyncGuard({ mode: 'report', maxKeys: 5 });
    const r = room('board');
    guard.run(r, ws, ctx, () => r.doc.transact(() => { for (let i = 0; i < 9; i++) r.doc.getMap('objects').set(`k${i}`, sticky({ id: `k${i}` })); }, ws));
    expect(r.doc.getMap('objects').size).toBe(9);
    expect(guard.stats()).toMatchObject({ skipped: 4, violations: 0, rejected: 0 });
  });

  it('spends a byte and node budget across the message: what it cannot afford is skipped (budget), not a violation', () => {
    const report = createSyncGuard({ mode: 'report', maxBytes: 600, maxNodes: 1_000_000 });
    const r = room('board');
    report.run(r, ws, ctx, () => r.doc.transact(() => { for (let i = 0; i < 30; i++) r.doc.getMap('objects').set(`k${i}`, sticky({ id: `k${i}`, text: 'x'.repeat(100) })); }, ws));
    expect(report.stats().skipped).toBeGreaterThan(0);
    expect(report.stats().skippedBudget).toBe(report.stats().skipped);
    expect(report.stats().violations).toBe(0);
    const nodes = createSyncGuard({ mode: 'enforce', maxNodes: 40 });
    const r2 = room('board');
    nodes.run(r2, ws, ctx, () => r2.doc.transact(() => { for (let i = 0; i < 30; i++) r2.doc.getMap('objects').set(`k${i}`, sticky({ id: `k${i}` })); }, ws));
    expect(r2.doc.getMap('objects').size).toBe(0);
    expect(nodes.stats().tooManyKeys).toBe(1);
  });

  it('reads a field edit of an existing object without the rest of it', () => {
    const guard = createSyncGuard({ mode: 'enforce', maxBytes: 300 });
    const r = room('board');
    const big = sticky({ id: 'big', text: 'x'.repeat(5000) });
    r.doc.transact(() => r.doc.getMap('objects').set('big', big), 'seed');
    // the 5,000-character text is not read when only x changes, so the small budget is enough
    guard.run(r, ws, ctx, () => r.doc.transact(() => big.set('x', 7), ws));
    expect(big.get('x')).toBe(7);
    expect(guard.stats()).toMatchObject({ skipped: 0, rejected: 0 });
  });

  it('detaches every observer it attached when attaching one throws part-way, and (report mode) falls back to a plain apply', () => {
    const lines: string[] = [];
    let t = 0;
    const guard = createSyncGuard({ mode: 'report', now: () => t, log: (...a: unknown[]) => lines.push(a.join(' ')) });
    const r = room('board');
    const maps = new Map<string, Y.Map<unknown>>();
    const realGetMap = r.doc.getMap.bind(r.doc);
    let observers = 0;
    r.doc.getMap = ((name: string) => {
      const m = realGetMap(name) as Y.Map<unknown>;
      if (!maps.has(name)) {
        const observe = m.observeDeep.bind(m);
        const unobserve = m.unobserveDeep.bind(m);
        m.observeDeep = ((fn: never) => { if (name === 'flow') throw new Error('SECRET-MESSAGE'); observers++; observe(fn); }) as never;
        m.unobserveDeep = ((fn: never) => { observers--; unobserve(fn); }) as never;
        maps.set(name, m);
      }
      return m;
    }) as never;
    let ran = 0;
    guard.run(r, ws, ctx, () => { ran++; put(r, ws, 'a', sticky({ id: 'a' })); });
    expect(ran).toBe(1);
    expect(observers).toBe(0);
    expect(r.doc.getMap('objects').has('a')).toBe(true);
    expect(r.held).toBeNull();
    expect(lines).toEqual([]); // report mode is silent per message
    t = 61_000;
    guard.run(r, ws, ctx, () => put(r, ws, 'b', sticky({ id: 'b' })));
    expect(lines.join('\n')).toMatch(/2 checks failed to run \(last: Error\)/);
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(guard.stats().checkErrors).toBe(2);
  });

  it('a logger that throws cannot break sync or skip the fallback, and the validator error is logged by code only', () => {
    let t0 = 0;
    const guard = createSyncGuard({ mode: 'report', now: () => t0, log: () => { throw new Error('logger down'); } });
    const r = room('board');
    const err = Object.assign(new TypeError('private content'), { code: 'E_PRIVATE' });
    const bad = { ...ctx, isBoardMember: () => { throw err; }, };
    expect(() => guard.run(r, ws, bad, () => put(r, ws, 'c', sticky({ id: 'c', type: 'card', ownerId: 'x' })))).not.toThrow();
    expect(r.doc.getMap('objects').has('c')).toBe(true);
    t0 = 61_000;
    expect(() => guard.run(r, ws, ctx, () => put(r, ws, 'e', sticky({ id: 'e' })))).not.toThrow();
    const lines: string[] = [];
    let t1 = 0;
    const g2 = createSyncGuard({ mode: 'report', now: () => t1, log: (...a: unknown[]) => lines.push(a.join(' ')) });
    g2.run(r, ws, bad, () => put(r, ws, 'd', sticky({ id: 'd', type: 'card', ownerId: 'x' })));
    t1 = 61_000;
    g2.run(r, ws, ctx, () => put(r, ws, 'f', sticky({ id: 'f' })));
    expect(lines.join('\n')).toContain('1 checks failed to run (last: TypeError:E_PRIVATE)');
    expect(lines.join('\n')).not.toContain('private content');
  });

  it('enforce mode: a check that throws rejects the message (reverted, counted as check_error) and repeated errors close the socket', () => {
    let closed = 0;
    const socket = { close: () => { closed++; } } as unknown as typeof ws;
    const lines: string[] = [];
    const guard = createSyncGuard({ mode: 'enforce', validate: () => { throw Object.assign(new RangeError('SECRET'), { code: 'E_X' }); }, log: (...a: unknown[]) => lines.push(a.join(' ')) });
    const r = room('board');
    guard.run(r, socket, ctx, () => put(r, socket, 'one', sticky({ id: 'one' })));
    expect(r.doc.getMap('objects').has('one')).toBe(false);
    expect(guard.stats()).toMatchObject({ rejected: 1, checkErrors: 1, byCode: { check_error: 1 } });
    for (let i = 0; i < 25; i++) guard.run(r, socket, ctx, () => put(r, socket, `k${i}`, sticky({ id: `k${i}` })));
    expect(r.doc.getMap('objects').size).toBe(0);
    expect(closed).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(r.held).toBeNull();
  });

  it('enforce mode: when the check cannot be set up, the message is not applied', () => {
    const guard = createSyncGuard({ mode: 'enforce' });
    const r = room('board');
    const realGetMap = r.doc.getMap.bind(r.doc);
    r.doc.getMap = ((name: string) => { if (name === 'labels') throw new Error('nope'); return realGetMap(name); }) as never;
    let ran = 0;
    guard.run(r, ws, ctx, () => { ran++; });
    expect(ran).toBe(0);
    expect(guard.stats()).toMatchObject({ rejected: 1, checkErrors: 1 });
    expect(r.held).toBeNull();
  });

  it('report mode: a validator that throws changes nothing and logs nothing per message', () => {
    const lines: string[] = [];
    const guard = createSyncGuard({ mode: 'report', validate: () => { throw new Error('x'); }, log: (...a: unknown[]) => lines.push(a.join(' ')) });
    const r = room('board');
    guard.run(r, ws, ctx, () => put(r, ws, 'one', sticky({ id: 'one' })));
    expect(r.doc.getMap('objects').has('one')).toBe(true);
    expect(lines).toEqual([]);
  });

  it('bounds collection: past the key cap nothing more is recorded or read', () => {
    let calls = 0;
    const guard = createSyncGuard({ mode: 'report', maxKeys: 10, validate: (changes: unknown[]) => { calls += changes.length; return { ok: true }; } });
    const r = room('board');
    guard.run(r, ws, ctx, () => r.doc.transact(() => { for (let i = 0; i < 30_000; i++) r.doc.getMap('objects').set(`k${i}`, sticky({ id: `k${i}` })); }, ws));
    expect(calls).toBeLessThanOrEqual(10);
    expect(guard.stats()).toMatchObject({ keys: 10, skipped: 29_990 });
  });

  it('bounds conversion: a huge value is cut off at the budget, not materialised', () => {
    const budget = { bytes: 1_000_000, nodes: 100, exhausted: false };
    expect(plainBounded(Array.from({ length: 1_000_000 }, (_, i) => i), budget)).toBeUndefined();
    expect(budget.exhausted).toBe(true);
    expect(budget.nodes).toBeGreaterThan(-3); // stopped at the cap, not after a million values
    const y = new Y.Doc();
    const m = y.getMap('objects');
    m.set('big', new Y.Map(Object.entries({ type: 'path', points: Array.from({ length: 500_000 }, (_, i) => i) })));
    const b2 = { bytes: 2 * 1024 * 1024, nodes: 50_000, exhausted: false };
    expect(plainBounded(m.get('big'), b2)).toBeUndefined();
    expect(b2.exhausted).toBe(true);
    const ok = { bytes: 1000, nodes: 100, exhausted: false };
    m.set('small', new Y.Map(Object.entries({ a: 1, b: 'x', c: [1, 2], d: { e: true } })));
    expect(plainBounded(m.get('small'), ok)).toEqual({ a: 1, b: 'x', c: [1, 2], d: { e: true } });
    // a __proto__ own key is copied the way toJSON copies it, so the validator still sees it
    m.set('hostile', new Y.Map());
    (m.get('hostile') as Y.Map<unknown>).set('__proto__', { polluted: 1 });
    expect(Object.getPrototypeOf(plainBounded(m.get('hostile'), { bytes: 1000, nodes: 100, exhausted: false }))).not.toBe(Object.prototype);
  });

  it('a hostile oversized object in a message is skipped by budget in report mode and reverts the message in enforce mode', () => {
    for (const mode of ['report', 'enforce'] as const) {
      const guard = createSyncGuard({ mode });
      const r = room('board');
      guard.run(r, ws, ctx, () => put(r, ws, 'big', sticky({ id: 'big', type: 'path', points: Array.from({ length: 200_000 }, (_, i) => i) })));
      expect(guard.stats().skippedBudget).toBe(1);
      expect(r.doc.getMap('objects').has('big')).toBe(mode === 'report');
    }
  });

  describe('hostile sizes: the work is bounded before the value is materialised', () => {
    it('a Y.Array of 1,000,000 tiny items is refused by its length, without reading an item or calling toArray', () => {
      const doc = new Y.Doc();
      const obj = new Y.Map<unknown>();
      doc.getMap('objects').set('o', obj);
      const arr = new Y.Array<number>();
      obj.set('points', arr);
      arr.push(Array.from({ length: 1_000_000 }, () => 0));
      const toArray = vi.spyOn(Y.Array.prototype, 'toArray');
      const budget = { bytes: 2 * 1024 * 1024, nodes: 50_000, exhausted: false };
      const t0 = performance.now();
      expect(plainBounded(obj, budget)).toBeUndefined();
      const ms = performance.now() - t0;
      expect(budget.exhausted).toBe(true);
      expect(50_000 - budget.nodes).toBeLessThan(10); // visited a handful of values, not a million
      expect(toArray).not.toHaveBeenCalled();
      expect(ms).toBeLessThan(100);
      toArray.mockRestore();
    });

    it('an array of 49,000 items under the length limit stops at the byte budget, after a bounded number of visits', () => {
      const doc = new Y.Doc();
      const obj = new Y.Map<unknown>();
      doc.getMap('objects').set('o', obj);
      const arr = new Y.Array<string>();
      obj.set('items', arr);
      arr.push(Array.from({ length: 40_000 }, () => 'x'.repeat(100)));
      const budget = { bytes: 100_000, nodes: 50_000, exhausted: false };
      expect(plainBounded(obj, budget)).toBeUndefined();
      expect(50_000 - budget.nodes).toBeLessThan(2000);
    });

    it('a 20 MiB Y.Text is refused by its length before toString builds it', () => {
      const doc = new Y.Doc();
      const obj = new Y.Map<unknown>();
      doc.getMap('objects').set('o', obj);
      const text = new Y.Text();
      obj.set('text', text);
      text.insert(0, 'a'.repeat(20 * 1024 * 1024));
      const toString = vi.spyOn(Y.Text.prototype as { toString(): string }, 'toString');
      const budget = { bytes: 2 * 1024 * 1024, nodes: 50_000, exhausted: false };
      expect(plainBounded(obj, budget)).toBeUndefined();
      expect(budget.exhausted).toBe(true);
      expect(toString).not.toHaveBeenCalled();
      toString.mockRestore();
    });

    it('both reject the message in enforce mode and count it as skipped by budget in report mode', () => {
      for (const mode of ['report', 'enforce'] as const) {
        const guard = createSyncGuard({ mode });
        const r = room('board');
        guard.run(r, ws, ctx, () => r.doc.transact(() => {
          const obj = sticky({ id: 'big' });
          r.doc.getMap('objects').set('big', obj);
          const arr = new Y.Array<number>();
          obj.set('points', arr);
          arr.push(Array.from({ length: 300_000 }, () => 0));
        }, ws));
        expect(guard.stats().skippedBudget).toBe(1);
        expect(r.doc.getMap('objects').has('big')).toBe(mode === 'report');
        expect(guard.stats().byCode).toMatchObject(mode === 'enforce' ? { too_many_keys: 1 } : {});
      }
    });

    it('a 1 MiB key is a key_too_long violation: never stored, never joined into another string', () => {
      const long = 'k'.repeat(1024 * 1024);
      for (const mode of ['report', 'enforce'] as const) {
        const lines: string[] = [];
        const guard = createSyncGuard({ mode, log: (...a: unknown[]) => lines.push(a.join(' ')) });
        const r = room('board');
        guard.run(r, ws, ctx, () => put(r, ws, long, sticky({ id: 'x' })));
        expect(guard.stats().byCode).toMatchObject({ key_too_long: 1 });
        expect(guard.stats().keys).toBe(0);
        expect(r.doc.getMap('objects').has(long)).toBe(mode === 'report');
        expect(JSON.stringify(guard.stats())).not.toContain('kkkk');
        expect(lines.join('')).not.toContain('kkkk');
      }
      expect(MAX_KEY).toBe(256);
    });

    it('100,000 keys with long names: at most 5,000 are looked at, the rest are counted, enforce rejects', () => {
      for (const mode of ['report', 'enforce'] as const) {
        const guard = createSyncGuard({ mode });
        const r = room('board');
        let reads = 0;
        const t0 = performance.now();
        guard.run(r, ws, ctx, () => r.doc.transact(() => {
          const objects = r.doc.getMap('objects');
          const name = 'n'.repeat(300);
          for (let i = 0; i < 100_000; i++) objects.set(`${name}${i}`, new Y.Map());
        }, ws));
        void reads;
        const ms = performance.now() - t0;
        const st = guard.stats();
        expect(st.keys + (st.byCode as Record<string, number>).key_too_long).toBeGreaterThan(0);
        expect(st.keys).toBeLessThanOrEqual(5000);
        expect(r.doc.getMap('objects').size).toBe(mode === 'report' ? 100_000 : 0);
        expect(ms).toBeLessThan(20_000);
        expect(st.rejected).toBe(mode === 'enforce' ? 1 : 0);
      }
    }, 60_000);
  });

  describe('nesting and event storms cannot hurt the sync path', () => {
    it('copies a 100,000-deep object and array without recursion, and marks them too_deep', () => {
      let deepObject: unknown = 1;
      let deepArray: unknown = 1;
      for (let i = 0; i < 100_000; i++) { deepObject = { c: deepObject }; deepArray = [deepArray]; }
      for (const value of [deepObject, deepArray]) {
        const budget = { bytes: 2 * 1024 * 1024, nodes: 50_000, exhausted: false };
        expect(() => plainBounded(value, budget)).not.toThrow();
        expect(plainBounded(value, { bytes: 2 * 1024 * 1024, nodes: 50_000, exhausted: false })).toBeUndefined();
      }
      const marked = { bytes: 2 * 1024 * 1024, nodes: 50_000, exhausted: false, tooDeep: false };
      plainBounded(deepObject, marked);
      expect(marked.tooDeep).toBe(true);
      // an ordinary nested value is still copied whole
      expect(plainBounded({ a: { b: [{ c: 1 }] } }, { bytes: 1000, nodes: 100, exhausted: false })).toEqual({ a: { b: [{ c: 1 }] } });
    });

    it('a Y.Map nested 10,000 deep is a too_deep violation in enforce mode and passes through, counted, in report mode', () => {
      for (const mode of ['report', 'enforce'] as const) {
        const guard = createSyncGuard({ mode });
        const r = room('board');
        expect(() => guard.run(r, ws, ctx, () => r.doc.transact(() => {
          const top = sticky({ id: 'deep' });
          r.doc.getMap('objects').set('deep', top);
          let cur: Y.Map<unknown> = top;
          for (let i = 0; i < 10_000; i++) {
            const next = new Y.Map<unknown>();
            cur.set('c', next);
            cur = next;
          }
        }, ws))).not.toThrow();
        expect(guard.stats().byCode).toMatchObject({ too_deep: 1 });
        expect(r.doc.getMap('objects').has('deep')).toBe(mode === 'report');
        expect(guard.stats().rejected).toBe(mode === 'enforce' ? 1 : 0);
      }
    }, 60_000);

    it('an observer that throws never reaches the sync path in report mode, and rejects the message in enforce mode', () => {
      for (const mode of ['report', 'enforce'] as const) {
        const guard = createSyncGuard({ mode });
        const r = room('board');
        const realGetMap = r.doc.getMap.bind(r.doc);
        r.doc.getMap = ((name: string) => {
          const m = realGetMap(name) as Y.Map<unknown>;
          if (name === 'objects' && !(m as { patched?: boolean }).patched) {
            (m as { patched?: boolean }).patched = true;
            const observe = m.observeDeep.bind(m);
            m.observeDeep = ((fn: (e: unknown[], t: unknown) => void) => observe((events, tr) => fn(new Proxy(events, { get(t2, p) { if (p === 'length') throw new RangeError('Maximum call stack size exceeded'); return Reflect.get(t2, p); } }) as never, tr))) as never;
          }
          return m;
        }) as never;
        expect(() => guard.run(r, ws, ctx, () => put(r, ws, 'a', sticky({ id: 'a' })))).not.toThrow();
        expect(guard.stats().checkErrors).toBe(1);
        expect(r.doc.getMap('objects').has('a')).toBe(mode === 'report');
      }
    });

    it('stops walking events at the key cap: 200,000 events are counted as one number', () => {
      const r = room('board');
      const objects = r.doc.getMap('objects');
      r.doc.transact(() => { for (let i = 0; i < 200_000; i++) objects.set(`o${i}`, sticky({ id: `o${i}` })); }, 'seed');
      for (const mode of ['report', 'enforce'] as const) {
        const guard = createSyncGuard({ mode });
        const t0 = performance.now();
        guard.run(r, ws, ctx, () => r.doc.transact(() => { objects.forEach((m) => (m as Y.Map<unknown>).set('x', mode === 'report' ? 5 : 6)); }, ws));
        const ms = performance.now() - t0;
        const st = guard.stats();
        expect(st.keys).toBe(5000);
        expect(st.skipped).toBeGreaterThanOrEqual(195_000);
        expect(ms).toBeLessThan(30_000);
        expect(st.byCode).toMatchObject(mode === 'enforce' ? { too_many_keys: 1 } : {});
      }
    }, 120_000);
  });

  describe('one root key cannot hide a storm of descendant events or a prototype change', () => {
    it('a single object with 200,000 descendant events is cut at the event budget, and enforce rejects', () => {
      const seed = room('board');
      const root = sticky({ id: 'root' });
      seed.doc.transact(() => {
        seed.doc.getMap('objects').set('root', root);
        const kids = new Y.Map<Y.Map<unknown>>();
        root.set('kids', kids);
        for (let i = 0; i < 200_000; i++) kids.set(`k${i}`, new Y.Map());
      }, 'seed');
      const kids = root.get('kids') as Y.Map<Y.Map<unknown>>;
      for (const mode of ['report', 'enforce'] as const) {
        const guard = createSyncGuard({ mode });
        const t0 = performance.now();
        guard.run(seed, ws, ctx, () => seed.doc.transact(() => { kids.forEach((m) => m.set('v', mode)); }, ws));
        const ms = performance.now() - t0;
        const st = guard.stats();
        expect(st.keys).toBe(1); // one root key, 200,001 events under it
        expect(st.skipped).toBeGreaterThanOrEqual(180_000);
        expect(ms).toBeLessThan(30_000);
        expect(st.byCode).toMatchObject(mode === 'enforce' ? { too_many_keys: 1 } : {});
        expect(st.rejected).toBe(mode === 'enforce' ? 1 : 0);
      }
    }, 180_000);

    it('a normal message is not touched by the event budget', () => {
      const guard = createSyncGuard({ mode: 'report' });
      const r = room('board');
      guard.run(r, ws, ctx, () => r.doc.transact(() => { for (let i = 0; i < 4000; i++) r.doc.getMap('objects').set(`n${i}`, sticky({ id: `n${i}` })); }, ws));
      expect(guard.stats()).toMatchObject({ keys: 4000, skipped: 0 });
    });

    it('a nested object decoded from a REAL update with an own __proto__ key is a forbidden_key violation (lib0 turns it into a prototype change)', () => {
      const source = new Y.Doc();
      source.getMap('objects').set('o', new Y.Map(Object.entries({ id: 'o', type: 'sticky', x: 1, y: 2, w: 3, h: 4, rotation: 0, z: 'a', data: JSON.parse('{"a":{"__proto__":{"x":1}}}') })));
      const update = Y.encodeStateAsUpdate(source);
      const probe = new Y.Doc();
      Y.applyUpdate(probe, update);
      const decoded = ((probe.getMap('objects').get('o') as Y.Map<unknown>).get('data') as { a: object }).a;
      expect(Object.keys(decoded)).not.toContain('__proto__'); // lib0 assigned it: the prototype changed, no own key was added
      expect(Object.getPrototypeOf(decoded)).not.toBe(Object.prototype);
      for (const mode of ['report', 'enforce'] as const) {
        const guard = createSyncGuard({ mode });
        const r = room('board');
        guard.run(r, ws, ctx, () => Y.applyUpdate(r.doc, update, ws));
        expect(guard.stats().byCode).toMatchObject({ forbidden_key: 1 });
        expect(r.doc.getMap('objects').has('o')).toBe(mode === 'report');
        expect(guard.stats().rejected).toBe(mode === 'enforce' ? 1 : 0);
      }
    });
  });
});
