import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';

const box = (id: string, x = 0): BaseObj => ({
  id, type: 'shape', kind: 'rect', x, y: 0, w: 100, h: 60, rotation: 0, z: 'a0',
});

describe('read-only store', () => {
  it('does not run transact callbacks or create objects while read-only', () => {
    const s = new Store(new Y.Doc());
    s.setReadOnly(true);
    let ran = false;
    s.transact(() => {
      ran = true;
      s.create(box('a'));
    });
    expect(ran).toBe(false);
    expect(s.objects.size).toBe(0);
    expect(s.cache.size).toBe(0);
  });

  it('does not run transactAs callbacks while read-only', () => {
    const s = new Store(new Y.Doc());
    s.setReadOnly(true);
    let ran = false;
    s.transactAs(() => {
      ran = true;
      s.votes.set('v1', { itemId: 'a', userId: 'u', stepId: 's' });
    }, 'votes');
    expect(ran).toBe(false);
    expect(s.votes.size).toBe(0);
  });

  it('blocks flow and meta writes while read-only', () => {
    const s = new Store(new Y.Doc());
    const metaName = s.getMeta().name;
    s.setReadOnly(true);
    s.setFlow({ active: 2 });
    s.setMeta({ name: 'Changed' });
    expect(s.getFlow().active).toBe(-1);
    expect(s.getMeta().name).toBe(metaName);
  });

  it('lets writes through again after read-only is turned off', () => {
    const s = new Store(new Y.Doc());
    s.setReadOnly(true);
    s.setReadOnly(false);
    s.transact(() => s.create(box('a')));
    expect(s.get('a')?.id).toBe('a');
  });

  it('still applies remote updates while read-only', () => {
    const viewerDoc = new Y.Doc();
    const editorDoc = new Y.Doc();
    const viewer = new Store(viewerDoc);
    const editor = new Store(editorDoc);
    viewer.setReadOnly(true);
    editor.transact(() => editor.create(box('a')));
    Y.applyUpdate(viewerDoc, Y.encodeStateAsUpdate(editorDoc));
    expect(viewer.get('a')?.id).toBe('a');
    editor.transact(() => editor.update('a', { x: 240 }));
    Y.applyUpdate(viewerDoc, Y.encodeStateAsUpdate(editorDoc, Y.encodeStateVector(viewerDoc)));
    expect(viewer.get('a')?.x).toBe(240);
  });

  it('notifies read-only listeners on change and stops after unsubscribe', () => {
    const s = new Store(new Y.Doc());
    const seen: boolean[] = [];
    const off = s.onReadOnly((v) => seen.push(v));
    s.setReadOnly(true);
    s.setReadOnly(true);
    s.setReadOnly(false);
    off();
    s.setReadOnly(true);
    expect(seen).toEqual([true, false]);
    expect(s.readOnly).toBe(true);
  });
});
