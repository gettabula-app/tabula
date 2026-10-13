import * as Y from 'yjs';
import { generateNKeysBetween } from 'fractional-indexing';
import { describe, expect, it } from 'vitest';
import { BoardApp } from '../src/app';
import { Store } from '../src/store';
import type { Obj } from '../src/types';

// Paste (BoardApp.insertObjects) of tables and Markdown blocks from another board: the same sanitising as a file, one undo step
const rr = generateNKeysBetween(null, null, 2);
const table = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'table', x: 5, y: 6, w: 300, h: 100, rotation: 0, z: 'a', createdBy: 'src', headerRow: true, 'r:r0': rr[0], 'r:r1': rr[1], 'k:c0': rr[0], 'c:r0:c0': 'hello', ...extra }) as unknown as Obj;
const md = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'markdown', x: 0, y: 0, w: 300, h: 100, rotation: 0, z: 'a', text: '# Notes', createdBy: 'src', ...extra }) as unknown as Obj;

function fakeApp() {
  const store = new Store(new Y.Doc());
  const notes: string[] = [];
  const app = { store, user: { id: 'me' }, notify: (m: string) => notes.push(m), announce() {}, resetScopeSelection() {} } as unknown as BoardApp;
  const insert = (objs: Obj[]) => (BoardApp.prototype.insertObjects as (this: BoardApp, o: Obj[], off: { x: number; y: number }) => Obj[]).call(app, objs, { x: 10, y: 20 });
  return { store, notes, insert };
}

describe('paste of tables and Markdown blocks', () => {
  it('writes them as the pasting user with new ids, moved, with the attribution and tracker fields of others gone', () => {
    const { store, insert } = fakeApp();
    const out = insert([
      table('t', { ownerId: 'stranger', ownerName: 'Sam', createdBy: 'stranger', 'c:__proto__:c0': 'x', 'c:r1:c0': 'two' }),
      md('m', { ownerId: 'stranger', proposedBy: { feature: 'summarise', by: { id: 'stranger', name: 'Sam' }, extra: 1 } }),
    ]);
    expect(out).toHaveLength(2);
    const [t, m] = out.map((o) => store.objects.get(o.id)!.toJSON() as Record<string, unknown>);
    expect(t.id).not.toBe('t');
    expect(t).toMatchObject({ type: 'table', x: 15, y: 26, createdBy: 'me', 'c:r0:c0': 'hello', 'c:r1:c0': 'two', 'r:r0': rr[0], 'k:c0': rr[0] });
    expect(Object.keys(t).filter((k) => /proto|owner/.test(k))).toEqual([]);
    expect(m).toMatchObject({ type: 'markdown', createdBy: 'me', text: '# Notes', proposedBy: { feature: 'summarise', by: { id: 'stranger', name: 'Sam' } } });
    expect((m.proposedBy as Record<string, unknown>).extra).toBeUndefined();
    expect(m.ownerId).toBeUndefined();
  });

  it('leaves out a table that is bigger than a table may be, and says so; the rest is pasted', () => {
    const { store, notes, insert } = fakeApp();
    const big = table('big');
    for (let i = 0; i < 101; i++) (big as unknown as Record<string, string>)[`r:x${i}`] = `a${i}`;
    const out = insert([big, md('m')]);
    expect(out).toHaveLength(1);
    expect(store.objects.size).toBe(1);
    expect(notes[0]).toMatch(/Left out a table .*103 rows/);
    expect(insert([big])).toEqual([]);
    expect(store.objects.size).toBe(1);
  });
});
