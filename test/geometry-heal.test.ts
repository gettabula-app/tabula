import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { GEOMETRY_HEAL, LOCAL, Store } from '../src/store';
import type { Obj } from '../src/types';

// A position is never lost (docs/geometry-heal.md): a board file in the field had objects whose x, y and updatedAt keys were deleted without a replacement, so after
// a reload they were drawn at the origin. Whatever deletes them, the Store writes the position back, outside undo, and a reload shows each object where it was.

const TYPES: Record<string, Record<string, unknown>> = {
  'uml-class': { text: 'Order', attributes: [{ visibility: '-', name: 'id', type: 'UUID' }], operations: [] },
  link: { url: 'https://example.com/a', unfurl: 'ok', title: 'A page' },
  markdown: { text: '# Title\n\nSome text' },
  table: { 'r:r1': 'a0', 'k:c1': 'a0', 'c:r1:c1': 'cell' },
  image: { asset: 'a'.repeat(64), mime: 'image/png' },
  sticky: { text: 'note', fill: '#FFE16B' },
  'uml-initial': {},
  text: { text: 'hello' },
};
const make = (id: string, type: string, x: number, y: number): Obj => ({ id, type, x, y, w: 200, h: 120, rotation: 0, z: `a${id}`, createdBy: 'u1', updatedAt: 1, font: 'satoshi', ...TYPES[type] } as unknown as Obj);
const tick = () => new Promise<void>((r) => queueMicrotask(r));
const pos = (s: Store, id: string) => { const o = s.get(id) as unknown as { x?: number; y?: number }; return [o.x, o.y]; };
const reloaded = (s: Store) => { const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(s.doc)); return new Store(d); };

describe('a position that vanishes is written back', () => {
  it.each(Object.keys(TYPES))('%s: x, y and updatedAt deleted by a remote write are back, and a reload shows it where it was', async (type) => {
    const s = new Store(new Y.Doc());
    s.seed(() => s.create(make('o1', type, 412, -230)));
    s.doc.transact(() => { const m = s.objects.get('o1')!; for (const k of ['x', 'y', 'updatedAt']) m.delete(k); }, 'remote');
    await tick();
    expect(pos(s, 'o1')).toEqual([412, -230]);
    expect(pos(reloaded(s), 'o1')).toEqual([412, -230]);
  });

  it('puts back only what is missing, with the position it had a moment ago', async () => {
    const s = new Store(new Y.Doc());
    s.seed(() => s.create(make('o1', 'sticky', 100, 200)));
    s.doc.transact(() => s.objects.get('o1')!.delete('x'), 'remote');
    await tick();
    expect(pos(s, 'o1')).toEqual([100, 200]);
    s.transact(() => s.update('o1', { x: 500, y: 600 })); // a move after that is a normal one
    s.doc.transact(() => s.objects.get('o1')!.delete('y'), 'remote');
    await tick();
    expect(pos(s, 'o1')).toEqual([500, 600]);
  });

  it('is not an undo step, does not repeat, and leaves the undo stack as it was', async () => {
    const s = new Store(new Y.Doc());
    s.seed(() => s.create(make('o1', 'sticky', 100, 200)));
    s.transact(() => s.update('o1', { x: 300, y: 300 }));
    const steps = s.undo.undoStack.length;
    const origins: unknown[] = [];
    s.onChange((_ids, origin) => origins.push(origin));
    s.doc.transact(() => { const m = s.objects.get('o1')!; m.delete('x'); m.delete('y'); }, 'remote');
    await tick();
    await tick();
    expect(origins).toEqual(['remote', GEOMETRY_HEAL]); // one write back, nothing after it
    expect(s.undo.undoStack.length).toBe(steps);
    s.undo.undo(); // Undo still works and never leaves the object without a position
    expect(pos(s, 'o1').every((v) => Number.isFinite(v))).toBe(true);
  });

  it('survives what the real loss looked like: an undo that deleted the keys of a move and could not restore the old ones', async () => {
    const s = new Store(new Y.Doc());
    s.seed(() => s.create(make('o1', 'uml-class', 100, 200)));
    s.transact(() => s.update('o1', { x: 640, y: 480 }));
    // the loss itself is a Yjs-level deletion of the move's items: model it as the undo manager does, inside its own origin
    s.doc.transact(() => { const m = s.objects.get('o1')!; m.delete('x'); m.delete('y'); m.delete('updatedAt'); }, s.undo);
    await tick();
    expect(pos(s, 'o1')).toEqual([640, 480]);
    expect(pos(reloaded(s), 'o1')).toEqual([640, 480]);
  });

  it('is left alone for what never had a position, for an object that is removed, and in a read-only store', async () => {
    const s = new Store(new Y.Doc());
    s.seed(() => {
      s.create({ id: 'c1', type: 'connector', from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 9, y: 9 }, route: 'straight', startHead: 'none', endHead: 'arrow', z: 'a9', createdBy: 'u1' } as unknown as Obj);
      s.create(make('o1', 'sticky', 100, 200));
      s.create(make('o2', 'sticky', 10, 20));
    });
    s.remove(['o1']);
    await tick();
    expect(s.get('o1')).toBeUndefined();
    expect(Object.keys(s.get('c1')!)).not.toContain('x');
    s.setReadOnly(true);
    s.doc.transact(() => s.objects.get('o2')!.delete('x'), 'remote');
    await tick();
    expect(pos(s, 'o2')[0]).toBeUndefined(); // a viewer does not write
  });

  it('converges between two clients that both see the loss', async () => {
    const a = new Store(new Y.Doc());
    const b = new Store(new Y.Doc());
    const sync = () => { const ua = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)); const ub = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)); Y.applyUpdate(b.doc, ua); Y.applyUpdate(a.doc, ub); };
    a.seed(() => a.create(make('o1', 'markdown', 77, 88)));
    sync();
    a.doc.transact(() => { const m = a.objects.get('o1')!; m.delete('x'); m.delete('y'); }, 'remote');
    sync();
    await tick();
    sync();
    await tick();
    sync();
    expect(pos(a, 'o1')).toEqual([77, 88]);
    expect(pos(b, 'o1')).toEqual([77, 88]);
    expect(LOCAL).toBe('local');
  });
});
