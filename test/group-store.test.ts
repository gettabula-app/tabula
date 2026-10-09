import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BaseObj, Group, ObjType } from '../src/types';

const box = (id: string, type: ObjType = 'sticky', extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type, x: 0, y: 0, w: 10, h: 10, rotation: 0, z: id, ...extra,
});

const group = (id: string, parent?: string, extra: Partial<Group> = {}): Group => ({
  id, type: 'group', x: 999, y: 999, w: 999, h: 999, rotation: 2, z: id, parent, ...extra,
});

function sync(a: Store, b: Store) {
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
}

describe('group-aware store index and geometry', () => {
  it('keeps the child index correct through local and remote parent changes', () => {
    const a = new Store(new Y.Doc()), b = new Store(new Y.Doc());
    a.transact(() => {
      a.create(group('g'));
      a.create(box('one'));
      a.create(box('two'));
    });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    a.transact(() => a.update('one', { parent: 'g' }));
    b.transact(() => b.update('two', { parent: 'g' }));
    sync(a, b);
    for (const s of [a, b]) expect(s.childrenOf('g').map((o) => o.id).sort()).toEqual(['one', 'two']);
    a.transact(() => a.update('one', { parent: undefined }));
    sync(a, b);
    expect(b.childrenOf('g').map((o) => o.id)).toEqual(['two']);
    b.transact(() => b.remove(['two']));
    sync(a, b);
    expect(a.childrenOf('g')).toEqual([]);
  });

  it('walks descendants through groups and finds the nearest frame ancestor', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(box('frame', 'frame'));
      s.create(group('outer', 'frame'));
      s.create(group('inner', 'outer'));
      s.create(box('nested', 'sticky', { parent: 'inner' }));
      s.create(box('direct', 'shape', { parent: 'frame' }));
    });
    expect(s.descendantsOf('frame').map((o) => o.id).sort()).toEqual(['direct', 'inner', 'nested', 'outer']);
    expect(s.frameOf(s.get('nested')!)?.id).toBe('frame');
    expect(s.frameOf(s.get('direct')!)?.id).toBe('frame');
  });

  it('invalidates bounds up the group chain when a member moves', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(group('outer'));
      s.create(group('inner', 'outer'));
      s.create(box('note', 'sticky', { parent: 'inner', x: 10, y: 20, w: 30, h: 40 }));
    });
    expect(s.geometry(s.get('outer')!)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    const changed = new Set<string>();
    s.onChange((ids) => ids.forEach((id) => changed.add(id)));
    s.transact(() => s.update('note', { x: 100 }));
    expect(s.geometry(s.get('outer')!)).toEqual({ x: 100, y: 20, w: 30, h: 40 });
    expect(changed).toEqual(new Set(['note', 'inner', 'outer']));
  });

  it('uses the supplied privacy predicate and removes empty groups', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(group('g'));
      s.create(box('visible', 'sticky', { parent: 'g', x: 10, y: 20, w: 30, h: 40 }));
      s.create(box('secret', 'sticky', { parent: 'g', x: 900, y: 900, w: 50, h: 50 }));
      s.create(group('empty'));
    });
    s.setGeometryVisibility((o) => o.id !== 'secret');
    expect(s.geometry(s.get('g')!)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(s.shown().map((o) => o.id)).not.toContain('empty');
    expect(s.get('empty')).toBeUndefined();
    expect(s.get('g')).toMatchObject({ x: 0, y: 0, w: 0, h: 0, rotation: 0 });
    s.transact(() => s.update('g', { x: 123, y: 456, w: 1, h: 2, rotation: 1 }));
    expect(s.get('g')).toMatchObject({ x: 0, y: 0, w: 0, h: 0, rotation: 0 });
  });
});

describe('group paint order', () => {
  it('keeps frames first, nested subtrees contiguous at the group z, and orphans at top level', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(box('frame', 'frame', { z: 'z0' }));
      s.create(group('g', undefined, { z: 'a0' }));
      s.create(box('outside', 'sticky', { z: 'a1' }));
      s.create(group('nested', 'g', { z: 'a2' }));
      s.create(box('nested-leaf', 'sticky', { parent: 'nested', z: 'a3' }));
      s.create(box('member', 'sticky', { parent: 'g', z: 'a9' }));
      s.create(box('orphan', 'sticky', { parent: 'missing', z: 'a6' }));
      s.create(group('cycle-a', 'cycle-b', { z: 'a7' }));
      s.create(group('cycle-b', 'cycle-a', { z: 'a8' }));
      s.create(box('cycle-leaf', 'sticky', { parent: 'cycle-a', z: 'a9' }));
    });
    expect(s.ordered().map((o) => o.id)).toEqual([
      'frame', 'g', 'nested', 'nested-leaf', 'member', 'outside', 'orphan', 'cycle-a', 'cycle-b', 'cycle-leaf',
    ]);
    expect(new Set(s.ordered().map((o) => o.id)).size).toBe(s.cache.size);
  });
});

describe('group Yjs concurrency', () => {
  it('merges grouping against deletion of one member after both docs sync', () => {
    const a = new Store(new Y.Doc()), b = new Store(new Y.Doc());
    a.transact(() => { a.create(box('one')); a.create(box('two')); });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    a.transact(() => {
      a.create(group('g'));
      a.update('one', { parent: 'g' });
      a.update('two', { parent: 'g' });
    });
    b.transact(() => b.remove(['two']));
    sync(a, b);
    for (const s of [a, b]) {
      expect(s.get('two')).toBeUndefined();
      expect(s.childrenOf('g').map((o) => o.id)).toEqual(['one']);
      expect(s.geometry(s.get('g')!)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    }
  });

  it('reads a member as top-level after a group is deleted', () => {
    const a = new Store(new Y.Doc()), b = new Store(new Y.Doc());
    a.transact(() => {
      a.create(group('g'));
      a.create(box('member', 'sticky', { parent: 'g', x: 40, y: 50 }));
    });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    a.transact(() => a.remove(['g']));
    b.transact(() => b.update('member', { text: 'still here' }));
    sync(a, b);
    for (const s of [a, b]) {
      expect(s.get('g')).toBeUndefined();
      expect(s.get('member')).toMatchObject({ parent: 'g', x: 40, y: 50 });
      expect(s.ordered().map((o) => o.id)).toContain('member');
      expect(s.frameOf(s.get('member')!)).toBeUndefined();
      expect(s.descendantsOf('g')).toEqual([]);
    }
  });
});
