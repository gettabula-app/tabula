import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { toggleItem } from '../src/checklist';
import {
  addCard, cardFields, cardsToStickies, editCard, newKanban, stickiesToCards,
} from '../src/containers';
import { instantiate, toTemplateContent, validateContent } from '../src/custom-templates';
import { Flow } from '../src/flow';
import { applyRestore, planRestore } from '../src/history';
import { sanitizeImportedObjects } from '../src/import-sanitize';
import { gatherCopyObjects } from '../src/private-select';
import { safeObj } from '../src/safe-obj';
import { Store } from '../src/store';
import type { BaseObj, ChecklistItem, Obj } from '../src/types';

// docs/kanban.md, Sticky to card and back, Templates, Export and import; po/specs/12-kanban-checklist.md, "How it is stored":
// a card's checklist survives every path that rewrites a card, one round trip per path, and copies get new item ids. Each
// path runs the code that would strip the field (paste and duplicate through BoardApp, templates through validateContent).

const LIST: ChecklistItem[] = [
  { id: 'k1', text: 'buy paint', done: false },
  { id: 'k2', text: 'call the painter', done: true },
];
const pairs = (list: ChecklistItem[] | undefined) => list?.map((i) => [i.text, i.done]);
/** What a file, a clipboard or the server holds: the value as JSON. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const card = (id: string, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'card', x: 100, y: 100, w: 240, h: 72, rotation: 0, z: 'a1', text: 'Paint the hall', createdBy: 'me', updatedAt: 0, checklist: LIST, ...extra,
} as BaseObj);
const sticky = (id: string, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'sticky', x: 2000, y: 0, w: 192, h: 192, rotation: 0, z: 'a2', fill: '#A3D2FF', text: 'Ship it', createdBy: 'me', updatedAt: 0, checklist: LIST, ...extra,
} as BaseObj);

function board() {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  store.undo.clear();
  return { store, lanes: lanes.map((l) => l.id) };
}
const bo = (store: Store, id: string) => store.get(id) as BaseObj;
const undoSteps = (store: Store) => (store.undo as unknown as { undoStack: unknown[] }).undoStack.length;

/** The parts of BoardApp that copy, paste and duplicate read, with the real methods on top. */
function appFor(store: Store, selection: string[] = []) {
  return {
    store,
    user: { id: 'me' },
    selection,
    flow: { isHidden: () => false },
    readOnly: false,
    lastPointer: { x: 0, y: 0 },
    r: { viewport: () => ({ x: -1000, y: -1000, w: 4000, h: 4000 }) },
    notify() {},
    announce() {},
    resetScopeSelection() {},
    insertObjects: BoardApp.prototype.insertObjects,
  } as unknown as BoardApp;
}

describe('sticky to card and back', () => {
  it('keeps the checklist with its ids both ways, and a card turned back into a sticky keeps it', () => {
    const { store, lanes } = board();
    store.transact(() => store.create(sticky('s1')));
    store.undo.clear();
    expect(stickiesToCards(store, ['s1'], () => ({ lane: lanes[0], index: 0 }), 'me').refused).toBeUndefined();
    expect(bo(store, 's1')).toMatchObject({ type: 'card', checklist: LIST });
    cardsToStickies(store, ['s1'], () => undefined);
    expect(bo(store, 's1')).toMatchObject({ type: 'sticky', checklist: LIST });
    stickiesToCards(store, ['s1'], () => ({ lane: lanes[0], index: 0 }), 'me');
    expect(bo(store, 's1').checklist).toEqual(LIST);
  });
});

describe('duplicate', () => {
  it('gives the copy new item ids with the same text and ticks, and leaves the card as it was', () => {
    const { store } = board();
    store.transact(() => store.create(card('c1')));
    store.undo.clear();
    BoardApp.prototype.duplicate.call(appFor(store, ['c1']));
    const copy = [...store.cache.values()].find((o) => o.type === 'card' && o.id !== 'c1') as BaseObj;
    expect(copy).toBeDefined();
    expect(pairs(copy.checklist)).toEqual(pairs(LIST));
    expect(copy.checklist!.map((i) => i.id)).not.toContain('k1');
    expect(copy.checklist!.map((i) => i.id)).not.toContain('k2');
    expect(new Set(copy.checklist!.map((i) => i.id)).size).toBe(2);
    expect(bo(store, 'c1').checklist).toEqual(LIST);
  });
});

describe('copy and paste', () => {
  it('pastes the clipboard with new item ids, read the way pasteText reads it', () => {
    const { store } = board();
    store.transact(() => store.create(card('c1')));
    store.undo.clear();
    const clipboard = JSON.stringify({ driftboard: 1, objects: gatherCopyObjects(store, { isHidden: () => false }, ['c1']) });
    BoardApp.prototype.pasteText.call(appFor(store), clipboard);
    const pasted = [...store.cache.values()].find((o) => o.type === 'card' && o.id !== 'c1') as BaseObj;
    expect(pasted).toBeDefined();
    expect(pairs(pasted.checklist)).toEqual(pairs(LIST));
    expect(pasted.checklist!.map((i) => i.id)).not.toContain('k1');
    expect(bo(store, 'c1').checklist).toEqual(LIST);
  });
});

describe('templates', () => {
  it('keeps a card checklist in a saved template, gives it new item ids on each use, and drops it from a sticky', () => {
    const content = toTemplateContent([card('c1'), sticky('s1', { x: 400 })], [], { includeSteps: false });
    const checked = validateContent(plain(content));
    expect(pairs((checked.objects.find((o) => o.type === 'card') as BaseObj).checklist)).toEqual(pairs(LIST));
    expect(checked.objects.find((o) => o.type === 'sticky')).not.toHaveProperty('checklist');
    const first = instantiate(checked, { x: 0, y: 0 }, 'me').objects.find((o) => o.type === 'card') as BaseObj;
    const second = instantiate(checked, { x: 0, y: 0 }, 'me').objects.find((o) => o.type === 'card') as BaseObj;
    expect(pairs(first.checklist)).toEqual(pairs(LIST));
    expect(first.checklist!.map((i) => i.id)).not.toContain('k1');
    expect(first.checklist!.map((i) => i.id)).not.toEqual(second.checklist!.map((i) => i.id));
  });
});

describe('JSON export and import', () => {
  it('keeps the checklist on a card, a tracker-linked card and a sticky, and takes it off a shape', () => {
    const tracked = card('t1', { extProvider: 'tabula', extKey: 'TAB-1' } as Partial<BaseObj>);
    const shape = { id: 'sh', type: 'shape', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a0', kind: 'rect', checklist: LIST } as unknown as Obj;
    const [plainCard, trackedCard, stickyCopy, shapeCopy] = sanitizeImportedObjects(plain([card('c1'), tracked, sticky('s1'), shape]), 'me') as BaseObj[];
    expect(plainCard.checklist).toEqual(LIST);
    expect(trackedCard.checklist).toEqual(LIST);
    expect(trackedCard).not.toHaveProperty('extKey');
    expect(stickyCopy.checklist).toEqual(LIST);
    expect(shapeCopy).not.toHaveProperty('checklist');
  });

  it('cleans an imported checklist: one line of text, and an item with no text is left out', () => {
    const dirty = card('c1', { checklist: [{ id: 'k1', text: ' two\nlines ', done: true }, { id: 'k2', text: '   ', done: false }, 4] as unknown as ChecklistItem[] });
    const [out] = sanitizeImportedObjects(plain([dirty]), 'me') as BaseObj[];
    expect(out.checklist).toEqual([{ id: 'k1', text: 'two lines', done: true }]);
  });
});

describe('version restore', () => {
  it('brings the checklist of a version back, and a version without one takes it away', () => {
    const live = new Store(new Y.Doc());
    const older = new Store(new Y.Doc());
    const bare = new Store(new Y.Doc());
    const { checklist: _none, ...noList } = card('c1');
    live.transact(() => live.create(card('c1')));
    older.transact(() => older.create(card('c1', { checklist: [{ id: 'k9', text: 'old item', done: false }] })));
    bare.transact(() => bare.create(noList as BaseObj));
    applyRestore(live, planRestore(live, older, { isHidden: () => false }));
    expect(bo(live, 'c1').checklist).toEqual([{ id: 'k9', text: 'old item', done: false }]);
    applyRestore(live, planRestore(live, bare, { isHidden: () => false }));
    expect(bo(live, 'c1').checklist).toBeUndefined();
  });
});

describe('Markdown summary', () => {
  const summary = (store: Store) => new Flow({
    store, user: { id: 'me', name: 'me', color: '#000' }, r: { invalidateAll() {}, setOverlay() {} }, emit() {}, participants: () => [],
  } as never).summaryMarkdown();

  it('writes the checklist as an indented task list under its card, ticked items as [x]', () => {
    const { store, lanes } = board();
    const id = addCard(store, lanes[0], 'Paint the hall', { createdBy: 'me' })!;
    store.transact(() => store.update(id, { checklist: LIST }));
    expect(summary(store)).toContain('- Paint the hall\n  - [ ] buy paint\n  - [x] call the painter');
  });

  it('escapes an item the way a title is escaped', () => {
    const { store, lanes } = board();
    const id = addCard(store, lanes[0], 'Escape', { createdBy: 'me' })!;
    store.transact(() => store.update(id, { checklist: [{ id: 'e1', text: '*bold* [x] item', done: false }] }));
    expect(summary(store)).toContain('  - [ ] \\*bold\\* \\[x\\] item');
  });
});

describe('the render path (safeObj)', () => {
  it('keeps a card checklist as cleaned, leaves out an item with a bad id, and gives the same result on every draw', () => {
    const dirty = card('c1', { checklist: [{ id: 'bad id', text: 'x', done: true }, { id: 'k2', text: 'two\nlines', done: false }] as unknown as ChecklistItem[] });
    const once = safeObj(dirty);
    expect(once.checklist).toEqual([{ id: 'k2', text: 'two lines', done: false }]);
    expect(safeObj(dirty).checklist).toEqual(once.checklist);
  });

  it('takes the checklist off a shape', () => {
    expect(safeObj({ ...card('s1'), type: 'shape', kind: 'rect' } as unknown as Obj)).not.toHaveProperty('checklist');
  });
});

describe('the card patch and undo', () => {
  it('a tick is one undo step, and undo puts the previous list back', () => {
    const { store, lanes } = board();
    const id = addCard(store, lanes[0], 'Paint the hall', { createdBy: 'me' })!;
    expect(editCard(store, id, { checklist: LIST })).toBe(true);
    const steps = undoSteps(store);
    const previous = bo(store, id).checklist;
    expect(editCard(store, id, { checklist: toggleItem(bo(store, id).checklist!, 'k1') })).toBe(true);
    expect(undoSteps(store)).toBe(steps + 1);
    expect(bo(store, id).checklist!.map((i) => i.done)).toEqual([true, true]);
    store.undo.undo();
    expect(bo(store, id).checklist).toEqual(previous);
  });

  it('refuses a list that breaks a limit and writes nothing, with no undo step', () => {
    const { store, lanes } = board();
    const id = addCard(store, lanes[0], 'Paint the hall', { createdBy: 'me' })!;
    editCard(store, id, { checklist: LIST });
    const steps = undoSteps(store);
    const tooMany = Array.from({ length: 51 }, (_, k) => ({ id: `i${k}`, text: 'a', done: false }));
    expect(editCard(store, id, { checklist: tooMany })).toBe(false);
    expect(editCard(store, id, { checklist: [{ id: 'x', text: 'a'.repeat(201), done: false }] })).toBe(false);
    expect(bo(store, id).checklist).toEqual(LIST);
    expect(undoSteps(store)).toBe(steps);
  });

  it('writes nothing for the same list, clears with null or an empty list', () => {
    const { store, lanes } = board();
    const id = addCard(store, lanes[0], 'Paint the hall', { createdBy: 'me' })!;
    editCard(store, id, { checklist: LIST });
    expect(editCard(store, id, { checklist: LIST })).toBe(false);
    expect(editCard(store, id, { checklist: null })).toBe(true);
    expect(bo(store, id)).not.toHaveProperty('checklist');
    editCard(store, id, { checklist: LIST });
    expect(editCard(store, id, { checklist: [] })).toBe(true);
    expect(bo(store, id)).not.toHaveProperty('checklist');
  });

  it('writes nothing on a read-only board or to a locked card', () => {
    const { store, lanes } = board();
    const id = addCard(store, lanes[0], 'Paint the hall', { createdBy: 'me' })!;
    store.update(id, { locked: true });
    expect(editCard(store, id, { checklist: LIST })).toBe(false);
    store.update(id, { locked: undefined });
    store.setReadOnly(true);
    expect(editCard(store, id, { checklist: LIST })).toBe(false);
    store.setReadOnly(false);
    expect(bo(store, id).checklist).toBeUndefined();
  });

  it('does not change the card height', () => {
    const { store, lanes } = board();
    const id = addCard(store, lanes[0], 'Paint the hall', { createdBy: 'me' })!;
    const card0 = bo(store, id);
    expect(cardFields(store, card0, { checklist: LIST })?.h).toBe(cardFields(store, card0, {})?.h);
  });
});
