import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import {
  addCard, addLane, addLaneRefusal, editLane, laneDeleteIds, laneFields, moveCards, moveLane, moveLaneRefusal, moveLaneTo, laneReorderRefusal, moveRefusal, newKanban, newLaneName, planKanbanDelete,
  stickiesToCards, wipRefusal,
} from '../src/containers';
import {
  laneDropIndex, laneDropLine, EMPTY_FILTER, cardMatches, cleanFilter, dueBuckets, filterChips, filterParts, filterStorageKey, laneMoveIndex, matchText, parseWip,
  stageRedrawsCards, wipFullLabel, wipFullMessage, withoutChip, type FilterViewer, type KanbanFilter,
} from '../src/ui/kanban-logic';
import { LIMITS, splitRank } from '../shared/containers';
import type { BaseObj, Id } from '../src/types';

// docs/kanban.md, slice 4: lanes and discipline. The pure rules (filters, WIP block, lane moves, stages) and the store
// writes behind the lane and kanban menus.

function board(doc = new Y.Doc()) {
  const store = new Store(doc);
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  const cards = ['A', 'B'].map((t) => addCard(store, lanes[0].id, t, { createdBy: 'me' })!);
  store.undo.clear();
  return { store, container: container.id, lanes: lanes.map((l) => l.id), cards };
}

const laneOrder = (store: Store, container: Id) => store.containerLayout(container)!.lanes;
const names = (store: Store, container: Id) => laneOrder(store, container).map((id) => (store.get(id) as BaseObj).name);
const lane = (store: Store, id: Id) => store.get(id) as BaseObj;
const undoSteps = (store: Store) => (store.undo as unknown as { undoStack: unknown[] }).undoStack.length;

const f = (patch: Partial<KanbanFilter> = {}): KanbanFilter => ({ ...EMPTY_FILTER, labels: [], due: [], ...patch });
const me: FilterViewer = { id: 'u1', name: 'Ada Lovelace', accounts: true };
const open: FilterViewer = { ...me, accounts: false };
// Friday 9 October 2026: its ISO week runs from Monday 5 to Sunday 11 October
const today = '2026-10-09';

describe('filter matching', () => {
  const at = (viewer = me, done = false) => ({ viewer, today, done });

  it('the empty filter matches every card', () => {
    expect(cardMatches({}, f(), at())).toBe(true);
    expect(filterParts(f())).toBe(0);
  });

  it('Mine: the owner id in accounts mode; the id or the name (any case) in open mode', () => {
    expect(cardMatches({ ownerId: 'u1' }, f({ mine: true }), at())).toBe(true);
    expect(cardMatches({ ownerName: 'Ada Lovelace' }, f({ mine: true }), at())).toBe(false);
    expect(cardMatches({ ownerId: 'u2', ownerName: 'Ada Lovelace' }, f({ mine: true }), at())).toBe(false);
    expect(cardMatches({ ownerName: 'ada lovelace ' }, f({ mine: true }), at(open))).toBe(true);
    expect(cardMatches({ ownerId: 'u1' }, f({ mine: true }), at(open))).toBe(true);
    expect(cardMatches({}, f({ mine: true }), at(open))).toBe(false);
    expect(cardMatches({ ownerName: '' }, f({ mine: true }), at({ ...open, name: '' }))).toBe(false);
  });

  it('labels match any of; a deleted label counts as not set', () => {
    expect(cardMatches({ labels: ['bug', 'ui'] }, f({ labels: ['ui', 'docs'] }), at())).toBe(true);
    expect(cardMatches({ labels: ['bug'] }, f({ labels: ['ui'] }), at())).toBe(false);
    expect(cardMatches({}, f({ labels: ['ui'] }), at())).toBe(false);
    expect(cardMatches({}, f({ labels: ['gone'] }), { ...at(), known: new Set(['ui']) })).toBe(true);
    expect(cardMatches({ labels: ['bug'] }, f({ labels: ['gone', 'ui'] }), { ...at(), known: new Set(['ui']) })).toBe(false);
  });

  it('due buckets: overdue never in a done lane, today, this week Monday to Sunday, none', () => {
    expect([...dueBuckets('2026-10-08', today, false)]).toEqual(['overdue', 'week']);
    expect([...dueBuckets('2026-10-08', today, true)]).toEqual(['week']);
    expect([...dueBuckets('2026-10-09', today, false)]).toEqual(['today', 'week']);
    expect([...dueBuckets('2026-10-11', today, false)]).toEqual(['week']);
    expect([...dueBuckets('2026-10-12', today, false)]).toEqual([]);
    expect([...dueBuckets('2026-10-04', today, false)]).toEqual(['overdue']);
    expect([...dueBuckets(undefined, today, false)]).toEqual(['none']);
    expect([...dueBuckets('2026-02-30', today, false)]).toEqual(['none']);
    expect(cardMatches({ due: '2026-10-01' }, f({ due: ['overdue', 'none'] }), at())).toBe(true);
    expect(cardMatches({ due: '2026-10-01' }, f({ due: ['overdue'] }), at(me, true))).toBe(false);
    expect(cardMatches({}, f({ due: ['today'] }), at())).toBe(false);
  });

  it('text: in the title or the description, ignoring case and outer spaces', () => {
    expect(cardMatches({ text: 'Fix the LOGIN loop' }, f({ text: ' login ' }), at())).toBe(true);
    expect(cardMatches({ text: 'Fix', desc: 'Safari 17 only' }, f({ text: 'safari' }), at())).toBe(true);
    expect(cardMatches({ text: 'Fix' }, f({ text: 'safari' }), at())).toBe(false);
    expect(filterParts(f({ text: '   ' }))).toBe(0);
  });

  it('every part that is set must match', () => {
    const card = { ownerId: 'u1', labels: ['bug'], due: today, text: 'Login' };
    expect(cardMatches(card, f({ mine: true, labels: ['bug'], due: ['today'], text: 'log' }), at())).toBe(true);
    expect(cardMatches(card, f({ mine: true, labels: ['ui'] }), at())).toBe(false);
    expect(cardMatches(card, f({ labels: ['bug'], text: 'other' }), at())).toBe(false);
  });

  it('combines Overdue with Mine, labels and text using AND', () => {
    const card = { ownerId: me.id, labels: ['bug'], due: '2026-10-08', text: 'Login regression' };
    const filter = f({ mine: true, labels: ['bug'], due: ['overdue'], text: 'regression' });
    expect(cardMatches(card, filter, at())).toBe(true);
    expect(cardMatches({ ...card, ownerId: 'u2' }, filter, at())).toBe(false);
    expect(cardMatches({ ...card, labels: ['ui'] }, filter, at())).toBe(false);
    expect(cardMatches({ ...card, due: today }, filter, at())).toBe(false);
    expect(cardMatches({ ...card, text: 'Other task' }, filter, at())).toBe(false);
    expect(cardMatches(card, filter, at(me, true))).toBe(false);
  });

  it('a filter read back from storage keeps only what a filter holds', () => {
    expect(cleanFilter(null)).toEqual(f());
    expect(cleanFilter('x')).toEqual(f());
    expect(cleanFilter({ mine: 'yes', labels: ['a', 'a', 3, ''], due: ['today', 'soon', 'today'], text: 'x'.repeat(500), extra: 1 }))
      .toEqual({ mine: false, labels: ['a'], due: ['today'], text: 'x'.repeat(200) });
  });

  it('chips name each part, in popover order, and a chip removes its part', () => {
    const filter = f({ mine: true, labels: ['bug', 'gone'], due: ['none', 'overdue'], text: 'a long piece of text to look for' });
    const chips = filterChips(filter, (id) => (id === 'bug' ? 'Bug' : undefined));
    expect(chips.map((c) => c.text)).toEqual(['Mine', 'Bug', 'Overdue', 'No due date', '“a long piece of text to…”']);
    expect(withoutChip(filter, 'mine').mine).toBe(false);
    expect(withoutChip(filter, 'label:bug').labels).toEqual(['gone']);
    expect(withoutChip(filter, 'due:none').due).toEqual(['overdue']);
    expect(withoutChip(filter, 'text').text).toBe('');
    expect(filterParts(filter)).toBe(6);
  });

  it('the count line and the storage key', () => {
    expect(matchText(f({ mine: true }), 2, 9)).toBe('2 of 9 match');
    expect(matchText(f(), 9, 9)).toBe('No filter');
    expect(filterStorageKey('b1', 'k1')).toBe('tabula:filter:b1:k1');
  });
});

describe('lane rules', () => {
  it('move left and right stop at the edges', () => {
    expect(laneMoveIndex(['a', 'b', 'c'], 'a', 'left')).toBeNull();
    expect(laneMoveIndex(['a', 'b', 'c'], 'a', 'right')).toBe(1);
    expect(laneMoveIndex(['a', 'b', 'c'], 'c', 'left')).toBe(1);
    expect(laneMoveIndex(['a', 'b', 'c'], 'c', 'right')).toBeNull();
    expect(laneMoveIndex(['a'], 'x', 'left')).toBeNull();
  });

  it('a WIP limit is a whole number from 1 to 99, or nothing', () => {
    expect(parseWip(' 3 ')).toBe(3);
    expect(parseWip('99')).toBe(99);
    expect(parseWip('')).toBe('');
    for (const bad of ['0', '100', '2.5', '-1', 'x', '1e1']) expect(parseWip(bad)).toBeNull();
  });

  it('only a change into or out of done redraws the cards', () => {
    expect(stageRedrawsCards('todo', 'done')).toBe(true);
    expect(stageRedrawsCards('done', undefined)).toBe(true);
    expect(stageRedrawsCards('todo', 'doing')).toBe(false);
    expect(stageRedrawsCards(undefined, 'doing')).toBe(false);
  });

  it('the full messages', () => {
    expect(wipFullMessage('Review', 2, 2)).toBe('Review is full: 2 of 2');
    expect(wipFullMessage('', 3, 3)).toBe('This lane is full: 3 of 3');
    expect(wipFullLabel(2, 2)).toBe('Full · 2 / 2');
  });

  it('new lanes are told apart', () => {
    expect(newLaneName(['To do', 'Doing'])).toBe('New lane');
    expect(newLaneName(['New lane', 'new lane 2'])).toBe('New lane 3');
  });
});

describe('editing a lane from its menu', () => {
  it('each change is one transaction and one undo step', () => {
    const { store, lanes } = board();
    expect(editLane(store, lanes[1], { name: '  In   review ' })).toBe(true);
    expect(editLane(store, lanes[1], { fill: 'blue' })).toBe(true);
    expect(editLane(store, lanes[1], { stage: 'done' })).toBe(true);
    expect(editLane(store, lanes[1], { wip: 3, wipMode: 'block' })).toBe(true);
    expect(lane(store, lanes[1])).toMatchObject({ name: 'In review', fill: 'blue', stage: 'done', wip: 3, wipMode: 'block' });
    expect(undoSteps(store)).toBe(4);
    store.undo.undo();
    expect(lane(store, lanes[1]).wip).toBeUndefined();
    expect(lane(store, lanes[1]).stage).toBe('done');
  });

  it('every colour goes through kanbanColor', () => {
    expect(laneFields({ fill: 'Blue' })).toEqual({ fill: 'blue' });
    expect(laneFields({ fill: '#12abEF' })).toEqual({ fill: '#12ABEF' });
    expect(laneFields({ fill: 'red;background:url(x)' })).toEqual({ fill: undefined });
    expect(laneFields({ fill: 'none' })).toEqual({ fill: undefined });
    expect(laneFields({ fill: null })).toEqual({ fill: undefined });
    const { store, lanes } = board();
    editLane(store, lanes[0], { fill: 'url(javascript:x)' });
    expect(lane(store, lanes[0]).fill).toBeUndefined();
  });

  it('clearing the limit clears its mode; a mode alone keeps the limit; warn is the default and not stored', () => {
    const { store, lanes } = board();
    editLane(store, lanes[0], { wip: 2, wipMode: 'block' });
    editLane(store, lanes[0], { wipMode: 'warn' });
    expect(lane(store, lanes[0])).toMatchObject({ wip: 2 });
    expect(lane(store, lanes[0]).wipMode).toBeUndefined();
    editLane(store, lanes[0], { wip: 2, wipMode: 'block' });
    editLane(store, lanes[0], { wip: null });
    expect(lane(store, lanes[0]).wip).toBeUndefined();
    expect(lane(store, lanes[0]).wipMode).toBeUndefined();
  });

  it('refuses what the spec does not allow, and writes nothing for no change', () => {
    const { store, lanes } = board();
    for (const bad of [{ name: '  ' }, { wip: 0 }, { wip: 100 }, { wip: 2.5 }, { stage: 'later' as never }, { wipMode: 'hard' as never }]) {
      expect(editLane(store, lanes[0], bad)).toBe(false);
    }
    expect(editLane(store, lanes[0], { name: 'x'.repeat(100) })).toBe(true);
    expect(lane(store, lanes[0]).name).toHaveLength(LIMITS.laneName);
    expect(editLane(store, lanes[0], { stage: 'todo' })).toBe(false);
    expect(undoSteps(store)).toBe(1);
  });

  it('a locked lane and a read-only board are never changed', () => {
    const { store, lanes } = board();
    store.transact(() => store.update(lanes[0], { locked: true }));
    expect(editLane(store, lanes[0], { fill: 'blue' })).toBe(false);
    store.setReadOnly(true);
    expect(editLane(store, lanes[1], { fill: 'blue' })).toBe(false);
    expect(lane(store, lanes[1]).fill).toBeUndefined();
  });
});

describe('moving a lane', () => {
  it('writes the lane\'s rank only, keeps ranks valid, one undo step', () => {
    const { store, container, lanes } = board();
    expect(moveLane(store, lanes[0], 'right')).toBe(true);
    expect(laneOrder(store, container)).toEqual([lanes[1], lanes[0], lanes[2]]);
    expect(moveLane(store, lanes[0], 'right')).toBe(true);
    expect(laneOrder(store, container)).toEqual([lanes[1], lanes[2], lanes[0]]);
    for (const id of lanes) expect(splitRank(lane(store, id).rank)?.parent).toBe(container);
    const keys = laneOrder(store, container).map((id) => splitRank(lane(store, id).rank)!.key);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(3);
    expect(undoSteps(store)).toBe(2);
    store.undo.undo();
    expect(laneOrder(store, container)).toEqual([lanes[1], lanes[0], lanes[2]]);
  });

  it('does nothing at an edge, for a locked lane or in a locked kanban', () => {
    const { store, container, lanes } = board();
    expect(moveLane(store, lanes[0], 'left')).toBe(false);
    expect(moveLane(store, lanes[2], 'right')).toBe(false);
    store.transact(() => store.update(lanes[1], { locked: true }));
    expect(moveLane(store, lanes[1], 'left')).toBe(false);
    store.transact(() => store.update(lanes[1], { locked: undefined }));
    store.transact(() => store.update(container, { locked: true }));
    expect(moveLane(store, lanes[1], 'left')).toBe(false);
    expect(laneOrder(store, container)).toEqual(lanes);
  });

  it('repairs equal ranks among the lanes as it writes', () => {
    const { store, container, lanes } = board();
    const same = lane(store, lanes[0]).rank;
    store.transact(() => lanes.forEach((id) => store.update(id, { rank: same })));
    const before = laneOrder(store, container);
    expect(moveLane(store, before[2], 'left')).toBe(true);
    const after = laneOrder(store, container);
    expect(after).toEqual([before[0], before[2], before[1]]);
    expect(new Set(after.map((id) => lane(store, id).rank)).size).toBe(3);
  });
});

describe('adding a lane', () => {
  it('goes after the last lane, named, one undo step', () => {
    const { store, container, lanes } = board();
    const id = addLane(store, container, { createdBy: 'me' })!;
    expect(laneOrder(store, container)).toEqual([...lanes, id]);
    expect(lane(store, id)).toMatchObject({ type: 'lane', parent: container, name: 'New lane' });
    expect(splitRank(lane(store, id).rank)?.parent).toBe(container);
    expect(undoSteps(store)).toBe(1);
    store.undo.undo();
    expect(store.get(id)).toBeUndefined();
  });

  it('stops at 20 lanes and in a locked kanban', () => {
    const { store, container } = board();
    for (let i = 3; i < LIMITS.lanes; i++) addLane(store, container, { createdBy: 'me' });
    expect(laneOrder(store, container)).toHaveLength(LIMITS.lanes);
    expect(addLaneRefusal(store, container)).toMatch(/at most 20 lanes/);
    expect(addLane(store, container, { createdBy: 'me' })).toBeNull();
    const b = board();
    b.store.transact(() => b.store.update(b.container, { locked: true }));
    expect(addLaneRefusal(b.store, b.container)).toMatch(/locked/);
    expect(addLane(b.store, b.container, { createdBy: 'me' })).toBeNull();
  });
});

describe('deleting a lane from its menu', () => {
  it('alone, or with its cards', () => {
    const { store, lanes, cards } = board();
    expect(laneDeleteIds(store, lanes[0], false)).toEqual({ ids: [lanes[0]] });
    expect(laneDeleteIds(store, lanes[0], true)).toEqual({ ids: [lanes[0], ...cards] });
  });

  it('is refused for a locked kanban, a locked lane, and with locked cards when they would go', () => {
    const { store, container, lanes, cards } = board();
    store.transact(() => store.update(cards[1], { locked: true }));
    expect(laneDeleteIds(store, lanes[0], true)).toEqual({ refused: expect.stringMatching(/locked cards/) });
    expect('ids' in laneDeleteIds(store, lanes[0], false)).toBe(true);
    store.transact(() => store.update(lanes[1], { locked: true }));
    expect(laneDeleteIds(store, lanes[1], false)).toEqual({ refused: expect.stringMatching(/lane is locked/) });
    store.transact(() => store.update(container, { locked: true }));
    expect(laneDeleteIds(store, lanes[2], false)).toEqual({ refused: expect.stringMatching(/kanban is locked/) });
  });
});

describe('WIP block (docs/kanban.md, WIP limits)', () => {
  it('refuses cards arriving in a full block lane, with the toast', () => {
    const { store, lanes, cards } = board();
    const c = addCard(store, lanes[1], 'C', { createdBy: 'me' })!;
    editLane(store, lanes[1], { name: 'Review', wip: 1, wipMode: 'block' });
    expect(wipRefusal(store, [cards[0]], lanes[1])).toBe('Review is full: 1 of 1');
    expect(moveRefusal(store, [cards[0]], lanes[1])).toBe('Review is full: 1 of 1');
    expect(moveCards(store, [cards[0]], lanes[1], 0)).toBe(false);
    // moving within the lane and out of it is never refused
    expect(wipRefusal(store, [c], lanes[1])).toBeNull();
    expect(moveCards(store, [c], lanes[2], 0)).toBe(true);
  });

  it('warn never refuses; an over-full lane does not trap its own cards', () => {
    const { store, lanes, cards } = board();
    editLane(store, lanes[1], { wip: 1 });
    expect(moveCards(store, cards, lanes[1], 0)).toBe(true);
    // someone else's drop left the block lane over its limit: its cards still move within and out
    editLane(store, lanes[1], { wipMode: 'block' });
    expect(moveCards(store, [cards[1]], lanes[1], 0)).toBe(true);
    expect(moveCards(store, [cards[0]], lanes[0], 0)).toBe(true);
    expect(moveRefusal(store, [cards[0]], lanes[1])).toMatch(/is full: 1 of 1/);
  });

  it('a sticky dropped on a full block lane stays a sticky', () => {
    const { store, lanes } = board();
    editLane(store, lanes[0], { wip: 2, wipMode: 'block' });
    store.transact(() => store.create({ id: 's1', type: 'sticky', x: 2000, y: 0, w: 192, h: 192, rotation: 0, z: 'a5', fill: '#FFE16B', text: 'Note', createdBy: 'me', updatedAt: 0 } as BaseObj));
    const r = stickiesToCards(store, ['s1'], () => ({ lane: lanes[0], index: 0 }), 'me');
    expect(r.refused).toMatch(/is full: 2 of 2/);
    expect(store.get('s1')!.type).toBe('sticky');
  });
});

describe('two people editing lanes at once', () => {
  function pair() {
    const a = board();
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(a.store.doc));
    const b = new Store(docB);
    return { a, b };
  }
  const sync = (x: Store, y: Store) => {
    Y.applyUpdate(x.doc, Y.encodeStateAsUpdate(y.doc, Y.encodeStateVector(x.doc)));
    Y.applyUpdate(y.doc, Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc)));
  };

  it('renames of different lanes both land; renames of one lane agree everywhere', () => {
    const { a, b } = pair();
    editLane(a.store, a.lanes[0], { name: 'Backlog' });
    editLane(b, a.lanes[1], { name: 'Now' });
    editLane(a.store, a.lanes[2], { name: 'Shipped' });
    editLane(b, a.lanes[2], { name: 'Released' });
    sync(a.store, b);
    expect(names(a.store, a.container)).toEqual(names(b, a.container));
    expect(names(b, a.container).slice(0, 2)).toEqual(['Backlog', 'Now']);
  });

  it('a rename and a move of one lane both apply', () => {
    const { a, b } = pair();
    editLane(a.store, a.lanes[0], { name: 'Backlog' });
    moveLane(b, a.lanes[0], 'right');
    sync(a.store, b);
    expect(names(a.store, a.container)).toEqual(['Doing', 'Backlog', 'Done']);
    expect(names(b, a.container)).toEqual(['Doing', 'Backlog', 'Done']);
  });

  it('two moves at once leave one order everywhere, every lane once, and the next move repairs equal ranks', () => {
    const { a, b } = pair();
    moveLane(a.store, a.lanes[0], 'right');
    moveLane(b, a.lanes[2], 'left');
    sync(a.store, b);
    const order = laneOrder(a.store, a.container);
    expect(laneOrder(b, a.container)).toEqual(order);
    expect([...order].sort()).toEqual([...a.lanes].sort());
    moveLane(a.store, order[1], 'left');
    sync(a.store, b);
    const ranks = laneOrder(b, a.container).map((id) => lane(b, id).rank);
    expect(new Set(ranks).size).toBe(3);
    expect(laneOrder(b, a.container)).toEqual(laneOrder(a.store, a.container));
  });

  it('a lane added on each side: both appear, in the same order everywhere', () => {
    const { a, b } = pair();
    const x = addLane(a.store, a.container, { createdBy: 'a' })!;
    const y = addLane(b, a.container, { createdBy: 'b' })!;
    sync(a.store, b);
    const order = laneOrder(a.store, a.container);
    expect(order).toEqual(laneOrder(b, a.container));
    expect(order).toEqual(expect.arrayContaining([x, y]));
    expect(order).toHaveLength(5);
  });
});

describe('review fixes', () => {
  it('cleanFilter with the board\'s labels drops the others', () => {
    expect(cleanFilter({ labels: ['a', 'gone', 'b'] }, new Set(['a', 'b'])).labels).toEqual(['a', 'b']);
    expect(cleanFilter({ labels: ['gone'] }, new Set()).labels).toEqual([]);
  });

  it('moveLane never rewrites a locked lane through the repair of tied ranks', () => {
    const { store, container, lanes } = board();
    const same = lane(store, lanes[0]).rank;
    store.transact(() => lanes.forEach((id) => store.update(id, { rank: same })));
    const order = laneOrder(store, container);
    store.transact(() => store.update(order[0], { locked: true }));
    expect(moveLaneRefusal(store, order[2], 'left')).toMatch(/locked/);
    expect(moveLane(store, order[2], 'left')).toBe(false);
    expect(lane(store, order[0]).rank).toBe(same);
    // without ties there is nothing to repair, and a locked neighbour does not stop the move
    const b = board();
    b.store.transact(() => b.store.update(b.lanes[0], { locked: true }));
    expect(moveLaneRefusal(b.store, b.lanes[2], 'left')).toBeNull();
    expect(moveLane(b.store, b.lanes[2], 'left')).toBe(true);
  });

  it('a lane delete does not relocate cards into a full block lane; deleting them with it is fine', () => {
    const { store, lanes, cards } = board();
    addCard(store, lanes[1], 'D', { createdBy: 'me' });
    editLane(store, lanes[1], { name: 'Doing', wip: 2, wipMode: 'block' });
    expect(planKanbanDelete(store, [lanes[0]])).toEqual({ refused: expect.stringMatching(/^Doing is full: 1 of 2/) });
    expect('ids' in planKanbanDelete(store, [lanes[0], ...cards])).toBe(true);
    editLane(store, lanes[1], { wipMode: 'warn' });
    expect('ids' in planKanbanDelete(store, [lanes[0]])).toBe(true);
  });
});

describe('dragging a lane to a place (slice 5, part 2)', () => {
  const names = (b: ReturnType<typeof board>) => b.store.containerLayout(b.container)!.lanes.map((l) => (b.store.get(l) as BaseObj).name);

  it('writes one rank in one undo step, to any place among the others', () => {
    const b = board();
    expect(moveLaneTo(b.store, b.lanes[0], 2)).toBe(true);
    expect(names(b)).toEqual(['Doing', 'Done', 'To do']);
    b.store.undo.undo();
    expect(names(b)).toEqual(['To do', 'Doing', 'Done']);
    expect(moveLaneTo(b.store, b.lanes[2], 0)).toBe(true);
    expect(names(b)).toEqual(['Done', 'To do', 'Doing']);
  });

  it('does nothing for its own place, a place out of range, a locked lane or a locked kanban', () => {
    const b = board();
    expect(moveLaneTo(b.store, b.lanes[1], 1)).toBe(false);
    expect(moveLaneTo(b.store, b.lanes[1], 3)).toBe(false);
    expect(moveLaneTo(b.store, b.lanes[1], -1)).toBe(false);
    b.store.transact(() => b.store.update(b.lanes[0], { locked: true }));
    expect(moveLaneTo(b.store, b.lanes[0], 2)).toBe(false);
    expect(laneReorderRefusal(b.store, b.lanes[0], 2)).toBe('This lane is locked. Unlock it to change it.');
    b.store.transact(() => b.store.update(b.container, { locked: true }));
    expect(moveLaneTo(b.store, b.lanes[1], 2)).toBe(false);
    expect(names(b)).toEqual(['To do', 'Doing', 'Done']);
  });

  it('refuses a lane, or a kanban, that Layers hides', () => {
    const b = board();
    b.store.transact(() => b.store.update(b.lanes[0], { hidden: true }));
    expect(moveLaneTo(b.store, b.lanes[0], 1)).toBe(false);
    expect(laneReorderRefusal(b.store, b.lanes[0], 1)).toBe('This lane is gone.');
    b.store.transact(() => b.store.update(b.lanes[0], { hidden: false }));
    b.store.transact(() => b.store.update(b.container, { hidden: true }));
    expect(moveLaneTo(b.store, b.lanes[1], 2)).toBe(false);
  });

  it('finds the place from the pointer and draws the drop line in the gap', () => {
    const b = board();
    const layout = b.store.containerLayout(b.container)!;
    const rect = (i: number) => layout.rects.get(layout.lanes[i])!;
    expect(laneDropIndex(layout.lanes, layout.rects, b.lanes[0], rect(2).x + rect(2).w)).toBe(2);
    expect(laneDropIndex(layout.lanes, layout.rects, b.lanes[0], rect(1).x + 1)).toBe(0);
    expect(laneDropIndex(layout.lanes, layout.rects, b.lanes[2], rect(0).x - 50)).toBe(0);
    const end = laneDropLine(layout.lanes, layout.rects, b.lanes[0], 2)!;
    expect(end.x).toBeGreaterThan(rect(2).x + rect(2).w);
    const first = laneDropLine(layout.lanes, layout.rects, b.lanes[2], 0)!;
    expect(first.x).toBeLessThan(rect(0).x);
    expect(first.h).toBe(rect(2).h);
  });
});
