import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { COMMENTS_ORIGIN, Comments, anchorFor, anchorPosition, threadVisible, type Anchor, type Author, type Thread } from '../src/comments';
import { LOCAL } from '../src/store';
import { denyOnce, type DeniedReason } from '../src/sync';
import type { BaseObj, Obj } from '../src/types';

const ALICE: Author = { id: 'alice', name: 'Alice', color: '#f00' };
const BOB: Author = { id: 'bob', name: 'Bob', color: '#0f0' };
const OWNER = { id: 'owner', moderator: true };
const asUser = (a: Author) => ({ id: a.id, moderator: false });
const CAROL: Author = { id: 'carol', name: 'Carol', color: '#00f' };
const AT = { x: 10, y: 20 };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Each Y.Doc becomes one comments document, with its own Comments view. */
function peers(n: number): { docs: Y.Doc[]; cs: Comments[] } {
  const docs = Array.from({ length: n }, () => new Y.Doc());
  return { docs, cs: docs.map((d) => new Comments(d)) };
}

/** Exchanges the missing updates in both directions. */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('threads and replies', () => {
  it('lists threads oldest first, then by id', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2000);
    const c = new Comments(new Y.Doc());
    const late = c.addThread(ALICE, AT, 'later')!;
    now.mockReturnValue(1000);
    const early = c.addThread(BOB, AT, 'earlier')!;
    expect(c.list().map((t) => t.id)).toEqual([early, late]);
  });

  it('breaks ties between equal creation times by id', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5);
    const c = new Comments(new Y.Doc());
    c.addThread(ALICE, AT, 'a');
    c.addThread(ALICE, AT, 'b');
    const ids = c.list().map((t) => t.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('lists replies oldest first', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(3000);
    const c = new Comments(new Y.Doc());
    const t = c.addThread(ALICE, AT, 'root')!;
    const late = c.reply(t, BOB, 'late')!;
    now.mockReturnValue(2000);
    const early = c.reply(t, CAROL, 'early')!;
    expect(c.get(t)?.replies.map((r) => r.id)).toEqual([early, late]);
  });

  it('adds replies and edits the thread and reply text', () => {
    const c = new Comments(new Y.Doc());
    const t = c.addThread(ALICE, AT, '  first  ')!;
    expect(c.get(t)?.text).toBe('first');
    const r = c.reply(t, BOB, 'hi')!;
    expect(c.editThread(t, 'changed')).toBe(true);
    expect(c.editReply(t, r, 'hello')).toBe(true);
    const got = c.get(t)!;
    expect(got.text).toBe('changed');
    expect(got.editedAt).toBeTypeOf('number');
    expect(got.replies[0]).toMatchObject({ id: r, authorId: 'bob', text: 'hello' });
    expect(got.replies[0].editedAt).toBeTypeOf('number');
  });

  it('resolves and reopens a thread', () => {
    const c = new Comments(new Y.Doc());
    const t = c.addThread(ALICE, AT, 'x')!;
    expect(c.setResolved(t, true, BOB)).toBe(true);
    expect(c.get(t)).toMatchObject({ resolved: true, resolvedBy: 'bob' });
    expect(c.counts()).toEqual({ open: 0, resolved: 1 });
    expect(c.setResolved(t, false, BOB)).toBe(true);
    const reopened = c.get(t)!;
    expect(reopened.resolved).toBe(false);
    expect(reopened.resolvedBy).toBeUndefined();
    expect(reopened.resolvedAt).toBeUndefined();
    expect(c.counts()).toEqual({ open: 1, resolved: 0 });
  });

  it('removes replies and threads once', () => {
    const c = new Comments(new Y.Doc());
    const t = c.addThread(ALICE, AT, 'x')!;
    const r = c.reply(t, BOB, 'y')!;
    expect(c.removeReply(t, r, OWNER)).toBe(true);
    expect(c.get(t)?.replies).toEqual([]);
    expect(c.removeReply(t, r, OWNER)).toBe(false);
    expect(c.removeThread(t, OWNER)).toBe(true);
    expect(c.list()).toEqual([]);
    expect(c.removeThread(t, OWNER)).toBe(false);
  });

  it('lets authors delete their own comments and the owner delete anyone\'s, nobody else', () => {
    const c = new Comments(new Y.Doc());
    const t = c.addThread(ALICE, AT, 'x')!;
    const r = c.reply(t, BOB, 'y')!;
    expect(c.removeReply(t, r, asUser(ALICE))).toBe(false);
    expect(c.removeThread(t, asUser(BOB))).toBe(false);
    expect(c.removeThread(t, asUser(ALICE))).toBe(false); // Bob's reply is not hers to take down
    expect(c.removeReply(t, r, asUser(BOB))).toBe(true);
    expect(c.removeThread(t, asUser(ALICE))).toBe(true);
    const t2 = c.addThread(ALICE, AT, 'z')!;
    const r2 = c.reply(t2, BOB, 'w')!;
    expect(c.removeReply(t2, r2, OWNER)).toBe(true);
    expect(c.removeThread(t2, OWNER)).toBe(true);
  });

  it('refuses writes to threads that do not exist', () => {
    const c = new Comments(new Y.Doc());
    expect(c.reply('missing', BOB, 'hi')).toBeNull();
    expect(c.editThread('missing', 'hi')).toBe(false);
    expect(c.setResolved('missing', true, BOB)).toBe(false);
    expect(c.removeThread('missing', OWNER)).toBe(false);
  });

  it('rejects empty, blank and over-long text on every write', () => {
    const c = new Comments(new Y.Doc());
    const t = c.addThread(ALICE, AT, 'ok')!;
    const r = c.reply(t, BOB, 'ok')!;
    for (const bad of ['', '   \n\t', 'x'.repeat(4001)]) {
      expect(c.addThread(ALICE, AT, bad)).toBeNull();
      expect(c.reply(t, BOB, bad)).toBeNull();
      expect(c.editThread(t, bad)).toBe(false);
      expect(c.editReply(t, r, bad)).toBe(false);
    }
    expect(c.get(t)?.text).toBe('ok');
    expect(c.list()).toHaveLength(1);
  });

  it('accepts text of exactly 4000 characters and caps names at 80', () => {
    const c = new Comments(new Y.Doc());
    const t = c.addThread({ ...ALICE, name: 'n'.repeat(120) }, AT, 'x'.repeat(4000))!;
    expect(c.get(t)?.text).toHaveLength(4000);
    expect(c.get(t)?.authorName).toHaveLength(80);
  });

  it.each([NaN, Infinity, -Infinity, undefined])('refuses a pin whose x or y is %s', (v) => {
    const c = new Comments(new Y.Doc());
    expect(c.addThread(ALICE, { x: v as number, y: 1 }, 'hi')).toBeNull();
    expect(c.addThread(ALICE, { x: 1, y: v as number }, 'hi')).toBeNull();
    expect(c.list()).toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity])('refuses a pin whose fraction is %s', (v) => {
    const c = new Comments(new Y.Doc());
    expect(c.addThread(ALICE, { x: 1, y: 2, obj: 'b', fx: v, fy: 0.5 }, 'hi')).toBeNull();
    expect(c.addThread(ALICE, { x: 1, y: 2, obj: 'b', fx: 0.5, fy: v }, 'hi')).toBeNull();
    expect(c.list()).toEqual([]);
  });

  it('accepts a pin without fractions, and one whose object is gone', () => {
    const c = new Comments(new Y.Doc());
    expect(c.addThread(ALICE, { x: 1, y: 2, obj: 'b', fx: undefined, fy: undefined }, 'hi')).not.toBeNull();
    expect(c.list()).toHaveLength(1);
  });

  it('stores an anchor on an object without undefined fields', () => {
    const c = new Comments(new Y.Doc());
    const t = c.addThread(ALICE, AT, 'x')!;
    expect(c.get(t)?.anchor).toEqual({ x: 10, y: 20 });
    expect(Object.keys(c.get(t)!.anchor)).toEqual(['x', 'y']);
  });
});

describe('read-only', () => {
  it('blocks every write and still applies remote updates', () => {
    const { docs, cs: [a, b] } = peers(2);
    const t = a.addThread(ALICE, AT, 'base')!;
    const r = a.reply(t, ALICE, 'reply')!;
    sync(docs[0], docs[1]);
    b.setReadOnly(true);
    expect(b.readOnly()).toBe(true);
    const before = b.list();
    const state = Y.encodeStateVector(docs[1]);

    expect(b.addThread(BOB, AT, 'nope')).toBeNull();
    expect(b.reply(t, BOB, 'nope')).toBeNull();
    expect(b.editThread(t, 'nope')).toBe(false);
    expect(b.editReply(t, r, 'nope')).toBe(false);
    expect(b.setResolved(t, true, BOB)).toBe(false);
    expect(b.removeReply(t, r, OWNER)).toBe(false);
    expect(b.removeThread(t, OWNER)).toBe(false);
    expect(b.importThreads(a.list())).toBe(0);
    expect(b.list()).toEqual(before);
    expect(Y.encodeStateVector(docs[1])).toEqual(state);

    a.reply(t, ALICE, 'remote');
    sync(docs[0], docs[1]);
    expect(b.get(t)?.replies.map((x) => x.text)).toEqual(['reply', 'remote']);
  });

  it('notifies listeners only when the flag changes', () => {
    const c = new Comments(new Y.Doc());
    const seen: boolean[] = [];
    const off = c.onReadOnly((v) => seen.push(v));
    c.setReadOnly(true);
    c.setReadOnly(true);
    c.setReadOnly(false);
    off();
    c.setReadOnly(true);
    expect(seen).toEqual([true, false]);
  });
});

describe('merging', () => {
  it('keeps two concurrent replies and a concurrent resolve, in any order', () => {
    const { docs, cs } = peers(3);
    const t = cs[0].addThread(ALICE, AT, 'start')!;
    sync(docs[0], docs[1]);
    sync(docs[0], docs[2]);
    cs[0].reply(t, ALICE, 'from alice');
    cs[1].reply(t, BOB, 'from bob');
    cs[2].setResolved(t, true, CAROL);
    const states = docs.map((d) => Y.encodeStateAsUpdate(d));

    const merge = (order: number[]) => {
      const doc = new Y.Doc();
      for (const i of order) Y.applyUpdate(doc, states[i]);
      return new Comments(doc).list();
    };
    const forward = merge([0, 1, 2]);
    expect(forward).toHaveLength(1);
    expect(forward[0].replies.map((r) => r.text).sort()).toEqual(['from alice', 'from bob']);
    expect(forward[0].resolved).toBe(true);
    expect(merge([2, 1, 0])).toEqual(forward);
    expect(merge([1, 2, 0])).toEqual(forward);

    sync(docs[0], docs[1]);
    sync(docs[1], docs[2]);
    sync(docs[0], docs[2]);
    for (const c of cs) {
      expect(c.get(t)?.resolved).toBe(true);
      expect(c.get(t)?.replies).toHaveLength(2);
    }
  });

  it('merges concurrent edits to different threads', () => {
    const { docs, cs } = peers(2);
    const t1 = cs[0].addThread(ALICE, AT, 'one')!;
    const t2 = cs[0].addThread(ALICE, AT, 'two')!;
    sync(docs[0], docs[1]);
    cs[0].editThread(t1, 'one, edited');
    cs[1].editThread(t2, 'two, edited');
    sync(docs[0], docs[1]);
    expect(cs[1].get(t1)?.text).toBe('one, edited');
    expect(cs[0].get(t2)?.text).toBe('two, edited');
  });
});

describe('onChange', () => {
  it('fires for remote and local changes, once per microtask', async () => {
    const { docs, cs: [a, b] } = peers(2);
    const updates: Uint8Array[] = [];
    docs[0].on('update', (u: Uint8Array) => updates.push(u));
    let calls = 0;
    b.onChange(() => {
      calls++;
    });
    a.addThread(ALICE, AT, 'one');
    a.addThread(ALICE, AT, 'two');
    a.addThread(ALICE, AT, 'three');
    for (const u of updates) Y.applyUpdate(docs[1], u);
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);

    b.addThread(BOB, AT, 'local');
    await Promise.resolve();
    expect(calls).toBe(2);
  });
});

describe('history', () => {
  it('keeps comment writes out of the board undo history', () => {
    expect(COMMENTS_ORIGIN).not.toBe(LOCAL);
    const doc = new Y.Doc();
    const undo = new Y.UndoManager(doc.getMap('threads'), { trackedOrigins: new Set([LOCAL]) });
    const c = new Comments(doc);
    c.addThread(ALICE, AT, 'x');
    expect(undo.canUndo()).toBe(false);
    doc.transact(() => doc.getMap('threads').set('probe', new Y.Map()), LOCAL);
    expect(undo.canUndo()).toBe(true);
  });
});

describe('importThreads', () => {
  it('adds threads from a JSON export, skipping ids that already exist and keeping replies', () => {
    const src = new Comments(new Y.Doc());
    const kept = src.addThread(ALICE, AT, 'exported')!;
    src.reply(kept, BOB, 'exported reply');
    const fresh = src.addThread(CAROL, { x: 1, y: 1 }, 'new one')!;
    src.reply(fresh, ALICE, 'answer');
    const exported = JSON.parse(JSON.stringify(src.list())) as Thread[];

    const dst = new Comments(new Y.Doc());
    expect(dst.importThreads(exported)).toBe(2);
    expect(dst.editThread(kept, 'local edit')).toBe(true);
    expect(dst.importThreads(exported)).toBe(0);
    expect(dst.get(kept)?.text).toBe('local edit');
    expect(dst.get(kept)?.replies.map((r) => r.text)).toEqual(['exported reply']);
    expect(dst.get(fresh)).toMatchObject({ authorId: 'carol', text: 'new one' });
    expect(dst.get(fresh)?.replies.map((r) => r.text)).toEqual(['answer']);
  });

  it.each([NaN, Infinity, -Infinity, undefined])('skips imported threads whose anchor x is %s', (v) => {
    const src = new Comments(new Y.Doc());
    src.addThread(ALICE, AT, 'ok');
    const [thread] = src.list();
    const dst = new Comments(new Y.Doc());
    expect(dst.importThreads([{ ...thread, id: 'bad', anchor: { x: v as number, y: 0 } }])).toBe(0);
    expect(dst.list()).toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity])('skips imported threads whose fraction is %s', (v) => {
    const src = new Comments(new Y.Doc());
    src.addThread(ALICE, AT, 'ok');
    const [thread] = src.list();
    const dst = new Comments(new Y.Doc());
    expect(dst.importThreads([{ ...thread, id: 'bad-fx', anchor: { x: 0, y: 0, obj: 'b', fx: v, fy: 0 } }])).toBe(0);
    expect(dst.list()).toEqual([]);
  });

  it('skips threads with blank text or no anchor position', () => {
    const src = new Comments(new Y.Doc());
    const t = src.addThread(ALICE, AT, 'ok')!;
    const [thread] = src.list();
    const dst = new Comments(new Y.Doc());
    expect(dst.importThreads([{ ...thread, id: 'blank', text: '   ' }])).toBe(0);
    expect(dst.importThreads([{ ...thread, id: 'noanchor', anchor: {} as Anchor }])).toBe(0);
    expect(dst.get(t)).toBeUndefined();
  });
});

describe('anchors', () => {
  const shape = (over: Partial<BaseObj> = {}): BaseObj => ({
    id: 'b', type: 'shape', kind: 'rect', x: 100, y: 50, w: 200, h: 100, rotation: 0, z: 'a0', ...over,
  });
  const lookup = (...objs: Obj[]) => (id: string) => objs.find((o) => o.id === id);
  const deg = (d: number) => (d * Math.PI) / 180;

  it('stores the absolute point alone when there is no object', () => {
    expect(anchorFor({ x: 1, y: 2 }, undefined)).toEqual({ x: 1, y: 2 });
  });

  it('stores the fraction of an unrotated box', () => {
    const o = shape();
    const a = anchorFor({ x: 150, y: 75 }, o);
    expect(a).toMatchObject({ x: 150, y: 75, obj: 'b' });
    expect(a.fx).toBeCloseTo(0.25, 6);
    expect(a.fy).toBeCloseTo(0.25, 6);
    const p = anchorPosition(a, lookup(o));
    expect(p.x).toBeCloseTo(150, 6);
    expect(p.y).toBeCloseTo(75, 6);
  });

  it.each([0, 90, 33])('round-trips a point on a box rotated %d degrees', (d) => {
    const o = shape({ rotation: deg(d) });
    const p = { x: 180, y: 90 };
    const back = anchorPosition(anchorFor(p, o), lookup(o));
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it('measures a point on a box rotated 90 degrees in the box frame', () => {
    // The local point (0.3, 0.6) of the box, turned a quarter turn about its centre (200, 100).
    const a = anchorFor({ x: 190, y: 60 }, shape({ rotation: Math.PI / 2 }));
    expect(a.fx).toBeCloseTo(0.3, 6);
    expect(a.fy).toBeCloseTo(0.6, 6);
  });

  it('keeps the same fraction after the object is moved, resized and rotated', () => {
    const before = shape({ rotation: deg(33) });
    const pin = anchorPosition({ x: 0, y: 0, obj: 'b', fx: 0.3, fy: 0.6 }, lookup(before));
    const a = anchorFor(pin, before);
    const after = shape({ x: 300, y: -40, w: 120, h: 260, rotation: deg(33) });
    const back = anchorFor(anchorPosition(a, lookup(after)), after);
    expect(back.fx).toBeCloseTo(0.3, 6);
    expect(back.fy).toBeCloseTo(0.6, 6);
  });

  it('follows an unrotated box that is moved and resized', () => {
    const a = anchorFor({ x: 150, y: 75 }, shape());
    const p = anchorPosition(a, lookup(shape({ x: 300, y: -40, w: 120, h: 260 })));
    expect(p.x).toBeCloseTo(330, 6);
    expect(p.y).toBeCloseTo(25, 6);
  });

  it('falls back to the absolute point when the object is gone', () => {
    const a = anchorFor({ x: 150, y: 75 }, shape());
    expect(anchorPosition(a, () => undefined)).toEqual({ x: 150, y: 75 });
  });

  it('uses the middle of an object with no width or height', () => {
    const o = shape({ w: 0, h: 0 });
    const a = anchorFor({ x: 100, y: 80 }, o);
    expect(a.fx).toBe(0.5);
    expect(a.fy).toBe(0.5);
    const p = anchorPosition(a, lookup(o));
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('threadVisible', () => {
  const shape = (): BaseObj => ({ id: 'b', type: 'shape', kind: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a0' });
  const lookup = (o: Obj | undefined) => () => o;
  const threadOn = (anchor: Anchor): Thread => ({
    id: 't', createdAt: 0, authorId: 'a', authorName: 'A', authorColor: '#000', text: 'x', anchor, resolved: false, replies: [],
  });

  it('hides a thread whose object is hidden', () => {
    const t = threadOn({ x: 1, y: 1, obj: 'b', fx: 0.5, fy: 0.5 });
    expect(threadVisible(t, lookup(shape()), () => true)).toBe(false);
  });

  it('shows a thread whose object is not hidden, and passes the object to isHidden', () => {
    const o = shape();
    const isHidden = vi.fn<(o: BaseObj) => boolean>(() => false);
    expect(threadVisible(threadOn({ x: 1, y: 1, obj: 'b', fx: 0.5, fy: 0.5 }), lookup(o), isHidden)).toBe(true);
    expect(isHidden).toHaveBeenCalledWith(o);
  });

  it('shows threads without an object, or whose object is gone, without asking isHidden', () => {
    const isHidden = vi.fn<(o: BaseObj) => boolean>(() => true);
    expect(threadVisible(threadOn({ x: 1, y: 1 }), lookup(shape()), isHidden)).toBe(true);
    expect(threadVisible(threadOn({ x: 1, y: 1, obj: 'b', fx: 0.5, fy: 0.5 }), lookup(undefined), isHidden)).toBe(true);
    expect(isHidden).not.toHaveBeenCalled();
  });
});

describe('denyOnce', () => {
  const room = () => ({ disconnect: vi.fn<() => void>(), shouldConnect: true });

  it('stops both rooms and reports once, however many rooms are refused', () => {
    const conn: { denied: DeniedReason | null } = { denied: null };
    const board = room();
    const comments = room();
    const denied = vi.fn<(reason: DeniedReason) => void>();
    denyOnce(conn, [board, comments], 4403, denied);
    denyOnce(conn, [board, comments], 4410, denied);
    expect(conn.denied).toBe('no_access');
    expect(board.disconnect).toHaveBeenCalledTimes(1);
    expect(comments.disconnect).toHaveBeenCalledTimes(1);
    expect(board.shouldConnect).toBe(false);
    expect(comments.shouldConnect).toBe(false);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied).toHaveBeenCalledWith('no_access');
  });

  it('ignores close codes that are not denials and a missing close event', () => {
    const conn: { denied: DeniedReason | null } = { denied: null };
    const board = room();
    const denied = vi.fn<(reason: DeniedReason) => void>();
    denyOnce(conn, [board], 1006, denied);
    denyOnce(conn, [board], undefined, denied);
    expect(conn.denied).toBeNull();
    expect(board.disconnect).not.toHaveBeenCalled();
    expect(board.shouldConnect).toBe(true);
    expect(denied).not.toHaveBeenCalled();
  });
});
