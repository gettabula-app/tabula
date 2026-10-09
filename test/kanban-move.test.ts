import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FEATURES, featureKey, isMixedRank } from '../shared/containers';
import { Store } from '../src/store';
import { addCard, dropLoose, moveCards, movingOrder, newKanban } from '../src/containers';
import type { BaseObj, Id } from '../src/types';

// docs/kanban.md, slice 2: a move, an add and a new kanban are each one transaction and one undo step, and two people
// moving cards at once lose nothing.

function board(doc = new Y.Doc()) {
  const store = new Store(doc);
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me', bodyFont: 'satoshi', headingFont: 'cabinet-grotesk' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  store.undo.clear();
  return { store, container: container.id, lanes: lanes.map((l) => l.id) };
}

const cardsIn = (store: Store, container: Id, lane: Id) => store.containerLayout(container)!.cards.get(lane) ?? [];
const title = (store: Store, id: Id) => (store.get(id) as BaseObj).text;
const titles = (store: Store, container: Id, lane: Id) => cardsIn(store, container, lane).map((id) => title(store, id));

function seeded() {
  const b = board();
  const ids = ['A', 'B', 'C'].map((t) => addCard(b.store, b.lanes[0], t, { createdBy: 'me' })!);
  b.store.undo.clear();
  return { ...b, ids };
}

/** Each local transaction the doc commits, counted. */
function countTransactions(store: Store) {
  let n = 0;
  store.doc.on('afterTransaction', (tr) => {
    if (tr.origin === 'local' && tr.changed.size) n++;
  });
  return () => n;
}

describe('a new kanban', () => {
  it('has three lanes, To do, Doing and Done, with their stages, and needs the containers feature', () => {
    const { store, container, lanes } = board();
    expect(store.containerLayout(container)!.lanes).toEqual(lanes);
    expect(lanes.map((id) => store.get(id) as BaseObj).map((l) => [l.name, l.stage])).toEqual([['To do', 'todo'], ['Doing', 'doing'], ['Done', 'done']]);
    expect(store.meta.get(featureKey(FEATURES.containers))).toBe(true);
  });

  it('stores the size its layout gives it once, at creation', () => {
    const { container } = newKanban({ x: 10, y: 20 }, { z: 'a0', createdBy: 'me' });
    expect(container.w).toBe(12 + 3 * 280 + 2 * 16 + 8 + 32 + 12);
    expect(container.h).toBe(48 + 12 + 48 + 160 + 12);
  });
});

describe('adding a card', () => {
  it('puts it at the end of the lane with a rank that carries the lane, in one undo step', () => {
    const { store, container, lanes, ids } = seeded();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
    for (const id of ids) expect(isMixedRank(store.get(id) as BaseObj)).toBe(false);
    const done = countTransactions(store);
    addCard(store, lanes[0], 'D', { createdBy: 'me' });
    expect(done()).toBe(1);
    store.undo.undo();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
  });

  it('stores a height from the title, and refuses an empty title', () => {
    const { store, lanes } = board();
    const short = addCard(store, lanes[0], 'Spike', { createdBy: 'me' })!;
    expect((store.get(short) as BaseObj).h).toBe(34);
    expect(addCard(store, lanes[0], '   ', { createdBy: 'me' })).toBeNull();
  });

  it('cuts a title to 200 characters', () => {
    const { store, lanes } = board();
    const id = addCard(store, lanes[0], 'x'.repeat(300), { createdBy: 'me' })!;
    expect(title(store, id)).toHaveLength(200);
  });

  it('writes nothing on a read-only board', () => {
    const { store, lanes } = board();
    store.setReadOnly(true);
    expect(addCard(store, lanes[0], 'A', { createdBy: 'me' })).toBeNull();
  });
});

describe('moving cards', () => {
  it('moves a card within its lane in one transaction and one undo step', () => {
    const { store, container, lanes, ids } = seeded();
    const done = countTransactions(store);
    expect(moveCards(store, [ids[0]], lanes[0], 2)).toBe(true);
    expect(done()).toBe(1);
    expect(titles(store, container, lanes[0])).toEqual(['B', 'C', 'A']);
    store.undo.undo();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
    store.undo.redo();
    expect(titles(store, container, lanes[0])).toEqual(['B', 'C', 'A']);
  });

  it('moves a card to another lane, writing parent and rank together', () => {
    const { store, container, lanes, ids } = seeded();
    moveCards(store, [ids[1]], lanes[1], 0);
    expect(titles(store, container, lanes[0])).toEqual(['A', 'C']);
    expect(titles(store, container, lanes[1])).toEqual(['B']);
    const b = store.get(ids[1]) as BaseObj;
    expect(b.parent).toBe(lanes[1]);
    expect(b.rank!.endsWith(`@${lanes[1]}`)).toBe(true);
    store.undo.undo();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
    expect(titles(store, container, lanes[1])).toEqual([]);
  });

  it('keeps three quick moves as three undo steps', () => {
    const { store, container, lanes, ids } = seeded();
    moveCards(store, [ids[0]], lanes[1], 0);
    moveCards(store, [ids[0]], lanes[2], 0);
    moveCards(store, [ids[0]], lanes[1], 0);
    store.undo.undo();
    expect(titles(store, container, lanes[2])).toEqual(['A']);
    store.undo.undo();
    expect(titles(store, container, lanes[1])).toEqual(['A']);
    store.undo.undo();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
  });

  it('moves several cards as a group, in container order, whatever order they were picked in', () => {
    const { store, container, lanes, ids } = seeded();
    const d = addCard(store, lanes[1], 'D', { createdBy: 'me' })!;
    expect(movingOrder(store, [d, ids[2], ids[0]])).toEqual([ids[0], ids[2], d]);
    const done = countTransactions(store);
    moveCards(store, [d, ids[2], ids[0]], lanes[2], 0);
    expect(done()).toBe(1);
    expect(titles(store, container, lanes[2])).toEqual(['A', 'C', 'D']);
    expect(titles(store, container, lanes[0])).toEqual(['B']);
  });

  it('leaves locked cards where they are', () => {
    const { store, container, lanes, ids } = seeded();
    store.transact(() => store.update(ids[0], { locked: true }));
    expect(moveCards(store, [ids[0]], lanes[1], 0)).toBe(false);
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
  });

  it('repairs equal ranks in the target lane in the same transaction', () => {
    const { store, container, lanes, ids } = seeded();
    const rank = (store.get(ids[0]) as BaseObj).rank;
    store.transact(() => store.update(ids[1], { rank }));
    const done = countTransactions(store);
    moveCards(store, [ids[2]], lanes[0], 1);
    expect(done()).toBe(1);
    const keys = cardsIn(store, container, lanes[0]).map((id) => (store.get(id) as BaseObj).rank!.split('@')[0]);
    expect(new Set(keys).size).toBe(3);
    expect(titles(store, container, lanes[0])[1]).toBe('C');
  });

  it('takes a card out as a loose card at the place it was dropped, and back into a lane', () => {
    const { store, container, lanes, ids } = seeded();
    expect(dropLoose(store, [{ id: ids[0], x: 900, y: 50, w: 264, h: 34 }])).toBe(true);
    const a = store.get(ids[0]) as BaseObj;
    expect(a.type).toBe('card');
    expect([a.parent, a.rank, a.x, a.y]).toEqual([undefined, undefined, 900, 50]);
    expect(store.isLaidOut(a)).toBe(false);
    expect(titles(store, container, lanes[0])).toEqual(['B', 'C']);
    moveCards(store, [ids[0]], lanes[2], 0);
    expect(titles(store, container, lanes[2])).toEqual(['A']);
    store.undo.undo();
    expect(store.isLaidOut(store.get(ids[0])!)).toBe(false);
    store.undo.undo();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
  });

  it('writes nothing on a read-only board', () => {
    const { store, container, lanes, ids } = seeded();
    store.setReadOnly(true);
    expect(moveCards(store, [ids[0]], lanes[1], 0)).toBe(false);
    expect(dropLoose(store, [{ id: ids[0], x: 0, y: 0, w: 10, h: 10 }])).toBe(false);
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
  });
});

describe('two people moving at once', () => {
  function pair() {
    const a = seeded();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.store.doc));
    return { a, b: new Store(doc) };
  }
  const sync = (x: Store, y: Store) => {
    Y.applyUpdate(x.doc, Y.encodeStateAsUpdate(y.doc, Y.encodeStateVector(x.doc)));
    Y.applyUpdate(y.doc, Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc)));
  };
  const all = (s: Store, container: Id) => [...s.containerLayout(container)!.cards.values()].flat();

  it('lands both when they move different cards', () => {
    const { a, b } = pair();
    moveCards(a.store, [a.ids[0]], a.lanes[1], 0);
    moveCards(b, [a.ids[2]], a.lanes[2], 0);
    sync(a.store, b);
    for (const s of [a.store, b]) {
      expect(titles(s, a.container, a.lanes[0])).toEqual(['B']);
      expect(titles(s, a.container, a.lanes[1])).toEqual(['A']);
      expect(titles(s, a.container, a.lanes[2])).toEqual(['C']);
    }
  });

  it('keeps one card in one lane when both move it to different lanes, the same on both sides', () => {
    const { a, b } = pair();
    moveCards(a.store, [a.ids[0]], a.lanes[1], 0);
    moveCards(b, [a.ids[0]], a.lanes[2], 0);
    sync(a.store, b);
    expect(a.store.containerLayout(a.container)!.cards).toEqual(b.containerLayout(a.container)!.cards);
    const where = [...a.store.containerLayout(a.container)!.cards].filter(([, ids]) => ids.includes(a.ids[0]));
    expect(where).toHaveLength(1);
    expect(all(a.store, a.container).sort()).toEqual([...a.ids].sort());
  });

  it('orders two drops into the same gap the same way everywhere, and the next drop repairs the tie', () => {
    const { a, b } = pair();
    moveCards(a.store, [a.ids[0]], a.lanes[1], 0);
    moveCards(b, [a.ids[1]], a.lanes[1], 0);
    sync(a.store, b);
    expect(titles(a.store, a.container, a.lanes[1])).toEqual(titles(b, a.container, a.lanes[1]));
    expect(titles(a.store, a.container, a.lanes[1]).sort()).toEqual(['A', 'B']);
    moveCards(a.store, [a.ids[2]], a.lanes[1], 1);
    sync(a.store, b);
    const keys = cardsIn(b, a.container, a.lanes[1]).map((id) => (b.get(id) as BaseObj).rank!.split('@')[0]);
    expect(new Set(keys).size).toBe(3);
    expect(titles(a.store, a.container, a.lanes[1])).toEqual(titles(b, a.container, a.lanes[1]));
  });

  it('loses no card when a lane is deleted while someone drops into it', () => {
    const { a, b } = pair();
    a.store.transact(() => a.store.remove([a.lanes[2]]));
    moveCards(b, [a.ids[0]], a.lanes[2], 0);
    sync(a.store, b);
    for (const s of [a.store, b]) expect(all(s, a.container).sort()).toEqual([...a.ids].sort());
    expect(a.store.containerLayout(a.container)!.cards).toEqual(b.containerLayout(a.container)!.cards);
  });

  it('keeps an undo of one person from undoing the other person’s move', () => {
    const { a, b } = pair();
    moveCards(a.store, [a.ids[0]], a.lanes[1], 0);
    moveCards(b, [a.ids[2]], a.lanes[2], 0);
    sync(a.store, b);
    a.store.undo.undo();
    sync(a.store, b);
    for (const s of [a.store, b]) {
      expect(titles(s, a.container, a.lanes[0])).toEqual(['A', 'B']);
      expect(titles(s, a.container, a.lanes[2])).toEqual(['C']);
    }
  });
});
