import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { StyleEdit, WheelSteps, clampValue, parseTyped, stepValue, type Patch } from '../src/style-edit';
import type { BaseObj, Obj } from '../src/types';

const text = (id: string, extra: Partial<BaseObj> = {}): BaseObj =>
  ({ id, type: 'text', z: id, x: 0, y: 0, w: 200, h: 30, rotation: 0, text: 'Hello', fontSize: 20, ...extra }) as BaseObj;

/** A store with two text boxes selected, and a write that also sets a derived height, as the app does. */
function setup() {
  const store = new Store(new Y.Doc());
  store.transact(() => {
    store.create(text('a'));
    store.create(text('b', { fontSize: 32 }));
  });
  store.undo.clear();
  let selection = ['a', 'b'];
  const write = (o: Obj, patch: Patch) => {
    store.update(o.id, patch);
    if ('fontSize' in patch) store.update(o.id, { h: Math.round(Number(patch.fontSize) * 1.5) });
  };
  const edit = new StyleEdit(store, () => selection.map((id) => store.get(id)!).filter(Boolean), write);
  const get = (id: string) => store.get(id) as BaseObj;
  return { store, edit, get, select: (ids: string[]) => (selection = ids) };
}

describe('style previews', () => {
  it('shows a preview at once without recording it, and reverts every object to its own value', () => {
    const { store, edit, get } = setup();
    edit.preview({ fontSize: 48 });
    expect([get('a').fontSize, get('b').fontSize]).toEqual([48, 48]);
    expect(get('a').h).toBe(72);
    expect(edit.active).toBe(true);
    expect(store.undo.undoStack).toHaveLength(0);

    edit.preview({ fontSize: 64 }); // a later preview replaces the earlier one
    edit.revert();
    expect([get('a').fontSize, get('b').fontSize]).toEqual([20, 32]);
    expect([get('a').h, get('b').h]).toEqual([30, 30]); // the derived height comes back too
    expect(edit.active).toBe(false);
    expect(store.undo.undoStack).toHaveLength(0);
  });

  it('restores a key the object did not have before the preview by removing it', () => {
    const { edit, get } = setup();
    expect(get('a').fontWeight).toBeUndefined();
    edit.preview({ fontWeight: 900 });
    edit.revert();
    expect('fontWeight' in get('a')).toBe(false);
  });

  it('commits a gesture as one undo entry that undoes to the values before it', () => {
    const { store, edit, get } = setup();
    for (const size of [21, 22, 23, 24, 25]) edit.preview({ fontSize: size });
    edit.commit({ fontSize: 25 });
    expect([get('a').fontSize, get('b').fontSize]).toEqual([25, 25]);
    expect(store.undo.undoStack).toHaveLength(1);
    store.undo.undo();
    expect([get('a').fontSize, get('b').fontSize]).toEqual([20, 32]);
    expect(get('a').h).toBe(30);
  });

  it('keeps separate gestures as separate undo entries', () => {
    const { store, edit, get } = setup();
    edit.preview({ fontSize: 24 });
    edit.commit({ fontSize: 24 });
    edit.preview({ fontSize: 28 });
    edit.commit({ fontSize: 28 });
    expect(store.undo.undoStack).toHaveLength(2);
    store.undo.undo();
    expect(get('a').fontSize).toBe(24);
  });

  it('commits without a preview (a click or a typed value) as one entry too', () => {
    const { store, edit, get } = setup();
    edit.commit({ fontSize: 40 });
    expect(get('b').fontSize).toBe(40);
    expect(store.undo.undoStack).toHaveLength(1);
  });

  it('only touches the objects the filter accepts', () => {
    const { edit, get } = setup();
    edit.preview({ fontSize: 50 }, (o) => o.id === 'b');
    expect([get('a').fontSize, get('b').fontSize]).toEqual([20, 50]);
    edit.revert();
    expect(get('b').fontSize).toBe(32);
  });

  it('writes nothing on a read-only board', () => {
    const { store, edit, get } = setup();
    store.setReadOnly(true);
    edit.preview({ fontSize: 50 });
    edit.commit({ fontSize: 50 });
    expect(get('a').fontSize).toBe(20);
    expect(edit.active).toBe(false);
  });

  it('stays on the objects it started on when the selection changes mid-gesture', () => {
    const { store, edit, get, select } = setup();
    edit.preview({ fontSize: 40 });
    select(['b']);
    edit.preview({ fontSize: 44 });
    edit.commit({ fontSize: 44 });
    expect([get('a').fontSize, get('b').fontSize]).toEqual([44, 44]);
    store.undo.undo();
    expect([get('a').fontSize, get('b').fontSize]).toEqual([20, 32]);
  });

  it('settles: keeps the latest preview as one entry, and does nothing without one', () => {
    const { store, edit, get } = setup();
    edit.settle();
    expect(store.undo.undoStack).toHaveLength(0);
    edit.preview({ fontSize: 26 });
    edit.preview({ fontSize: 27 });
    edit.settle();
    expect(get('a').fontSize).toBe(27);
    expect(edit.active).toBe(false);
    expect(store.undo.undoStack).toHaveLength(1);
  });

  it('tells listeners when a preview ends', () => {
    const { edit } = setup();
    let ended = 0;
    edit.onEnd(() => ended++);
    edit.preview({ fontSize: 30 });
    edit.revert();
    edit.preview({ fontSize: 30 });
    edit.commit({ fontSize: 30 });
    expect(ended).toBe(2);
  });
});

describe('stepping a number field', () => {
  const size = { min: 6, max: 400, step: 1, big: 10 };
  it('steps by one, or by ten with Shift, snapping to the step', () => {
    expect(stepValue(20, 1, size)).toBe(21);
    expect(stepValue(20, -1, size)).toBe(19);
    expect(stepValue(20, 1, size, true)).toBe(30);
    expect(stepValue(23, 1, size, true)).toBe(30); // snaps to the next multiple
    expect(stepValue(23, -1, size, true)).toBe(20);
  });

  it('clamps at both ends', () => {
    expect(stepValue(400, 1, size)).toBe(400);
    expect(stepValue(395, 1, size, true)).toBe(400);
    expect(stepValue(6, -1, size)).toBe(6);
    expect(stepValue(9, -1, size, true)).toBe(6);
    expect(clampValue(1000, size)).toBe(400);
    expect(clampValue(-5, size)).toBe(6);
  });

  it('reads typed values', () => {
    expect(parseTyped('24')).toBe(24);
    expect(parseTyped(' 12.5 px')).toBe(12.5);
    expect(parseTyped('80%')).toBe(80);
    expect(parseTyped('abc')).toBeNull();
  });

  it('turns trackpad and mouse wheel deltas into whole steps', () => {
    const w = new WheelSteps(40);
    expect(w.add(-10)).toBe(0); // a trackpad nudge: not a step yet
    expect(w.add(-30)).toBe(1); // scrolling up raises the value
    expect(w.add(-25)).toBe(0);
    expect(w.add(-25)).toBe(1); // small deltas keep adding up
    expect(w.add(100)).toBe(-1); // a mouse wheel click down: one step, however large the delta
    expect(w.add(-120)).toBe(1);
    expect(w.add(3, 1)).toBe(-1); // line mode: one step per event
  });
});
