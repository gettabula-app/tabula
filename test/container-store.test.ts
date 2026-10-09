import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { KANBAN, isMixedRank, layoutAll, needsNormalising, planInsert, ranksBetween } from '../shared/containers';
import { connectorGeom, hitBox, objBounds } from '../src/geometry';
import { applyRestore, planRestore } from '../src/history';
import { toMermaid } from '../src/mermaid';
import { Store } from '../src/store';
import type { BaseObj, ConnectorObj, Id, Label, ObjType } from '../src/types';
import { readAll } from '../server/board-ops.mjs';

// docs/kanban.md, slice 1: the Store side of containers. The child index, derived geometry, paint order, the labels
// map, the feature flag, and the concurrent cases from "Concurrent edits" run on two real documents.

const box = (id: Id, type: ObjType, extra: Partial<BaseObj> = {}): BaseObj => ({ id, type, x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a0', ...extra });

interface Spec { id?: Id; x?: number; y?: number; z?: string; lanes: Record<string, string[]> }

/** A kanban container with lanes and cards. The stored x, y, w and h of lanes and cards are junk on purpose: nothing reads them. */
function addKanban(store: Store, spec: Spec) {
  const id = spec.id ?? 'c';
  const lanes = Object.keys(spec.lanes);
  const laneKeys = ranksBetween(null, null, lanes.length, id);
  store.transact(() => {
    store.create(box(id, 'container', { x: spec.x ?? 0, y: spec.y ?? 0, z: spec.z ?? 'a0', layout: 'kanban', name: id, w: 1, h: 1 }));
    lanes.forEach((name, i) => {
      const laneId = `${id}-${name}`;
      store.create(box(laneId, 'lane', { parent: id, rank: laneKeys[i], name, x: 777, y: 777, w: 3, h: 3 }));
      const ranks = ranksBetween(null, null, spec.lanes[name].length, laneId);
      spec.lanes[name].forEach((cardId, j) => {
        store.create(box(cardId, 'card', { parent: laneId, rank: ranks[j], text: cardId, x: 555, y: 555, w: 2, h: 72 }));
      });
    });
  });
  return lanes.map((name) => `${id}-${name}`);
}

const kanban = () => ({ lanes: { todo: ['t1', 't2', 't3'], doing: ['d1'], done: [] as string[] } });

/** Moves one card to `index` in a lane the way a drop will: the shared plan, written in one transaction. */
function moveCard(store: Store, cardId: Id, laneId: Id, index: number) {
  const layout = store.containerLayout(store.get(laneId)!.parent!)!;
  const here = (layout.cards.get(laneId) ?? []).filter((id) => id !== cardId).map((id) => store.get(id)!);
  const { ranks, repairs } = planInsert(here, laneId, index, 1);
  store.transact(() => {
    for (const r of repairs) store.update(r.id, { parent: r.parent, rank: r.rank });
    store.update(cardId, { parent: laneId, rank: ranks[0] });
  });
}

const laneOrder = (store: Store, containerId: Id) => store.containerLayout(containerId)!.lanes;
const cardOrder = (store: Store, laneId: Id) => store.containerLayout(store.get(laneId)!.parent!)!.cards.get(laneId)!;
const bo = (store: Store, id: Id) => store.get(id) as BaseObj;
const placedOf = (store: Store, id: Id) => store.placed(store.get(id)!) as BaseObj;
const sortKeys = (_key: string, v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v;
/** Every object as it is drawn, with keys in a fixed order, so two documents can be compared as text. */
const state = (store: Store) => JSON.stringify([...store.cache.values()].map((o) => store.placed(o)).sort((a, b) => (a.id < b.id ? -1 : 1)), sortKeys);

describe('the child index', () => {
  it('answers childrenOf from the parent field, and follows changes', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(box('f', 'frame'));
      s.create(box('a', 'sticky', { parent: 'f' }));
      s.create(box('b', 'sticky', { parent: 'f' }));
      s.create(box('c', 'sticky'));
    });
    expect(s.childrenOf('f').map((o) => o.id).sort()).toEqual(['a', 'b']);
    expect(s.childrenOf('c')).toEqual([]);
    s.transact(() => {
      s.update('c', { parent: 'f' });
      s.update('a', { parent: undefined });
    });
    expect(s.childrenOf('f').map((o) => o.id).sort()).toEqual(['b', 'c']);
    s.transact(() => s.remove(['b']));
    expect(s.childrenOf('f').map((o) => o.id)).toEqual(['c']);
  });

  it('is built from a document that already has objects, and from remote changes', () => {
    const a = new Store(new Y.Doc());
    addKanban(a, kanban());
    const b = new Store(new Y.Doc());
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.childrenOf('c').map((o) => o.id).sort()).toEqual(['c-doing', 'c-done', 'c-todo']);
    expect(b.childrenOf('c-todo').map((o) => o.id).sort()).toEqual(['t1', 't2', 't3']);
    a.transact(() => a.update('t1', { parent: 'c-done' }));
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    expect(b.childrenOf('c-todo').map((o) => o.id).sort()).toEqual(['t2', 't3']);
    expect(b.childrenOf('c-done').map((o) => o.id)).toEqual(['t1']);
  });
});

describe('derived geometry', () => {
  it('lays a container out from its lanes and cards and ignores the stored rectangles of what is inside', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, { ...kanban(), x: 100, y: 200 });
    const L = s.containerLayout('c')!;
    expect(L.lanes).toEqual(['c-todo', 'c-doing', 'c-done']);
    expect(s.geometry(s.get('c')!)).toEqual({ x: 100, y: 200, w: L.w, h: L.h });
    expect(s.geometry(s.get('c-doing')!)).toEqual(L.rects.get('c-doing'));
    expect(s.geometry(s.get('t2')!)).toEqual(L.rects.get('t2'));
    expect(s.geometry(s.get('t2')!).y).toBe(s.geometry(s.get('t1')!).y + 72 + KANBAN.cardGap);
    expect(s.isLaidOut(s.get('t2')!)).toBe(true);
    expect(s.isLaidOut(s.get('c')!)).toBe(false);
  });

  it('is the stored rectangle for everything else', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(box('st', 'sticky', { x: 5, y: 6, w: 7, h: 8 }));
      s.create(box('loose', 'card', { x: 50, y: 60, w: 192, h: 40 }));
      s.create(box('l', 'lane', { x: 1, y: 2, w: 3, h: 4, parent: 'nowhere' }));
      s.create(box('u', 'container', { x: 9, y: 9, w: 120, h: 80, layout: 'timeline' }));
    });
    expect(s.geometry(s.get('st')!)).toEqual({ x: 5, y: 6, w: 7, h: 8 });
    expect(s.geometry(s.get('loose')!)).toEqual({ x: 50, y: 60, w: 192, h: 40 });
    expect(s.geometry(s.get('l')!)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(s.geometry(s.get('u')!)).toEqual({ x: 9, y: 9, w: 120, h: 80 });
    for (const id of ['st', 'loose', 'l', 'u']) {
      expect(s.placed(s.get(id)!)).toBe(s.get(id));
      expect(s.isLaidOut(s.get(id)!)).toBe(false);
    }
    expect(s.containerLayout('u')).toBeNull();
  });

  it('moves the hit box of a card when its container moves, with one write', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, { ...kanban(), x: 0, y: 0 });
    const before = s.geometry(s.get('t1')!);
    const inside = { x: before.x + 10, y: before.y + 10 };
    expect(hitBox(placedOf(s, 't1'), inside, 0)).toBe(true);
    const updated = s.get('t1')!.updatedAt;
    s.transact(() => s.update('c', { x: 1000, y: 500 }));
    expect(hitBox(placedOf(s, 't1'), inside, 0)).toBe(false);
    expect(hitBox(placedOf(s, 't1'), { x: inside.x + 1000, y: inside.y + 500 }, 0)).toBe(true);
    expect(s.geometry(s.get('t1')!)).toEqual({ ...before, x: before.x + 1000, y: before.y + 500 });
    expect(s.get('t1')!.updatedAt).toBe(updated);
    expect(bo(s, 't1').x).toBe(555);
  });

  it('gives the container its derived size and a placed copy with no rotation', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    const placed = s.placed(s.get('c')!);
    expect(placed).not.toBe(s.get('c'));
    const layout = s.containerLayout('c')!;
    expect(placed).toMatchObject({ x: 0, y: 0, w: layout.w, h: layout.h, rotation: 0, id: 'c' });
    expect(s.placed(s.get('c')!)).toBe(placed);
    expect(s.placed(placed)).toBe(placed);
    expect(objBounds((id) => s.getPlaced(id), placed)).toEqual({ x: 0, y: 0, w: layout.w, h: layout.h });
    s.transact(() => s.update('c', { laneW: 400 }));
    expect(s.placed(s.get('c')!)).not.toBe(placed);
    expect(placedOf(s, 'c').w).toBeGreaterThan((placed as BaseObj).w);
  });

  it('grows the lanes as cards are added and closes up as they go', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    const h0 = s.geometry(s.get('c')!).h;
    s.transact(() => {
      for (let i = 0; i < 10; i++) s.create(box(`n${i}`, 'card', { parent: 'c-todo', rank: `a${i + 5}@c-todo`, h: 100 }));
    });
    expect(s.geometry(s.get('c')!).h).toBeGreaterThan(h0);
    expect(s.geometry(s.get('c-done')!).h).toBe(s.geometry(s.get('c-todo')!).h);
    s.transact(() => s.remove(Array.from({ length: 10 }, (_, i) => `n${i}`)));
    expect(s.geometry(s.get('c')!).h).toBe(h0);
  });

  it('keeps a connector on a card when the card moves to another lane or the container moves', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    const conn: ConnectorObj = {
      id: 'k', type: 'connector', z: 'a1', route: 'straight', startHead: 'none', endHead: 'arrow',
      from: { kind: 'bound', id: 't1', anchor: 'right' }, to: { kind: 'free', x: 5000, y: 5000 },
    };
    s.transact(() => s.create(conn));
    const start = () => connectorGeom((id) => s.getPlaced(id), s.get('k') as ConnectorObj)!.start;
    const t1 = () => s.geometry(s.get('t1')!);
    expect(start()).toEqual({ x: t1().x + t1().w, y: t1().y + t1().h / 2 });
    moveCard(s, 't1', 'c-doing', 0);
    expect(start()).toEqual({ x: t1().x + t1().w, y: t1().y + t1().h / 2 });
    expect(t1().x).toBe(s.geometry(s.get('c-doing')!).x + KANBAN.lanePad);
    const before = start();
    s.transact(() => s.update('c', { x: -300 }));
    expect(start()).toEqual({ x: t1().x + t1().w, y: t1().y + t1().h / 2 });
    expect(start().x).toBe(before.x - 300);
  });

  it('matches the layout the server computes from the same objects', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, { ...kanban(), x: 40, y: 80 });
    addKanban(s, { id: 'd', x: 900, y: 0, z: 'a1', lanes: { one: ['e1', 'e2'], two: ['e3'] } });
    s.transact(() => {
      s.create(box('orphan', 'card', { parent: 'gone', rank: 'a0@gone', h: 50 }));
      s.create(box('bad', 'card', { parent: 'd-one', rank: 'a0@elsewhere', h: 33, updatedAt: 4 }));
      s.create(box('plain', 'sticky', { x: 1, y: 2, w: 3, h: 4 }));
    });
    const { rects } = layoutAll([...s.cache.values()]);
    expect(rects.size).toBe(8 + 6 + 2);
    for (const [id, rect] of rects) expect(s.geometry(s.get(id)!)).toEqual(rect);
    expect(cardOrder(s, 'c-todo')).toEqual(['t1', 't2', 't3', 'orphan']);
    expect(cardOrder(s, 'd-one')).toEqual(['e1', 'e2', 'bad']);
  });

  it('is what the MCP reader reports for positions', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, { ...kanban(), x: 40, y: 80 });
    s.transact(() => s.create(box('plain', 'sticky', { x: 1, y: 2, w: 3, h: 4 })));
    const { boxes } = readAll(s.doc);
    const byId = new Map<string, { x: number; y: number; w: number; h: number }>(boxes.map((o: { id: string; x: number; y: number; w: number; h: number }) => [o.id, o]));
    for (const id of ['c', 'c-todo', 'c-done', 't1', 'd1']) expect(byId.get(id)).toMatchObject(s.geometry(s.get(id)!));
    expect(byId.get('plain')).toMatchObject({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe('paint order', () => {
  it('paints a container as a unit at its own z: container, lanes by rank, then each lane\'s cards', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(box('under', 'sticky', { z: 'a0' }));
      s.create(box('over', 'sticky', { z: 'a2' }));
      s.create(box('fr', 'frame', { z: 'a5' }));
    });
    addKanban(s, { ...kanban(), z: 'a1' });
    // the children's own z (here higher than everything) is not read
    s.transact(() => {
      s.update('t1', { z: 'zz' });
      s.update('c-done', { z: 'zy' });
    });
    expect(s.ordered().map((o) => o.id)).toEqual([
      'fr', 'under', 'c', 'c-todo', 'c-doing', 'c-done', 't1', 't2', 't3', 'd1', 'over',
    ]);
  });

  it('follows the ranks when lanes and cards are reordered, and the container when it is raised', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => s.create(box('over', 'sticky', { z: 'a2' })));
    addKanban(s, { ...kanban(), z: 'a1' });
    moveCard(s, 't3', 'c-todo', 0);
    expect(s.ordered().map((o) => o.id).slice(-5)).toEqual(['t3', 't1', 't2', 'd1', 'over']);
    s.bringToFront(['c']);
    const order = s.ordered().map((o) => o.id);
    expect(order[0]).toBe('over');
    expect(order.slice(1)).toEqual(['c', 'c-todo', 'c-doing', 'c-done', 't3', 't1', 't2', 'd1']);
  });

  it('leaves what a container lays out alone when it is sent to the back or brought to the front', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    const z = s.get('t1')!.z;
    s.bringToFront(['t1', 'c-doing']);
    s.sendToBack(['t2']);
    expect(s.get('t1')!.z).toBe(z);
    expect(s.get('c-doing')!.z).toBe(z);
    expect(s.get('t2')!.z).toBe(z);
  });

  it('paints a loose card, a lane without a container and an unknown layout as ordinary boxes', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(box('loose', 'card', { z: 'a1' }));
      s.create(box('lonely', 'lane', { z: 'a0', parent: 'gone' }));
      s.create(box('odd', 'container', { z: 'a2', layout: 'timeline' }));
      s.create(box('inodd', 'lane', { z: 'a3', parent: 'odd', rank: 'a0@odd' }));
    });
    expect(s.ordered().map((o) => o.id)).toEqual(['lonely', 'loose', 'odd', 'inodd']);
  });

  it('keeps every object once', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, { ...kanban(), z: 'a1' });
    addKanban(s, { id: 'd', z: 'a0', lanes: { a: ['x1'] } });
    s.transact(() => s.create(box('orphan', 'card', { parent: 'gone', rank: 'a0@gone' })));
    const order = s.ordered().map((o) => o.id);
    expect(order).toHaveLength(s.cache.size);
    expect(new Set(order).size).toBe(order.length);
  });
});

describe('cards whose lane is gone', () => {
  it('shows them at the end of the first lane of the container lowest in paint order', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, { ...kanban(), z: 'a1' });
    addKanban(s, { id: 'd', z: 'a0', lanes: { first: ['f1'], second: [] } });
    s.transact(() => {
      s.create(box('o2', 'card', { parent: 'gone', rank: 'a1@gone' }));
      s.create(box('o1', 'card', { parent: 'gone', rank: 'a0@gone' }));
    });
    expect(cardOrder(s, 'd-first')).toEqual(['f1', 'o1', 'o2']);
    expect(cardOrder(s, 'c-todo')).toEqual(['t1', 't2', 't3']);
    expect(s.isLaidOut(s.get('o1')!)).toBe(true);
    expect(s.geometry(s.get('o2')!)).toEqual(s.containerLayout('d')!.rects.get('o2'));
  });

  it('moves them to the next container when the home container goes, and back with undo of nothing lost', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, { ...kanban(), z: 'a1' });
    addKanban(s, { id: 'd', z: 'a0', lanes: { first: [] } });
    s.transact(() => s.create(box('o', 'card', { parent: 'gone', rank: 'a0@gone' })));
    expect(cardOrder(s, 'd-first')).toEqual(['o']);
    s.transact(() => s.remove(['d', 'd-first']));
    expect(cardOrder(s, 'c-todo')).toEqual(['t1', 't2', 't3', 'o']);
  });

  it('are loose, at their stored place, when no container can take them', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => s.create(box('o', 'card', { parent: 'gone', rank: 'a0@gone', x: 12, y: 13, w: 192, h: 40 })));
    expect(s.isLaidOut(s.get('o')!)).toBe(false);
    expect(s.geometry(s.get('o')!)).toEqual({ x: 12, y: 13, w: 192, h: 40 });
  });

  it('are shown right away when their lane is deleted, and adopted when a write repairs them', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    s.transact(() => s.remove(['c-doing']));
    expect(cardOrder(s, 'c-todo')).toEqual(['t1', 't2', 't3', 'd1']);
    moveCard(s, 't1', 'c-todo', 1);
    expect(cardOrder(s, 'c-todo')).toEqual(['t2', 't1', 't3', 'd1']);
    expect(s.get('d1')!.parent).toBe('c-todo');
    expect(isMixedRank(bo(s, 'd1'))).toBe(false);
  });
});

describe('what changes when something inside a container does', () => {
  it('rebuilds only that container\'s layout', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    addKanban(s, { id: 'd', x: 2000, z: 'a1', lanes: { one: ['e1'], two: [] } });
    s.transact(() => s.create(box('st', 'sticky')));
    const c = s.containerLayout('c');
    const d = s.containerLayout('d');
    expect(s.containerLayout('c')).toBe(c);
    s.transact(() => s.update('st', { x: 3 }));
    expect(s.containerLayout('c')).toBe(c);
    expect(s.containerLayout('d')).toBe(d);
    moveCard(s, 't1', 'c-doing', 0);
    expect(s.containerLayout('c')).not.toBe(c);
    expect(s.containerLayout('d')).toBe(d);
    const c2 = s.containerLayout('c');
    s.transact(() => s.update('e1', { text: 'edited' }));
    expect(s.containerLayout('c')).toBe(c2);
    expect(s.containerLayout('d')).not.toBe(d);
  });

  it('rebuilds both containers when a card moves from one to the other', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    addKanban(s, { id: 'd', x: 2000, z: 'a1', lanes: { one: ['e1'] } });
    moveCard(s, 'e1', 'c-doing', 0);
    expect(cardOrder(s, 'c-doing')).toEqual(['e1', 'd1']);
    expect(cardOrder(s, 'd-one')).toEqual([]);
  });

  it('tells listeners about everything that moved because its container did', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    s.transact(() => s.create(box('st', 'sticky')));
    const seen: Set<Id>[] = [];
    s.onChange((changed) => seen.push(changed));
    s.transact(() => s.update('c', { x: 40 }));
    expect([...seen[0]].sort()).toEqual(['c', 'c-doing', 'c-done', 'c-todo', 'd1', 't1', 't2', 't3'].sort());
    s.transact(() => s.update('st', { x: 40 }));
    expect([...seen[1]]).toEqual(['st']);
    moveCard(s, 't1', 'c-done', 0);
    // the todo lane is no longer the tallest, so the container and every lane shrink; d1 keeps its rectangle
    expect([...seen[2]].sort()).toEqual(['c', 'c-doing', 'c-done', 'c-todo', 't1', 't2', 't3']);
  });

  it('does not report the neighbours of a card whose text changed but whose place did not', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    const seen: Set<Id>[] = [];
    s.onChange((changed) => seen.push(changed));
    s.transact(() => s.update('t2', { text: 'edited' }));
    expect([...seen[0]]).toEqual(['t2']);
    s.transact(() => s.update('t2', { h: 120 }));
    expect([...seen[1]].sort()).toEqual(['c', 'c-doing', 'c-done', 'c-todo', 't2', 't3']);
  });

  it('answers a card with a hit box that follows the layout after any change', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    const place = () => s.geometry(s.get('t3')!);
    const at = place();
    const step = 72 + KANBAN.cardGap;
    moveCard(s, 't3', 'c-todo', 0);
    expect(place().y).toBe(at.y - 2 * step);
    const second = () => s.geometry(s.get('t2')!).y;
    expect(second()).toBe(at.y - 2 * step + 2 * step);
    s.transact(() => s.update('t1', { h: 200 }));
    expect(second()).toBe(at.y - 2 * step + step + 200 + KANBAN.cardGap);
  });

  it('stays quick with 2,000 cards on the board', () => {
    const s = new Store(new Y.Doc());
    const cards = (prefix: string) => Array.from({ length: 500 }, (_, i) => `${prefix}${i}`);
    const t0 = performance.now();
    addKanban(s, { lanes: { a: cards('a'), b: cards('b'), c: cards('c'), d: cards('d') } });
    const built = performance.now() - t0;
    expect(s.cache.size).toBe(2000 + 4 + 1);
    expect(s.containerLayout('c')!.rects.size).toBe(2005);
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) moveCard(s, `a${i}`, 'c-b', 3);
    const moves = (performance.now() - t1) / 20;
    const t2 = performance.now();
    s.ordered();
    const painted = performance.now() - t2;
    expect(cardOrder(s, 'c-b').slice(3, 6)).toEqual(['a19', 'a18', 'a17']);
    // measured at about 50 ms, 4 ms and 1 ms; the budgets leave room for a loaded CI runner
    expect(built).toBeLessThan(2000);
    expect(moves).toBeLessThan(200);
    expect(painted).toBeLessThan(500);
  });
});

describe('two people at once', () => {
  function pair() {
    const a = new Store(new Y.Doc());
    const b = new Store(new Y.Doc());
    a.doc.clientID = 1;
    b.doc.clientID = 2;
    addKanban(a, { lanes: { todo: ['t1', 't2', 't3'], doing: ['d1'], done: [] } });
    sync(a, b);
    return { a, b };
  }
  function sync(a: Store, b: Store) {
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  }
  function converge(a: Store, b: Store) {
    sync(a, b);
    expect(state(a)).toBe(state(b));
    expect(a.ordered().map((o) => o.id)).toEqual(b.ordered().map((o) => o.id));
    // every card shows exactly once
    const shown = [...a.containerLayout('c')!.cards.values()].flat();
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.sort()).toEqual([...a.cache.values()].filter((o) => o.type === 'card').map((o) => o.id).sort());
  }
  const insert = (s: Store, id: Id, laneId: Id, index: number) => {
    const here = cardOrder(s, laneId).map((cid) => s.get(cid)!);
    const { ranks, repairs } = planInsert(here, laneId, index, 1);
    s.transact(() => {
      for (const r of repairs) s.update(r.id, { parent: r.parent, rank: r.rank });
      s.create(box(id, 'card', { parent: laneId, rank: ranks[0], h: 72 }));
    });
  };

  it('keeps both cards when two people drop different ones', () => {
    const { a, b } = pair();
    moveCard(a, 't1', 'c-done', 0);
    moveCard(b, 't3', 'c-doing', 1);
    converge(a, b);
    expect(cardOrder(a, 'c-done')).toEqual(['t1']);
    expect(cardOrder(a, 'c-doing')).toEqual(['d1', 't3']);
    expect(cardOrder(a, 'c-todo')).toEqual(['t2']);
  });

  it('orders two inserts into one gap by id on both sides, and repairs the lane on the next drop', () => {
    const { a, b } = pair();
    insert(a, 'nA', 'c-todo', 1);
    insert(b, 'nB', 'c-todo', 1);
    expect(bo(a, 'nA').rank).toBe(bo(b, 'nB').rank);
    converge(a, b);
    expect(cardOrder(a, 'c-todo')).toEqual(['t1', 'nA', 'nB', 't2', 't3']);
    expect(cardOrder(b, 'c-todo')).toEqual(cardOrder(a, 'c-todo'));
    const lane = () => cardOrder(a, 'c-todo').map((id) => a.get(id)!);
    expect(needsNormalising(lane())).toBe(true);
    moveCard(a, 't3', 'c-todo', 2);
    expect(needsNormalising(lane())).toBe(false);
    expect(cardOrder(a, 'c-todo')).toEqual(['t1', 'nA', 't3', 'nB', 't2']);
    sync(a, b);
    expect(cardOrder(b, 'c-todo')).toEqual(cardOrder(a, 'c-todo'));
  });

  it('leaves the card in one lane when two people move it to different lanes', () => {
    const { a, b } = pair();
    moveCard(a, 't1', 'c-doing', 0);
    moveCard(b, 't1', 'c-done', 0);
    converge(a, b);
    const lane = a.get('t1')!.parent;
    expect(['c-doing', 'c-done']).toContain(lane);
    expect(isMixedRank(bo(a, 't1'))).toBe(false);
  });

  it('shows a card last in the lane it names when a reorder and a move leave a mix, and repairs it on the next write', () => {
    // a only changes the rank; b changes the parent and the rank. Whichever client id wins the rank decides the mix.
    const run = (idA: number, idB: number) => {
      const { a, b } = pair();
      a.doc.clientID = idA;
      b.doc.clientID = idB;
      moveCard(a, 't1', 'c-todo', 2);
      moveCard(b, 't1', 'c-doing', 0);
      converge(a, b);
      const mixed = isMixedRank(bo(a, 't1'));
      const shown = { a: cardOrder(a, 'c-doing'), b: cardOrder(b, 'c-doing') };
      moveCard(a, 'd1', 'c-doing', 1);
      sync(a, b);
      return { parent: bo(a, 't1').parent, mixed, shown, repaired: !isMixedRank(bo(a, 't1')), after: { a: cardOrder(a, 'c-doing'), b: cardOrder(b, 'c-doing') } };
    };
    const runs = [run(1, 2), run(2, 1)];
    expect(runs.map((r) => r.parent)).toEqual(['c-doing', 'c-doing']);
    const [mixed] = runs.filter((r) => r.mixed);
    expect(runs.filter((r) => r.mixed)).toHaveLength(1);
    expect(mixed.shown).toEqual({ a: ['d1', 't1'], b: ['d1', 't1'] });
    expect(mixed.repaired).toBe(true);
    expect(mixed.after).toEqual({ a: ['t1', 'd1'], b: ['t1', 'd1'] });
    for (const r of runs) expect(r.repaired).toBe(true);
  });

  it('shows a card dropped into a lane that was deleted in the first lane, and loses nothing', () => {
    const { a, b } = pair();
    // a deletes the lane the way the UI does: its cards go to the lane on its left, then the lane goes
    const left = 'c-todo';
    a.transact(() => {
      const { ranks } = planInsert(cardOrder(a, left).map((id) => a.get(id)!), left, 99, 1);
      a.update('d1', { parent: left, rank: ranks[0] });
      a.remove(['c-doing']);
    });
    insert(b, 'late', 'c-doing', 1);
    converge(a, b);
    expect(a.get('c-doing')).toBeUndefined();
    expect(cardOrder(a, 'c-todo')).toEqual(['t1', 't2', 't3', 'd1', 'late']);
    expect(a.get('late')!.parent).toBe('c-doing');
    moveCard(a, 't1', 'c-todo', 1);
    expect(a.get('late')!.parent).toBe('c-todo');
    sync(a, b);
    expect(state(a)).toBe(state(b));
  });

  it('merges a conversion with an edit to another field of the same object', () => {
    const { a, b } = pair();
    a.transact(() => a.create(box('s', 'sticky', { text: 'title\nrest' })));
    sync(a, b);
    a.transact(() => a.update('s', { type: 'card', fill: '#FFE16B' }));
    b.transact(() => b.update('s', { desc: 'written meanwhile' }));
    sync(a, b);
    expect(state(a)).toBe(state(b));
    expect(a.get('s')).toMatchObject({ type: 'card', desc: 'written meanwhile', text: 'title\nrest' });
  });

  it('keeps all lanes when two people reorder them at once', () => {
    const { a, b } = pair();
    const moveLane = (s: Store, id: Id, index: number) => {
      const others = laneOrder(s, 'c').filter((l) => l !== id).map((l) => s.get(l)!);
      const { ranks, repairs } = planInsert(others, 'c', index, 1);
      s.transact(() => {
        for (const r of repairs) s.update(r.id, { parent: r.parent, rank: r.rank });
        s.update(id, { rank: ranks[0] });
      });
    };
    moveLane(a, 'c-done', 0);
    moveLane(b, 'c-doing', 0);
    sync(a, b);
    expect(laneOrder(a, 'c')).toEqual(laneOrder(b, 'c'));
    expect([...laneOrder(a, 'c')].sort()).toEqual(['c-doing', 'c-done', 'c-todo']);
    expect(state(a)).toBe(state(b));
    moveLane(a, 'c-todo', 1);
    sync(a, b);
    expect(laneOrder(b, 'c')).toEqual(laneOrder(a, 'c'));
    expect(needsNormalising(laneOrder(a, 'c').map((l) => a.get(l)!))).toBe(false);
  });
});

describe('moving a container', () => {
  it('writes one object and is one undo step', () => {
    const s = new Store(new Y.Doc());
    addKanban(s, kanban());
    s.undo.stopCapturing();
    const writes: string[] = [];
    s.objects.observeDeep((events) => events.forEach((e) => writes.push(e.path.join('/'))));
    s.transact(() => s.update('c', { x: 300, y: 40 }));
    expect([...new Set(writes)]).toEqual(['c']);
    expect(s.geometry(s.get('t1')!).x).toBeGreaterThan(300);
    s.undo.undo();
    expect(s.geometry(s.get('t1')!).x).toBeLessThan(100);
  });
});

describe('the feature flag', () => {
  it('lists containers in meta.features when the first container is written, once', () => {
    const s = new Store(new Y.Doc());
    expect(s.meta.get('features')).toBeUndefined();
    s.transact(() => s.create(box('x', 'sticky')));
    expect(s.meta.get('features')).toBeUndefined();
    addKanban(s, kanban());
    expect(s.meta.get('features')).toEqual(['containers']);
    expect(s.getMeta().features).toEqual(['containers']);
    addKanban(s, { id: 'd', lanes: { a: [] } });
    expect(s.meta.get('features')).toEqual(['containers']);
    expect(s.unsupportedFeatures()).toEqual([]);
  });

  it('also lists it when an object becomes a card, and keeps features other writers added', () => {
    const s = new Store(new Y.Doc());
    s.meta.set('features', ['zzz-future']);
    s.transact(() => s.create(box('x', 'sticky')));
    s.transact(() => s.update('x', { type: 'card' }));
    expect(s.meta.get('features')).toEqual(['containers', 'zzz-future']);
    s.transact(() => s.update('x', { text: 'only text' }));
    expect(s.meta.get('features')).toEqual(['containers', 'zzz-future']);
  });

  it('is part of the undo step that wrote the container', () => {
    const s = new Store(new Y.Doc());
    s.undo.stopCapturing();
    addKanban(s, kanban());
    s.undo.undo();
    expect(s.cache.size).toBe(0);
    expect(s.meta.get('features')).toBeUndefined();
  });

  it('names the features this client does not know, including ones that arrive later', () => {
    const a = new Store(new Y.Doc());
    const b = new Store(new Y.Doc());
    expect(b.unsupportedFeatures()).toEqual([]);
    a.meta.set('features', ['containers', 'holograms']);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.unsupportedFeatures()).toEqual(['holograms']);
  });

  it('is not written on a read-only store', () => {
    const s = new Store(new Y.Doc());
    s.setReadOnly(true);
    s.transact(() => s.create(box('c', 'container', { layout: 'kanban' })));
    expect(s.meta.get('features')).toBeUndefined();
  });
});

describe('labels', () => {
  const label = (id: string, name = id): Label => ({ id, name, color: 'red', order: 0 });

  it('is a map on the document, with whole-value labels', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => s.labels.set('bug', label('bug', 'Bug')));
    expect(s.doc.getMap('labels').get('bug')).toEqual(label('bug', 'Bug'));
    expect(s.labels).toBe(s.doc.getMap('labels'));
  });

  it('is undone with the local change that wrote it, and not with anyone else\'s', () => {
    const a = new Store(new Y.Doc());
    const b = new Store(new Y.Doc());
    a.undo.stopCapturing();
    a.transact(() => a.labels.set('bug', label('bug')));
    a.undo.stopCapturing();
    b.transact(() => b.labels.set('chore', label('chore')));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    expect([...a.labels.keys()].sort()).toEqual(['bug', 'chore']);
    a.undo.undo();
    expect([...a.labels.keys()]).toEqual(['chore']);
    a.undo.redo();
    expect([...a.labels.keys()].sort()).toEqual(['bug', 'chore']);
  });

  it('is kept in one undo step with the card that uses it', () => {
    const s = new Store(new Y.Doc());
    s.undo.stopCapturing();
    s.transact(() => {
      s.labels.set('bug', label('bug'));
      s.create(box('k', 'card', { labels: ['bug'] }));
    });
    s.undo.undo();
    expect(s.labels.size).toBe(0);
    expect(s.cache.size).toBe(0);
  });

  describe('in version history', () => {
    const snapshotOf = (s: Store) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(s.doc));
      const snap = new Store(doc);
      snap.setReadOnly(true);
      return snap;
    };

    it('comes back with the cards that point at it', () => {
      const live = new Store(new Y.Doc());
      live.transact(() => {
        live.labels.set('bug', label('bug', 'Bug'));
        live.create(box('k', 'card', { labels: ['bug'], parent: 'gone', rank: 'a0@gone' }));
      });
      const snap = snapshotOf(live);
      live.transact(() => {
        live.labels.delete('bug');
        live.remove(['k']);
      });
      const plan = planRestore(live, snap, { isHidden: () => false });
      expect(plan.empty).toBe(false);
      expect(plan.summary).toMatchObject({ added: 1, meta: true });
      expect(plan.labels).toEqual({ set: { bug: label('bug', 'Bug') }, remove: [] });
      applyRestore(live, plan);
      expect(live.labels.get('bug')).toEqual(label('bug', 'Bug'));
      expect(live.get('k')).toMatchObject({ labels: ['bug'] });
      expect(planRestore(live, snap, { isHidden: () => false }).empty).toBe(true);
    });

    it('drops labels the snapshot did not have, and restores changed ones', () => {
      const live = new Store(new Y.Doc());
      live.transact(() => live.labels.set('bug', label('bug', 'Bug')));
      const snap = snapshotOf(live);
      live.transact(() => {
        live.labels.set('bug', label('bug', 'Defect'));
        live.labels.set('new', label('new'));
      });
      const plan = planRestore(live, snap, { isHidden: () => false });
      expect(plan.labels).toEqual({ set: { bug: label('bug', 'Bug') }, remove: ['new'] });
      applyRestore(live, plan);
      expect([...live.labels.keys()]).toEqual(['bug']);
      expect(live.labels.get('bug')!.name).toBe('Bug');
    });

    it('does not make a plan out of identical labels', () => {
      const live = new Store(new Y.Doc());
      live.transact(() => live.labels.set('bug', label('bug')));
      const plan = planRestore(live, snapshotOf(live), { isHidden: () => false });
      expect(plan.empty).toBe(true);
      expect(plan.labels).toEqual({ set: {}, remove: [] });
    });

    it('restores a card with its parent and rank, and a lane that is gone is covered by the orphan rule', () => {
      const live = new Store(new Y.Doc());
      addKanban(live, kanban());
      const snap = snapshotOf(live);
      moveCard(live, 't1', 'c-done', 0);
      live.transact(() => live.remove(['c-doing']));
      applyRestore(live, planRestore(live, snap, { isHidden: () => false }));
      expect(cardOrder(live, 'c-todo')).toEqual(['t1', 't2', 't3']);
      expect(cardOrder(live, 'c-doing')).toEqual(['d1']);
      expect(live.meta.get('features')).toEqual(['containers']);
    });
  });
});

describe('the lists of object types', () => {
  it('leaves containers, lanes and cards out of a Mermaid export', () => {
    const out = toMermaid([
      box('a', 'shape', { kind: 'rect', text: 'Hello' }), box('c', 'container', { name: 'Board' }),
      box('l', 'lane', { name: 'Lane' }), box('k', 'card', { text: 'Card' }),
    ]);
    expect(out).toContain('Hello');
    expect(out).not.toMatch(/Card|Lane|Board/);
    expect(out.split('\n')).toHaveLength(2);
  });
});
