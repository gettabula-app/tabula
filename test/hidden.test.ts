import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { Flow } from '../src/flow';
import type { BaseObj, ConnectorObj, Obj } from '../src/types';
import { hiddenOf, readAll, summarise } from '../server/board-ops.mjs';
import { readForAi } from '../server/ai/board.mjs';
import { layoutAll, ranksBetween } from '../shared/containers';
import { layerTree } from '../src/layers';

// TAB-198: `hidden: true` hides an object from everyone. It is not drawn, hit, selected, snapped to or exported as a
// picture; a connector with a hidden end goes with it, and so does everything inside a hidden frame. JSON keeps it, MCP
// marks it, the AI read and the Markdown summary leave it out. Undo treats it like any field.

const box = (id: string, extra: Partial<BaseObj> = {}): BaseObj => ({ id, type: 'sticky', x: 0, y: 0, w: 100, h: 100, rotation: 0, z: `a${id}`, text: `note ${id}`, ...extra });
const frame = (id: string, extra: Partial<BaseObj> = {}): BaseObj => ({ id, type: 'frame', x: -50, y: -50, w: 400, h: 400, rotation: 0, z: 'a0', name: `Frame ${id}`, ...extra });
const link = (id: string, from: string, to: string, extra: Partial<ConnectorObj> = {}): ConnectorObj => ({
  id, type: 'connector', z: `b${id}`, from: { kind: 'bound', id: from, anchor: 'auto' }, to: { kind: 'bound', id: to, anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow', ...extra,
});

function board(objs: Obj[]) {
  const store = new Store(new Y.Doc());
  store.transact(() => objs.forEach((o) => store.create(o)));
  return store;
}
const shownIds = (s: Store) => s.shown().map((o) => o.id).sort();

describe('Store.shown', () => {
  it('leaves out hidden objects, what is inside a hidden frame, and connectors with a hidden end', () => {
    const s = board([frame('f'), box('in', { parent: 'f' }), box('a'), box('b', { hidden: true }), link('ab', 'a', 'b'), link('a-in', 'a', 'in'), link('free', 'a', 'a', { hidden: true })]);
    expect(shownIds(s)).toEqual(['a', 'a-in', 'f', 'in']);
    s.transact(() => s.update('f', { hidden: true }));
    expect(shownIds(s)).toEqual(['a']);
  });

  it('follows changes, and undo brings an object back', () => {
    const s = board([box('a'), box('b')]);
    s.undo.stopCapturing();
    s.transact(() => s.update('a', { hidden: true }));
    expect(shownIds(s)).toEqual(['b']);
    s.undo.undo();
    expect(shownIds(s)).toEqual(['a', 'b']);
  });

  it('survives a parent cycle', () => {
    const s = board([box('x', { parent: 'y' }), box('y', { parent: 'x' })]);
    expect(shownIds(s)).toEqual(['x', 'y']);
  });
});

describe('the Markdown summary', () => {
  it('leaves out hidden notes and hidden frames', () => {
    const s = board([frame('f'), box('keep', { parent: 'f' }), box('gone', { parent: 'f', hidden: true }), frame('g', { hidden: true, z: 'a1' }), box('inside', { parent: 'g' })]);
    const app = { store: s, user: { id: 'me', name: 'me', color: '#000' }, r: { invalidateAll() {}, setOverlay() {} }, emit() {}, participants: () => [] };
    const md = new Flow(app as never).summaryMarkdown();
    expect(md).toContain('note keep');
    expect(md).not.toContain('note gone');
    expect(md).not.toContain('Frame g');
    expect(md).not.toContain('note inside');
  });
});

describe('the server', () => {
  const doc = (objs: Obj[]) => {
    const d = new Y.Doc();
    const map = d.getMap('objects');
    d.transact(() => objs.forEach((o) => map.set(o.id, new Y.Map(Object.entries(o)))));
    return d;
  };

  it('hiddenOf finds hidden boxes, their children and the connectors bound to them', () => {
    const d = doc([frame('f', { hidden: true }), box('in', { parent: 'f' }), box('a'), box('b'), link('to-in', 'a', 'in'), link('ab', 'a', 'b'), link('self', 'a', 'b', { hidden: true })]);
    expect([...hiddenOf(readAll(d))].sort()).toEqual(['f', 'in', 'self', 'to-in']);
  });

  it('MCP marks a hidden object, and the AI read leaves it out', () => {
    const d = doc([box('a'), box('b', { hidden: true, text: 'CANARY hidden' })]);
    expect(summarise({ ...box('b', { hidden: true }) }, 100)).toMatchObject({ hidden: true });
    expect(summarise({ ...box('a') }, 100)).not.toHaveProperty('hidden');
    const read = readForAi(d) as { items: unknown[] };
    expect(JSON.stringify(read)).not.toContain('CANARY');
    expect(read.items).toHaveLength(1);
  });
});

describe('kanban (TAB-134) and the layers tree', () => {
  /** A kanban board with two lanes, written through the Store as the app does. */
  function kanbanStore() {
    const s = new Store(new Y.Doc());
    const lanes = ranksBetween(null, null, 2, 'k');
    const todo = ranksBetween(null, null, 3, 'k-todo');
    s.transact(() => {
      s.create(box('k', { type: 'container', layout: 'kanban', name: 'Sprint', x: 0, y: 0, w: 1, h: 1, z: 'a0' } as Partial<BaseObj>));
      s.create(box('k-todo', { type: 'lane', parent: 'k', rank: lanes[0], name: 'To do', z: 'a0' } as Partial<BaseObj>));
      s.create(box('k-done', { type: 'lane', parent: 'k', rank: lanes[1], name: 'Done', z: 'a0' } as Partial<BaseObj>));
      ['t1', 't2', 't3'].forEach((id, i) => s.create(box(id, { type: 'card', parent: 'k-todo', rank: todo[i], text: id, z: 'a0' } as Partial<BaseObj>)));
    });
    return s;
  }
  const tree = (s: Store) =>
    layerTree([...s.cache.values()], { visible: () => true, isLaidOut: (o) => s.isLaidOut(o), layoutOrder: (id) => s.containerLayout(id)?.order ?? [] });

  it('lists lanes under their board and cards under their lane, in layout order, not movable', () => {
    const nodes = tree(kanbanStore());
    expect(nodes.map((n) => [n.id, n.depth])).toEqual([['k', 0], ['k-todo', 1], ['t1', 2], ['t2', 2], ['t3', 2], ['k-done', 1]]);
    expect(nodes.filter((n) => n.depth > 0).every((n) => !n.movable)).toBe(true);
  });

  it('a hidden card leaves the layout, so the lane closes up, and showing it puts it back', () => {
    const s = kanbanStore();
    const yOf = (id: string) => s.containerLayout('k')!.rects.get(id)?.y;
    const before = { t2: yOf('t2'), t3: yOf('t3') };
    s.transact(() => s.update('t2', { hidden: true }));
    expect(yOf('t2')).toBeUndefined();
    expect(yOf('t3')).toBe(before.t2);
    expect(s.shown().map((o) => o.id)).not.toContain('t2');
    expect(tree(s).find((n) => n.id === 't2')).toMatchObject({ hidden: true });
    s.transact(() => s.update('t2', { hidden: undefined }));
    expect([yOf('t2'), yOf('t3')]).toEqual([before.t2, before.t3]);
  });

  it('the server lays a board out the same way', () => {
    const s = kanbanStore();
    s.transact(() => s.update('t1', { hidden: true }));
    const { rects } = layoutAll([...s.cache.values()]);
    expect(rects.has('t1')).toBe(false);
    expect(rects.get('t2')!.y).toBe(s.containerLayout('k')!.rects.get('t2')!.y);
  });
});
