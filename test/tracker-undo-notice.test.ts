import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';

const card = (id: string): BaseObj => ({
  id, type: 'card', x: 0, y: 0, w: 120, h: 60, rotation: 0, z: `z-${id}`, text: id,
  parent: 'lane-old', rank: `a0@lane-old`,
});

function board() {
  const store = new Store(new Y.Doc());
  store.transact(() => {
    store.create(card('card-a'));
    store.create(card('card-b'));
  });
  store.undo.clear();
  store.undo.stopCapturing();
  return store;
}

describe('dropping corrected tracker undo items', () => {
  it('drops a corrected card move while keeping unrelated local undo items', () => {
    const store = board();
    store.transact(() => store.update('card-a', { parent: 'lane-new', rank: 'a1@lane-new' }));
    store.undo.stopCapturing();
    store.transact(() => store.update('card-b', { text: 'Another local edit' }));

    // The relay's correction is remote: the bad local parent is already gone from the live document.
    store.doc.transact(() => {
      store.objects.get('card-a')!.set('parent', 'lane-old');
      store.objects.get('card-a')!.set('rank', 'a0@lane-old');
    }, 'relay-correction');
    store.dropUndoFor(['card-a']);

    expect(store.undo.undoStack).toHaveLength(1);
    store.transact(() => store.update('card-b', { text: 'Later local edit' }));
    expect(store.undo.undoStack).toHaveLength(2);
    store.undo.undo();
    expect((store.get('card-b') as BaseObj | undefined)?.text).toBe('Another local edit');
    store.undo.undo();
    expect(store.get('card-a')?.parent).toBe('lane-old');
    expect((store.get('card-b') as BaseObj | undefined)?.text).toBe('card-b');
  });

  it('keeps a stack item that also changes a card outside the corrected set', () => {
    const store = board();
    store.transact(() => {
      store.update('card-a', { parent: 'lane-new' });
      store.update('card-b', { text: 'Together' });
    });
    expect(store.undo.undoStack).toHaveLength(1);

    store.dropUndoFor(['card-a']);
    expect(store.undo.undoStack).toHaveLength(1);
  });
});
