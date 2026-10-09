import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { safeObj } from '../src/safe-obj';
import type { BaseObj } from '../src/types';

// `hidden` (TAB-198) and `locked` are true, false or absent. Everything reads them as `=== true`; a stored string or
// number is neither written by the store nor passed on by safeObj, so no reader can take it for a truthy flag.
const sticky = (extra: Record<string, unknown> = {}): BaseObj => ({ id: 's1', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: 'a0', ...extra } as BaseObj);
const NOT_BOOLEAN = ['true', 'false', 1, 0, 'yes', {}, [], null];

describe('boolean flags on objects', () => {
  it.each(NOT_BOOLEAN)('create leaves out hidden and locked of %j', (bad) => {
    const store = new Store(new Y.Doc());
    store.create(sticky({ hidden: bad, locked: bad }));
    const m = store.objects.get('s1')!;
    expect(m.has('hidden')).toBe(false);
    expect(m.has('locked')).toBe(false);
    expect(store.isShown(store.get('s1')!)).toBe(true);
  });

  it.each(NOT_BOOLEAN)('update ignores hidden and locked of %j and keeps what the object has', (bad) => {
    const store = new Store(new Y.Doc());
    store.create(sticky({ hidden: true, locked: false }));
    store.update('s1', { hidden: bad, locked: bad });
    const m = store.objects.get('s1')!;
    expect(m.get('hidden')).toBe(true);
    expect(m.get('locked')).toBe(false);
  });

  it('stores true and false, and undefined still clears', () => {
    const store = new Store(new Y.Doc());
    store.create(sticky({ hidden: true }));
    expect(store.objects.get('s1')!.get('hidden')).toBe(true);
    store.update('s1', { hidden: false });
    expect(store.objects.get('s1')!.get('hidden')).toBe(false);
    store.update('s1', { hidden: undefined });
    expect(store.objects.get('s1')!.has('hidden')).toBe(false);
  });

  it.each(NOT_BOOLEAN)('safeObj drops a hidden of %j and keeps a real one', (bad) => {
    expect('hidden' in safeObj(sticky({ hidden: bad }))).toBe(false);
    expect(safeObj(sticky({ hidden: true })).hidden).toBe(true);
  });
});
