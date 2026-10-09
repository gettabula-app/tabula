import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BaseObj, Id, Obj } from '../src/types';

const note = (id: Id, z: string, parent?: Id): BaseObj => ({
  id, type: 'sticky', x: 10, y: 20, w: 30, h: 30, rotation: 0, z, text: id, fill: '#FFF3A3', parent,
});

const group = (id: Id, z: string, parent?: Id): Obj => ({
  id, type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z, parent,
});

describe('empty-group scan performance', () => {
  it('skips scans during 100 move-only transactions on 10,000 objects and scans on reparent', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(group('left', 'a0'));
      store.create(group('right', 'a1'));
      for (let i = 0; i < 9_998; i++) {
        const parent = i < 2 ? 'left' : i === 2 ? 'right' : undefined;
        store.create(note(`note-${i}`, `a${i + 2}`, parent));
      }
    });
    expect(store.cache.size).toBe(10_000);

    const internals = store as unknown as { emptyGroupIds: () => Id[] };
    const scan = vi.spyOn(internals, 'emptyGroupIds');
    for (let i = 0; i < 100; i++) {
      store.transact(() => store.update(`note-${i + 100}`, { x: i + 11, y: i + 21 }));
    }
    expect(scan).not.toHaveBeenCalled();

    store.transact(() => store.update('note-0', { parent: 'right' }));
    expect(scan).toHaveBeenCalledTimes(1);
    expect(store.get('left')).toBeDefined();
    expect(store.get('right')).toBeDefined();
  });

  it('removes empty nested groups and their now-empty ancestors when they are created together', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(group('outer', 'a0'));
      store.create(group('inner', 'a1', 'outer'));
    });

    expect(store.get('inner')).toBeUndefined();
    expect(store.get('outer')).toBeUndefined();
  });

  it('still checks newly created groups in a local transaction that also reparents an object', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(group('source', 'a0'));
      store.create(group('destination', 'a1'));
      store.create(note('member', 'a2', 'source'));
      store.create(note('destination-member', 'a3', 'destination'));
    });

    store.transact(() => {
      store.update('member', { parent: 'destination' });
      store.create(group('new-empty', 'a4'));
    });

    expect(store.get('source')).toBeUndefined();
    expect(store.get('destination')).toBeDefined();
    expect(store.get('new-empty')).toBeUndefined();
  });

  it('scans remote reparent transactions and removes the group emptied by the merge', () => {
    const sender = new Store(new Y.Doc());
    sender.transact(() => {
      sender.create(group('group', 'a0'));
      sender.create(note('member', 'a1', 'group'));
    });
    const receiver = new Store(new Y.Doc());
    Y.applyUpdate(receiver.doc, Y.encodeStateAsUpdate(sender.doc));

    const internals = receiver as unknown as { emptyGroupIds: () => Id[] };
    const scan = vi.spyOn(internals, 'emptyGroupIds');
    sender.transact(() => sender.update('member', { parent: undefined }));
    const update = Y.encodeStateAsUpdate(sender.doc, Y.encodeStateVector(receiver.doc));
    Y.applyUpdate(receiver.doc, update);

    expect(scan).toHaveBeenCalledTimes(1);
    expect(receiver.get('group')).toBeUndefined();
    expect(receiver.get('member')?.parent).toBeUndefined();
  });
});
