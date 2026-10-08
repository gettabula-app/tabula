import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';

const box = (id: string, z: string, type: BaseObj['type'] = 'sticky'): BaseObj => ({ id, type, x: 0, y: 0, w: 10, h: 10, rotation: 0, z });

function board(ids: string[]) {
  const store = new Store(new Y.Doc());
  const zs = store.topZs(ids.length);
  store.transact(() => ids.forEach((id, i) => store.create(box(id, zs[i]))));
  return store;
}
const order = (s: Store) => s.ordered().map((o) => o.id);

describe('bring to front and send to back', () => {
  it('gives each selected object its own key and keeps their relative order', () => {
    const s = board(['a', 'b', 'c', 'd', 'e']);
    s.bringToFront(['b', 'd']);
    expect(order(s)).toEqual(['a', 'c', 'e', 'b', 'd']);
    const zb = s.get('b')!.z, zd = s.get('d')!.z;
    expect(zb < zd).toBe(true);
    expect(zb > s.get('e')!.z).toBe(true);
  });

  it('sends several to the back in their current order', () => {
    const s = board(['a', 'b', 'c', 'd', 'e']);
    s.sendToBack(['d', 'b']);
    expect(order(s)).toEqual(['b', 'd', 'a', 'c', 'e']);
    expect(new Set(s.ordered().map((o) => o.z)).size).toBe(5);
  });

  it('works for one object, none, and the whole board', () => {
    const s = board(['a', 'b', 'c']);
    s.bringToFront(['a']);
    expect(order(s)).toEqual(['b', 'c', 'a']);
    s.sendToBack([]);
    s.bringToFront(['nope']);
    expect(order(s)).toEqual(['b', 'c', 'a']);
    s.sendToBack(['b', 'c', 'a']);
    expect(order(s)).toEqual(['b', 'c', 'a']);
  });

  it('is one undo step', () => {
    const s = board(['a', 'b', 'c']);
    s.undo.stopCapturing();
    s.bringToFront(['a', 'b']);
    s.undo.undo();
    expect(order(s)).toEqual(['a', 'b', 'c']);
  });

  it('does nothing on a read-only board', () => {
    const s = board(['a', 'b']);
    s.setReadOnly(true);
    s.bringToFront(['a']);
    expect(order(s)).toEqual(['a', 'b']);
  });

  it('keeps frames painted first whatever their key', () => {
    const s = board(['a', 'b']);
    s.transact(() => s.create(box('f', s.topZ(), 'frame')));
    s.bringToFront(['f', 'a']);
    expect(order(s)).toEqual(['f', 'b', 'a']);
  });
});
