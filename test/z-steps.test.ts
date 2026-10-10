import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { planStep } from '../src/z-order';
import { contextMenuItems } from '../src/ui/context-menu';
import type { BaseObj, Obj } from '../src/types';

// TAB-108: Bring forward and Send backward move the selection past the nearest object it overlaps, one step.

const obj = (id: string, z: string, extra: Partial<BaseObj> = {}): BaseObj => ({ id, type: 'sticky', x: 0, y: 0, w: 10, h: 10, rotation: 0, z, ...extra });
/** Two objects overlap when their x ranges do (the tests lay objects out in a row). */
const overlaps = (a: Obj, b: Obj) => {
  const A = a as BaseObj;
  const B = b as BaseObj;
  return A.x < B.x + B.w && B.x < A.x + A.w;
};
const apply = (objs: Obj[], patches: { id: string; z: string }[] | null) => {
  const z = new Map((patches ?? []).map((p) => [p.id, p.z]));
  return objs.map((o) => ({ ...o, z: z.get(o.id) ?? o.z }));
};
const order = (objs: Obj[]) => [...objs].sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1)).map((o) => o.id);
const row = (...ids: string[]) => ids.map((id, i) => obj(id, `a${i}`));

describe('planStep forward', () => {
  it('moves one object above the next one it overlaps', () => {
    const objs = row('a', 'b', 'c', 'd');
    expect(order(apply(objs, planStep(objs, ['b'], 1, () => true)))).toEqual(['a', 'c', 'b', 'd']);
  });

  it('writes only the moved object and keeps every other key', () => {
    const objs = row('a', 'b', 'c', 'd');
    const patches = planStep(objs, ['b'], 1, () => true)!;
    expect(patches.map((p) => p.id)).toEqual(['b']);
    expect(patches[0].z > 'a2' && patches[0].z < 'a3').toBe(true);
  });

  it('steps past objects it does not overlap to the first one it does', () => {
    const objs = [obj('a', 'a0', { x: 0 }), obj('b', 'a1', { x: 100 }), obj('c', 'a2', { x: 5 }), obj('d', 'a3', { x: 100 })];
    expect(order(apply(objs, planStep(objs, ['a'], 1, overlaps)))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('does nothing when nothing above overlaps', () => {
    const objs = [obj('a', 'a0', { x: 0 }), obj('b', 'a1', { x: 100 })];
    expect(planStep(objs, ['a'], 1, overlaps)).toBeNull();
    expect(planStep(row('a', 'b'), ['b'], 1, () => true)).toBeNull(); // already on top
  });

  it('moves a selection as a block, keeping its order, past the nearest overlapping object above its top', () => {
    const objs = row('a', 'b', 'c', 'd', 'e');
    expect(order(apply(objs, planStep(objs, ['a', 'c'], 1, () => true)))).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('works when the keys of two neighbours are equal (an old board)', () => {
    const objs = [obj('a', 'a0'), obj('b', 'a1'), obj('c', 'a1'), obj('d', 'a1')];
    const after = apply(objs, planStep(objs, ['a'], 1, () => true));
    expect(order(after).indexOf('a')).toBe(1);
    expect(order(after)).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('planStep backward', () => {
  it('moves one object below the nearest one it overlaps', () => {
    const objs = row('a', 'b', 'c', 'd');
    expect(order(apply(objs, planStep(objs, ['c'], -1, () => true)))).toEqual(['a', 'c', 'b', 'd']);
    expect(order(apply(objs, planStep(objs, ['b', 'd'], -1, () => true)))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('skips objects it does not overlap and stops at the bottom', () => {
    const objs = [obj('a', 'a0', { x: 5 }), obj('b', 'a1', { x: 100 }), obj('c', 'a2', { x: 0 })];
    expect(order(apply(objs, planStep(objs, ['c'], -1, overlaps)))).toEqual(['c', 'a', 'b']);
    expect(planStep(row('a', 'b'), ['a'], -1, () => true)).toBeNull();
  });

  it('forward and backward undo each other', () => {
    const objs = row('a', 'b', 'c', 'd');
    const forward = apply(objs, planStep(objs, ['b'], 1, () => true));
    expect(order(apply(forward, planStep(forward, ['b'], -1, () => true)))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('frames and the rest', () => {
  it('step among their own kind: a frame never passes a note, whatever the keys', () => {
    const objs = [obj('f1', 'a5', { type: 'frame' }), obj('f2', 'a6', { type: 'frame' }), obj('n1', 'a1'), obj('n2', 'a2')];
    expect(order(apply(objs, planStep(objs, ['f1'], 1, () => true))).filter((id) => id.startsWith('f'))).toEqual(['f2', 'f1']);
    const after = apply(objs, planStep(objs, ['n1'], 1, () => true));
    expect(order(after).filter((id) => id.startsWith('n'))).toEqual(['n2', 'n1']);
    expect(after.find((o) => o.id === 'f1')!.z).toBe('a5');
  });

  it('steps a frame and a note together, each among its own kind', () => {
    const objs = [obj('f1', 'a0', { type: 'frame' }), obj('f2', 'a1', { type: 'frame' }), obj('n1', 'a2'), obj('n2', 'a3')];
    const after = apply(objs, planStep(objs, ['f1', 'n1'], 1, () => true));
    const o = order(after);
    expect(o.filter((id) => id.startsWith('f'))).toEqual(['f2', 'f1']);
    expect(o.filter((id) => id.startsWith('n'))).toEqual(['n2', 'n1']);
  });

  it('ignores ids that are not on the board and an empty selection', () => {
    const objs = row('a', 'b');
    expect(planStep(objs, ['zzz'], 1, () => true)).toBeNull();
    expect(planStep(objs, [], -1, () => true)).toBeNull();
  });
});

describe('group sibling stacking', () => {
  it('steps a group by its derived overlap rectangle and writes only the group key', () => {
    const group: Obj = { id: 'g', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a0' };
    const child = obj('child', 'a1', { parent: 'g', x: 10, w: 30 });
    const sibling = obj('sibling', 'a2', { x: 20 });
    const derived = new Map([['g', { x: 10, y: 0, w: 30, h: 10 }]]);
    const bounds = (o: Obj) => derived.get(o.id) ?? { x: (o as BaseObj).x, y: (o as BaseObj).y, w: (o as BaseObj).w, h: (o as BaseObj).h };
    const overlaps = (a: Obj, b: Obj) => {
      const A = bounds(a), B = bounds(b);
      return A.x < B.x + B.w && B.x < A.x + A.w;
    };
    const objects: Obj[] = [group, child, sibling];
    const plan = planStep(objects, ['g'], 1, overlaps);
    expect(plan?.map((patch) => patch.id)).toEqual(['g']);
    const after = apply(objects, plan);
    expect(after.find((o) => o.id === 'g')!.z > after.find((o) => o.id === 'sibling')!.z).toBe(true);
    expect(after.find((o) => o.id === 'child')!.z).toBe('a1');
  });

  it('steps members within their entered group, ignoring overlapping objects outside that sibling row', () => {
    const outer: Obj = { id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a0' };
    const first = obj('first', 'a1', { parent: 'outer' });
    const outside = obj('outside', 'a2');
    const second = obj('second', 'a3', { parent: 'outer' });
    const objects: Obj[] = [outer, first, outside, second];
    const after = apply(objects, planStep(objects, ['first'], 1, () => true));
    expect(after.find((o) => o.id === 'first')!.z > after.find((o) => o.id === 'second')!.z).toBe(true);
    expect(after.find((o) => o.id === 'outside')!.z).toBe('a2');
  });
});

describe('Store.restack', () => {
  it('writes the keys in one undo step', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => ['a', 'b', 'c'].forEach((id, i) => store.create(obj(id, `a${i}`))));
    store.undo.stopCapturing();
    const patches = planStep(store.ordered(), ['a'], 1, () => true);
    expect(store.restack(patches)).toBe(true);
    expect(store.ordered().map((o) => o.id)).toEqual(['b', 'a', 'c']);
    store.undo.undo();
    expect(store.ordered().map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('writes nothing for no plan or on a read-only board', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => store.create(obj('a', 'a0')));
    expect(store.restack(null)).toBe(false);
    expect(store.restack([])).toBe(false);
    store.setReadOnly(true);
    expect(store.restack([{ id: 'a', z: 'a9' }])).toBe(false);
    expect((store.get('a') as BaseObj).z).toBe('a0');
  });
});

describe('the context menu', () => {
  it('has stacking, grouping, duplicate, lock and delete in order', () => {
    const items = contextMenuItems({ count: 1, locked: false });
    expect(items.map((i) => i.action)).toEqual(['front', 'forward', 'backward', 'back', 'group', 'ungroup', 'duplicate', 'lock', 'delete']);
    expect(items.map((i) => i.label).slice(0, 4)).toEqual(['Bring to front', 'Bring forward', 'Send backward', 'Send to back']);
    expect(items.find((i) => i.action === 'delete')!.danger).toBe(true);
    expect(items.find((i) => i.action === 'duplicate')!.separatorBefore).toBe(true);
    expect(items.find((i) => i.action === 'group')).toMatchObject({ disabled: true, reason: 'Select at least two groupable items.' });
    expect(items.find((i) => i.action === 'ungroup')!.disabled).toBe(true);
    expect(contextMenuItems({ count: 2, locked: false, groupReason: null, canUngroup: true }).filter((i) => i.action === 'group' || i.action === 'ungroup').every((i) => !i.disabled)).toBe(true);
  });

  it('says Unlock for a locked selection and has no entries without a selection', () => {
    expect(contextMenuItems({ count: 2, locked: true }).find((i) => i.action === 'lock')!.label).toBe('Unlock');
    expect(contextMenuItems({ count: 0, locked: false })).toEqual([]);
  });

  it('names the keys', () => {
    const hints = Object.fromEntries(contextMenuItems({ count: 1, locked: false }).map((i) => [i.action, i.hint]));
    expect(hints.front).toBe(']');
    expect(hints.back).toBe('[');
    expect(hints.forward).toMatch(/^(Ctrl|Cmd)\+\]$/);
    expect(hints.backward).toMatch(/^(Ctrl|Cmd)\+\[$/);
  });
});
