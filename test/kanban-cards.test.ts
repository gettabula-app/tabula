import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { Comments, anchorFor, anchorPosition } from '../src/comments';
import {
  LOOSE_CARD_W, addCard, cardsToStickies, editCard, kanbanFromStickies, moveCards, newKanban, stickiesToCards,
} from '../src/containers';
import {
  cleanCardLabels, createLabel, deleteLabel, listLabels, moveLabel, planLabelMove, recolorLabel, renameLabel, toggleCardLabel,
} from '../src/labels';
import { cardContentHeight } from '../src/markup';
import { KANBAN, LIMITS } from '../shared/containers';
import type { BaseObj, Id, Label } from '../src/types';

// docs/kanban.md, slice 3: the store side of cards. Every edit is one transaction and one undo step, nothing is written
// on a read-only board, colours go through kanbanColor and text through the limits, labels under concurrent edits.

const EVIL_COLOR = 'red;background:url(https://evil.example/x)';
const EVIL_TEXT = '"><img src=x onerror=alert(1)><script>alert(1)</script>';

function board() {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  const cards = ['A', 'B'].map((t) => addCard(store, lanes[0].id, t, { createdBy: 'me' })!);
  store.undo.clear();
  return { store, container: container.id, lanes: lanes.map((l) => l.id), cards };
}

const bo = (store: Store, id: Id) => store.get(id) as BaseObj;
const undoSteps = (store: Store) => (store.undo as unknown as { undoStack: unknown[] }).undoStack.length;

function sticky(store: Store, id: Id, extra: Partial<BaseObj> = {}) {
  store.transact(() => store.create({ id, type: 'sticky', x: 2000, y: 0, w: 192, h: 192, rotation: 0, z: 'a1', fill: '#A3D2FF', text: 'Ship it', createdBy: 'me', updatedAt: 0, ...extra } as BaseObj));
  store.undo.clear();
}

describe('labels', () => {
  it('creates, renames, recolours, reorders and deletes, each as one undo step', () => {
    const { store } = board();
    const bug = createLabel(store, '  Bug  ')!;
    const feat = createLabel(store, 'Feature')!;
    expect(undoSteps(store)).toBe(2);
    expect(listLabels(store).map((l) => [l.name, l.color])).toEqual([['Bug', 'yellow'], ['Feature', 'orange']]);
    expect(renameLabel(store, bug, 'Defect')).toBe(true);
    expect(recolorLabel(store, bug, 'Pink')).toBe(true);
    expect(moveLabel(store, feat, -1)).toBe(true);
    expect(listLabels(store).map((l) => l.name)).toEqual(['Feature', 'Defect']);
    expect(deleteLabel(store, feat)).toBe(true);
    expect(undoSteps(store)).toBe(6);
    expect(listLabels(store).map((l) => [l.name, l.color])).toEqual([['Defect', 'pink']]);
    store.undo.undo();
    expect(listLabels(store).map((l) => l.name)).toEqual(['Feature', 'Defect']);
  });

  it('keeps the limits: a name, 40 characters, 30 labels', () => {
    const { store } = board();
    expect(createLabel(store, '   ')).toBeNull();
    const id = createLabel(store, 'x'.repeat(60))!;
    expect(listLabels(store)[0].name).toHaveLength(LIMITS.labelName);
    expect(renameLabel(store, id, '  ')).toBe(false);
    for (let i = 1; i < LIMITS.labels; i++) createLabel(store, `L${i}`);
    expect(listLabels(store)).toHaveLength(LIMITS.labels);
    expect(createLabel(store, 'one more')).toBeNull();
  });

  it('never stores a raw colour: writes go through kanbanColor and reads through validLabel', () => {
    const { store } = board();
    const id = createLabel(store, 'Bug', EVIL_COLOR)!;
    expect(store.labels.get(id)!.color).toBe('grey');
    recolorLabel(store, id, 'url(javascript:alert(1))');
    expect(store.labels.get(id)!.color).toBe('grey');
    recolorLabel(store, id, '#ff0000');
    expect(store.labels.get(id)!.color).toBe('#FF0000');
    // another client writes the map directly: what is read is checked again
    store.transact(() => store.labels.set('raw', { id: 'raw', name: 'Raw', color: EVIL_COLOR, order: 5 } as Label));
    store.transact(() => store.labels.set('bad', { id: 'bad', name: 3, color: 'blue', order: 6 } as unknown as Label));
    const raw = listLabels(store).find((l) => l.id === 'raw')!;
    expect(raw.color).toBe('grey');
    expect(listLabels(store).some((l) => l.id === 'bad')).toBe(false);
  });

  it('reads no value stored under another label\'s key, and no more than 30 labels', () => {
    const { store } = board();
    const bug = createLabel(store, 'Bug')!;
    // another client writes a value whose id is not its key: it would double or shadow Bug
    store.transact(() => store.labels.set('evil', { id: bug, name: 'Not bug', color: 'pink', order: -1 }));
    expect(listLabels(store).map((l) => l.name)).toEqual(['Bug']);
    store.transact(() => {
      for (let i = 0; i < 40; i++) store.labels.set(`x${i}`, { id: `x${i}`, name: `X${i}`, color: 'blue', order: i + 1 });
    });
    expect(listLabels(store)).toHaveLength(LIMITS.labels);
    expect(createLabel(store, 'one more')).toBeNull();
  });

  it('stores label names as text, whatever they contain', () => {
    const { store } = board();
    const id = createLabel(store, EVIL_TEXT)!;
    expect(store.labels.get(id)!.name).toBe(EVIL_TEXT.slice(0, LIMITS.labelName));
  });

  it('moves a label by writing only that label when the gap allows it', () => {
    const labels: Label[] = [
      { id: 'a', name: 'A', color: 'grey', order: 0 },
      { id: 'b', name: 'B', color: 'grey', order: 1 },
      { id: 'c', name: 'C', color: 'grey', order: 2 },
    ];
    expect(planLabelMove(labels, 'c', -1)).toEqual([{ id: 'c', order: 0.5 }]);
    expect(planLabelMove(labels, 'a', 1)).toEqual([{ id: 'a', order: 1.5 }]);
    expect(planLabelMove(labels, 'a', -1)).toEqual([]);
    expect(planLabelMove(labels, 'c', 1)).toEqual([]);
    expect(planLabelMove(labels, 'b', -1)).toEqual([{ id: 'b', order: -1 }]);
    // ties: everything gets a fresh order, only the ones that change are written
    const tied = labels.map((l) => ({ ...l, order: 0 }));
    expect(planLabelMove(tied, 'c', -1)).toEqual([{ id: 'c', order: 1 }, { id: 'b', order: 2 }]);
  });

  it('cleans a card\'s label ids: known ones, once each, at most ten', () => {
    const known = new Set(Array.from({ length: 12 }, (_, i) => `l${i}`));
    expect(cleanCardLabels(['l1', 'gone', 'l1', 3, 'l2'], known)).toEqual(['l1', 'l2']);
    expect(cleanCardLabels([...known], known)).toHaveLength(LIMITS.labelsPerCard);
    expect(toggleCardLabel(['l1'], 'l1', known)).toEqual([]);
    expect(toggleCardLabel(['l1'], 'l2', known)).toEqual(['l1', 'l2']);
    expect(toggleCardLabel([...known].slice(0, 10), 'l11', known)).toBeNull();
  });
});

describe('editing a card', () => {
  it('writes each edit as one transaction and one undo step, and stores the height it needs', () => {
    const { store, cards } = board();
    const [a] = cards;
    const bug = createLabel(store, 'Bug')!;
    const before = undoSteps(store);
    expect(editCard(store, a, { title: 'A longer title', desc: 'Details', owner: { id: 'u1', name: 'Lea Brandt' }, due: '2026-01-16', labels: [bug] })).toBe(true);
    expect(undoSteps(store)).toBe(before + 1);
    const card = bo(store, a);
    expect(card).toMatchObject({ text: 'A longer title', desc: 'Details', ownerId: 'u1', ownerName: 'Lea Brandt', due: '2026-01-16', labels: [bug] });
    expect(card.h).toBe(cardContentHeight(card, 264));
    expect(card.h).toBeGreaterThan(bo(store, cards[1]).h);
    store.undo.undo();
    expect(bo(store, a)).toMatchObject({ text: 'A' });
    expect(bo(store, a).due).toBeUndefined();
  });

  it('writes nothing for an edit that changes nothing', () => {
    const { store, cards } = board();
    const before = undoSteps(store);
    expect(editCard(store, cards[0], { title: 'A' })).toBe(false);
    expect(undoSteps(store)).toBe(before);
  });

  it('keeps the limits and refuses what is not valid', () => {
    const { store, cards } = board();
    const [a] = cards;
    expect(editCard(store, a, { title: '   ' })).toBe(false);
    expect(editCard(store, a, { title: 'x'.repeat(300) })).toBe(true);
    expect(bo(store, a).text).toHaveLength(LIMITS.title);
    expect(editCard(store, a, { title: 'one\ntwo' })).toBe(true);
    expect(bo(store, a).text).toBe('one two');
    expect(editCard(store, a, { desc: 'x'.repeat(LIMITS.description + 1) })).toBe(false);
    expect(editCard(store, a, { due: '2026-02-30' })).toBe(false);
    expect(editCard(store, a, { due: '16/01/2026' })).toBe(false);
    expect(editCard(store, a, { owner: { name: '   ' } })).toBe(false);
    expect(editCard(store, a, { owner: { name: 'y'.repeat(200) } })).toBe(true);
    expect(bo(store, a).ownerName).toHaveLength(80);
    expect(bo(store, a).ownerId).toBeUndefined();
    expect(editCard(store, a, { owner: null })).toBe(true);
    expect(bo(store, a).ownerName).toBeUndefined();
  });

  it('drops the ids of deleted labels on the next edit', () => {
    const { store, cards } = board();
    const [a] = cards;
    const bug = createLabel(store, 'Bug')!;
    const ui = createLabel(store, 'UI')!;
    editCard(store, a, { labels: [bug, ui, 'never-was'] });
    expect(bo(store, a).labels).toEqual([bug, ui]);
    deleteLabel(store, bug);
    // the card keeps the dangling id until it is edited
    expect(bo(store, a).labels).toEqual([bug, ui]);
    editCard(store, a, { title: 'A2' });
    expect(bo(store, a).labels).toEqual([ui]);
  });

  it('puts colours through kanbanColor and text in as given', () => {
    const { store, cards } = board();
    const [a] = cards;
    expect(editCard(store, a, { fill: EVIL_COLOR, title: EVIL_TEXT, owner: { name: EVIL_TEXT } })).toBe(true);
    expect(bo(store, a).fill).toBeUndefined();
    expect(bo(store, a).text).toBe(EVIL_TEXT);
    editCard(store, a, { fill: 'Teal' });
    expect(bo(store, a).fill).toBe('teal');
    editCard(store, a, { fill: null });
    expect(bo(store, a).fill).toBeUndefined();
  });

  it('writes nothing on a read-only board or to a locked card', () => {
    const { store, cards } = board();
    store.transact(() => store.update(cards[1], { locked: true }));
    expect(editCard(store, cards[1], { title: 'B2' })).toBe(false);
    store.setReadOnly(true);
    expect(editCard(store, cards[0], { title: 'A2' })).toBe(false);
    expect(createLabel(store, 'Bug')).toBeNull();
    expect(bo(store, cards[0]).text).toBe('A');
    expect(store.labels.size).toBe(0);
  });
});

describe('sticky to card and back', () => {
  it('keeps the id, the text, the description, the colour and the card fields, both ways, one undo step each', () => {
    const { store, lanes, container } = board();
    sticky(store, 's1', { text: 'Ship it\n\nBefore Friday,\nwith notes', fill: '#A3D2FF', ownerName: 'Lea', due: '2026-01-20', privateStep: 'step1', rotation: 0.2 });
    const r = stickiesToCards(store, ['s1'], () => ({ lane: lanes[1], index: 0 }), 'me');
    expect(r).toEqual({ done: ['s1'] });
    expect(undoSteps(store)).toBe(1);
    const card = bo(store, 's1');
    expect(card).toMatchObject({ type: 'card', text: 'Ship it', desc: 'Before Friday,\nwith notes', fill: 'blue', parent: lanes[1], ownerName: 'Lea', due: '2026-01-20', rotation: 0 });
    expect(card.privateStep).toBeUndefined();
    expect(store.containerLayout(container)!.cards.get(lanes[1])).toEqual(['s1']);
    expect(card.h).toBe(cardContentHeight(card, 264));

    const back = cardsToStickies(store, ['s1'], () => undefined);
    expect(back).toEqual(['s1']);
    expect(undoSteps(store)).toBe(2);
    const s = bo(store, 's1');
    expect(s).toMatchObject({ type: 'sticky', text: 'Ship it\n\nBefore Friday,\nwith notes', fill: '#A3D2FF', ownerName: 'Lea', due: '2026-01-20', desc: 'Before Friday,\nwith notes', w: 192, h: 192 });
    expect(s.rank).toBeUndefined();
    expect(s.parent).toBeUndefined();
    // placed where it was drawn
    const lane = store.geometry(store.get(lanes[1])!);
    expect(s.x).toBe(lane.x + KANBAN.lanePad);

    stickiesToCards(store, ['s1'], () => null, 'me');
    expect(bo(store, 's1')).toMatchObject({ type: 'card', text: 'Ship it', desc: 'Before Friday,\nwith notes', fill: 'blue', ownerName: 'Lea', w: LOOSE_CARD_W });
    store.undo.undo();
    store.undo.undo();
    expect(bo(store, 's1')).toMatchObject({ type: 'card', parent: lanes[1] });
    store.undo.undo();
    expect(bo(store, 's1')).toMatchObject({ type: 'sticky', text: 'Ship it\n\nBefore Friday,\nwith notes', privateStep: 'step1', rotation: 0.2 });
  });

  it('keeps comment threads on the object, and their pins follow the card', () => {
    const { store, lanes } = board();
    sticky(store, 's1');
    const comments = new Comments(new Y.Doc());
    const placed = store.placed(store.get('s1')!) as BaseObj;
    const tid = comments.addThread({ id: 'me', name: 'Me', color: '#326DD3' }, anchorFor({ x: placed.x + 10, y: placed.y + 10 }, placed), 'Note')!;
    stickiesToCards(store, ['s1'], () => ({ lane: lanes[0], index: 0 }), 'me');
    const get = (id: string) => store.getPlaced(id);
    const thread = comments.list().find((t) => t.id === tid)!;
    expect(thread.anchor.obj).toBe('s1');
    const onCard = anchorPosition(thread.anchor, get);
    const r = store.geometry(store.get('s1')!);
    expect(onCard.x).toBeGreaterThanOrEqual(r.x);
    expect(onCard.x).toBeLessThanOrEqual(r.x + r.w);
    expect(onCard.y).toBeGreaterThanOrEqual(r.y);
    // the card moves to another lane: the pin goes with it
    moveCards(store, ['s1'], lanes[2], 0);
    const moved = anchorPosition(thread.anchor, get);
    expect(moved.x - onCard.x).toBe(store.geometry(store.get('s1')!).x - r.x);
    cardsToStickies(store, ['s1'], () => undefined);
    expect(comments.list().find((t) => t.id === tid)!.anchor.obj).toBe('s1');
  });

  it('converts several at once into one lane, in the order given, as one undo step', () => {
    const { store, lanes, container, cards } = board();
    sticky(store, 's1', { text: 'One' });
    sticky(store, 's2', { text: 'Two' });
    stickiesToCards(store, ['s2', 's1'], () => ({ lane: lanes[0], index: 1 }), 'me');
    expect(undoSteps(store)).toBe(1);
    expect(store.containerLayout(container)!.cards.get(lanes[0])).toEqual([cards[0], 's2', 's1', cards[1]]);
  });

  it('refuses a description over the limit and writes nothing', () => {
    const { store } = board();
    sticky(store, 's1', { text: `Title\n${'x'.repeat(LIMITS.description + 1)}` });
    const r = stickiesToCards(store, ['s1'], () => null, 'me');
    expect(r.refused).toMatch(/4,000/);
    expect(bo(store, 's1').type).toBe('sticky');
  });

  it('turns a sticky colour into the nearest sticky colour when the card has another one', () => {
    const { store, cards } = board();
    editCard(store, cards[0], { fill: '#ff99cc' });
    cardsToStickies(store, cards.slice(0, 1), () => undefined);
    expect(bo(store, cards[0]).fill).toBe('#FFA3C4');
    // a card with no colour becomes a yellow sticky
    cardsToStickies(store, cards.slice(1), () => undefined);
    expect(bo(store, cards[1]).fill).toBe('#FFE16B');
  });

  it('does nothing on a read-only board', () => {
    const { store, cards } = board();
    sticky(store, 's1');
    store.setReadOnly(true);
    expect(stickiesToCards(store, ['s1'], () => null, 'me').done).toEqual([]);
    expect(cardsToStickies(store, cards, () => undefined)).toEqual([]);
    expect(kanbanFromStickies(store, ['s1'], { z: 'c0', createdBy: 'me' }).id).toBeNull();
    expect(bo(store, 's1').type).toBe('sticky');
  });
});

describe('private notes (docs/kanban.md: a hidden private sticky converts only for its author)', () => {
  it('leaves someone else\'s unrevealed private note a sticky, and converts the author\'s own', () => {
    const { store, lanes } = board();
    sticky(store, 'theirs', { privateStep: 'step1', createdBy: 'other', text: 'Secret' });
    sticky(store, 'mine', { privateStep: 'step1', createdBy: 'me', text: 'Mine' });
    const r = stickiesToCards(store, ['theirs', 'mine'], () => ({ lane: lanes[0], index: 0 }), 'me');
    expect(r.done).toEqual(['mine']);
    expect(store.get('theirs')).toMatchObject({ type: 'sticky', privateStep: 'step1', text: 'Secret' });
    // the author converts it
    expect(stickiesToCards(store, ['theirs'], () => null, 'other').done).toEqual(['theirs']);
  });

  it('converts it for anyone once revealed (the reveal clears privateStep)', () => {
    const { store } = board();
    sticky(store, 'theirs', { privateStep: 'step1', createdBy: 'other' });
    store.transact(() => store.update('theirs', { privateStep: undefined }));
    expect(stickiesToCards(store, ['theirs'], () => null, 'me').done).toEqual(['theirs']);
  });

  it('does not put it into a kanban made from a selection', () => {
    const store = new Store(new Y.Doc());
    sticky(store, 'theirs', { privateStep: 'step1', createdBy: 'other', x: 0, y: 0 });
    sticky(store, 'mine', { x: 300, y: 0 });
    const { id } = kanbanFromStickies(store, ['theirs', 'mine'], { z: 'c0', createdBy: 'me' });
    const layout = store.containerLayout(id!)!;
    expect(layout.cards.get(layout.lanes[0])).toEqual(['mine']);
    expect(store.get('theirs')).toMatchObject({ type: 'sticky', privateStep: 'step1' });
    expect(kanbanFromStickies(store, ['theirs'], { z: 'c1', createdBy: 'me' }).id).toBeNull();
  });
});

describe('a kanban from stickies', () => {
  it('makes the default lanes and puts the stickies in the first lane in reading order, as one undo step', () => {
    const store = new Store(new Y.Doc());
    sticky(store, 'b', { x: 300, y: 10, text: 'B' });
    sticky(store, 'a', { x: 0, y: 0, text: 'A' });
    sticky(store, 'c', { x: 0, y: 300, text: 'C' });
    const { id } = kanbanFromStickies(store, ['c', 'b', 'a'], { z: 'c0', createdBy: 'me' });
    expect(id).toBeTruthy();
    expect(undoSteps(store)).toBe(1);
    const layout = store.containerLayout(id!)!;
    expect(layout.lanes.map((l) => (store.get(l) as BaseObj).name)).toEqual(['To do', 'Doing', 'Done']);
    expect(layout.cards.get(layout.lanes[0])!.map((c) => bo(store, c).text)).toEqual(['A', 'B', 'C']);
    expect(store.get(id!)).toMatchObject({ x: 0, y: 0, h: layout.h });
    store.undo.undo();
    expect(store.get(id!)).toBeUndefined();
    expect(bo(store, 'a').type).toBe('sticky');
  });
});

describe('labels under concurrent edits (docs/kanban.md, Concurrent edits)', () => {
  function pair() {
    const a = new Store(new Y.Doc());
    const b = new Store(new Y.Doc());
    a.doc.clientID = 1;
    b.doc.clientID = 2;
    const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
    a.transact(() => [container, ...lanes].forEach((o) => a.create(o)));
    const card = addCard(a, lanes[0].id, 'Card', { createdBy: 'me' })!;
    const bug = createLabel(a, 'Bug')!;
    const ui = createLabel(a, 'UI')!;
    sync(a, b);
    return { a, b, card, bug, ui };
  }
  function sync(a: Store, b: Store) {
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  }
  const names = (s: Store) => listLabels(s).map((l) => `${l.name}:${l.color}`);

  it('keeps both labels two people create at once', () => {
    const { a, b } = pair();
    createLabel(a, 'Docs');
    createLabel(b, 'Chore');
    sync(a, b);
    expect(names(a)).toEqual(names(b));
    expect(listLabels(a).map((l) => l.name).sort()).toEqual(['Bug', 'Chore', 'Docs', 'UI']);
  });

  it('a label is one value: a rename and a recolour of the same label at once keep one of the two, the same everywhere', () => {
    const { a, b, bug } = pair();
    renameLabel(a, bug, 'Defect');
    recolorLabel(b, bug, 'pink');
    sync(a, b);
    expect(names(a)).toEqual(names(b));
    const l = listLabels(a).find((x) => x.id === bug)!;
    expect(['Defect:yellow', 'Bug:pink']).toContain(`${l.name}:${l.color}`);
  });

  it('edits to different labels at once both land, and a move writes only the label it moves', () => {
    const { a, b, bug, ui } = pair();
    renameLabel(a, bug, 'Defect');
    moveLabel(b, ui, -1);
    sync(a, b);
    expect(names(a)).toEqual(names(b));
    expect(listLabels(a).map((l) => l.name)).toEqual(['UI', 'Defect']);
  });

  it('a label deleted while someone puts it on a card: the card keeps the id, draws nothing for it and drops it when edited', () => {
    const { a, b, card, bug, ui } = pair();
    deleteLabel(a, bug);
    editCard(b, card, { labels: [bug, ui] });
    sync(a, b);
    expect((a.get(card) as BaseObj).labels).toEqual([bug, ui]);
    expect(listLabels(a).map((l) => l.id)).toEqual([ui]);
    editCard(a, card, { title: 'Card 2' });
    sync(a, b);
    expect((b.get(card) as BaseObj).labels).toEqual([ui]);
  });

  it('labels on a card are one array: two people toggling different labels at once keep one toggle (as drafted)', () => {
    const { a, b, card, bug, ui } = pair();
    editCard(a, card, { labels: [bug] });
    editCard(b, card, { labels: [ui] });
    sync(a, b);
    const la = (a.get(card) as BaseObj).labels;
    expect(la).toEqual((b.get(card) as BaseObj).labels);
    // last writer wins on the whole array: one of the two toggles is lost, the same on both sides
    expect([[bug], [ui]]).toContainEqual(la);
  });

  it('a conversion and a description edit at once both apply', () => {
    const { a, b, card } = pair();
    cardsToStickies(a, [card], () => undefined);
    editCard(b, card, { desc: 'Written meanwhile' });
    sync(a, b);
    expect(a.get(card)).toMatchObject({ type: 'sticky', desc: 'Written meanwhile' });
    expect(b.get(card)).toMatchObject({ type: 'sticky', desc: 'Written meanwhile' });
  });
});

describe('a label name in the store is data', () => {
  it('a card read with a label whose stored colour is not one keeps drawing with the default', () => {
    const { store, cards } = board();
    store.transact(() => store.labels.set('x', { id: 'x', name: 'X', color: EVIL_COLOR, order: 0 }));
    editCard(store, cards[0], { labels: ['x'] });
    expect(bo(store, cards[0]).labels).toEqual(['x']);
    expect(listLabels(store)[0].color).toBe('grey');
  });
});

// keeps the unused helper type honest
export type { Id };
