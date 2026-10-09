import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { Renderer } from '../src/render';
import { Store } from '../src/store';
import { addCard, addCardRefusal, addLane, newKanban } from '../src/containers';
import { CardInput } from '../src/ui/kanban';
import { TEMPLATES, insertCustomTemplate, insertTemplate, type TemplateDef } from '../src/templates';
import type { CustomTemplate } from '../src/custom-templates';
import { KANBAN, LIMITS, ranksBetween } from '../shared/containers';
import { EMPTY_FILTER, addRow, laneCards, laneMenuRect, type FilterChip } from '../src/ui/kanban-logic';
import { kanbanHeaderControls, objectMarkup, type HeaderControls } from '../src/markup';
import type { BaseObj, Id, Point } from '../src/types';
import { createLabel, deleteLabel, listLabels, renameLabel } from '../src/labels';

// filtering must read the board's labels once per labels change, not once per card: count the reads
vi.mock('../src/labels', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/labels')>();
  return { ...m, listLabels: vi.fn<typeof m.listLabels>(m.listLabels) };
});

// docs/kanban.md, slice 2: BoardApp's kanban behaviour (pointer, hit testing, creating, deleting), on a BoardApp
// that has the real store, renderer and methods but no page around it.

class FakeEl {
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  classList = { add() {}, remove() {}, toggle() {} };
  className = '';
  nextSibling = null;
  firstChild = null;
  innerHTML = '';
  append() {}
  appendChild() {}
  insertBefore() {}
  remove() {}
  setAttribute() {}
  removeAttribute() {}
  setPointerCapture() {}
  querySelector() {
    return new FakeEl();
  }
  getBoundingClientRect() {
    return { width: 1600, height: 1200, left: 0, top: 0 };
  }
  getContext() {
    return null;
  }
}

type Harness = BoardApp & Record<string, unknown>;

const commentsReadOnly = { value: false };
const openCard = vi.fn<(id: Id, focus?: string) => void>();
const storage = new Map<string, string>();

function harness() {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  const ids = ['A', 'B', 'C'].map((t) => addCard(store, lanes[0].id, t, { createdBy: 'me' })!);
  store.undo.clear();
  const r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
  r.setCamera({ x: -100, y: -100, zoom: 1 });
  const app = Object.create(BoardApp.prototype) as Harness;
  const notify = vi.fn<(msg: string) => void>();
  const startInput = vi.fn<(lane: Id) => void>();
  Object.assign(app, {
    store, r, selection: [], tool: { kind: 'select' }, drag: null, longPress: null, pendingFrame: 0, queuedFn: null,
    kbMoving: null, cursorTimer: 1, listeners: new Map(), spaceDown: false, lastPointer: { x: 0, y: 0 }, notify,
    user: { id: 'me', name: 'Me', color: '#326DD3' },
    conn: { awareness: { setLocalStateField() {}, getStates: () => new Map(), clientID: 1 }, comments: { readOnly: () => commentsReadOnly.value, list: () => [] } },
    cardInput: { start: startInput, stop() {} },
    announce: vi.fn<(msg: string) => void>(),
    editor: { active: false, commit() {}, start() {} },
    flow: { handleClick: () => false, isHidden: () => false, isVoting: () => false, activeStep: () => null },
    isPinching: () => false,
    openCard: openCard,
    openKanbanMenu: vi.fn<(kind: string, id: Id, at: unknown) => void>(),
    role: null,
  });
  Object.assign(app.conn, { id: 'board1' });
  // as the constructor wires them
  r.filterChips = (id) => app.filterChipsOf(id);
  r.dimmed = (o) => app.isDimmed(o);
  app.watchLabels();
  return { app, store, r, notify, startInput, container: container.id, lanes: lanes.map((l) => l.id), ids };
}

/** Client coordinates of a world point (the fake canvas sits at the page's top-left). */
const client = (r: Renderer, p: Point) => { const s = r.toScreen(p); return { clientX: s.x, clientY: s.y }; };
const pointer = (r: Renderer, p: Point, type = 'pointerdown') => ({ type, pointerId: 1, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {}, ...client(r, p) });
const call = (app: Harness, name: string, ...args: unknown[]) => (app[name] as (...a: unknown[]) => unknown).apply(app, args);
const titles = (store: Store, container: Id, lane: Id) => (store.containerLayout(container)!.cards.get(lane) ?? []).map((id) => (store.get(id) as BaseObj).text);
const centre = (store: Store, id: Id, fy = 0.5) => {
  const r = store.geometry(store.get(id)!);
  return { x: r.x + r.w / 2, y: r.y + r.h * fy };
};

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl(), activeElement: null });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem() {}, removeItem() {} });
  storage.clear();
  commentsReadOnly.value = false;
  openCard.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

/** Presses on `from`, drags to `to` in steps, and gives the drag back without releasing. */
function dragCard(app: Harness, r: Renderer, from: Point, to: Point) {
  call(app, 'onDown', pointer(r, from));
  for (let i = 1; i <= 4; i++) call(app, 'onMove', pointer(r, { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, 'pointermove'));
}

describe('a card drag', () => {
  it('drops on pointerup in one undo step', () => {
    const { app, store, r, container, lanes, ids } = harness();
    dragCard(app, r, centre(store, ids[0]), centre(store, lanes[1], 0.3));
    call(app, 'onUp', pointer(r, centre(store, lanes[1], 0.3), 'pointerup'));
    expect(titles(store, container, lanes[1])).toEqual(['A']);
    store.undo.undo();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
  });

  it('drops nothing when the pointer is cancelled', () => {
    const { app, store, r, container, lanes, ids } = harness();
    dragCard(app, r, centre(store, ids[0]), centre(store, lanes[1], 0.3));
    call(app, 'onCancel', pointer(r, centre(store, lanes[1], 0.3), 'pointercancel'));
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
    expect(app.dragging).toBe(false);
    expect(r.overlay.kanban).toBeNull();
  });

  it('moves a card whose lane was deleted within the lane that shows it, even when that lane is at its limit', () => {
    const { app, store, r, container, lanes } = harness();
    store.transact(() => {
      store.remove(store.containerLayout(container)!.cards.get(lanes[0])!);
      ranksBetween(null, null, LIMITS.cardsPerLane - 1, lanes[0]).forEach((rank, i) =>
        store.create({ id: `k${i}`, type: 'card', parent: lanes[0], rank, text: `k${i}`, x: 0, y: 0, w: 264, h: 8, rotation: 0, z: 'a0' } as BaseObj));
      store.create({ id: 'stray', type: 'card', parent: 'gone', rank: 'a0@gone', text: 'stray', x: 0, y: 0, w: 264, h: 8, rotation: 0, z: 'a0' } as BaseObj);
    });
    expect(titles(store, container, lanes[0]).at(-1)).toBe('stray');
    dragCard(app, r, centre(store, 'stray'), centre(store, 'k0', 0.1));
    call(app, 'onUp', pointer(r, centre(store, 'k0', 0.1), 'pointerup'));
    expect(titles(store, container, lanes[0])[0]).toBe('stray');
  });
});

describe('the add-card row', () => {
  const rowPoint = (store: Store, container: Id, lane: Id) => {
    const L = store.containerLayout(container)!;
    const row = addRow(L.rects.get(lane)!, laneCards(L, lane));
    return { x: row.x + 40, y: row.y + row.h / 2 };
  };

  it('opens the input at full detail', () => {
    const { app, store, r, startInput, container, lanes } = harness();
    const p = rowPoint(store, container, lanes[0]);
    expect(app.hit(p)?.id).toBe(lanes[0]);
    expect(call(app, 'laneRegion', lanes[0], p)).toBe('add');
    call(app, 'onDown', pointer(r, p));
    expect(startInput).toHaveBeenCalledWith(lanes[0]);
  });

  it('is plain lane body below zoom 0.4, where it is not drawn', () => {
    const { app, store, r, startInput, container, lanes } = harness();
    r.setCamera({ zoom: 0.3 });
    const p = rowPoint(store, container, lanes[0]);
    expect(call(app, 'laneRegion', lanes[0], p)).toBe('body');
    call(app, 'onDown', pointer(r, p));
    expect(startInput).not.toHaveBeenCalled();
  });
});

describe('what a click hits', () => {
  it('finds a card over its lane, a lane over the container, and the container by its header', () => {
    const { app, store, container, lanes, ids } = harness();
    expect(app.hit(centre(store, ids[1]))?.id).toBe(ids[1]);
    expect(app.hit(centre(store, lanes[0], 0.05))?.id).toBe(lanes[0]);
    expect(app.hit(centre(store, lanes[1], 0.7))?.id).toBe(lanes[1]);
    expect(app.hit({ x: 30, y: 20 })?.id).toBe(container);
  });

  it('gives a click on a card’s bottom edge to that card, not to the one below, at any zoom', () => {
    const { app, store, r, ids } = harness();
    for (const zoom of [1, 0.6, 0.3, 0.1]) {
      r.setCamera({ zoom });
      const a = store.geometry(store.get(ids[0])!);
      expect(app.hit({ x: a.x + 20, y: a.y + a.h - 0.5 })?.id).toBe(ids[0]);
      // in the gap between two cards: the lane
      expect(app.hit({ x: a.x + 20, y: a.y + a.h + KANBAN.cardGap / 2 })?.type).toBe('lane');
    }
  });

  it('follows a moved container: its card hit box moves with it', () => {
    const { app, store, container, ids } = harness();
    const before = store.geometry(store.get(ids[0])!);
    store.transact(() => store.update(container, { x: 500, y: 40 }));
    expect(app.hit({ x: before.x + 510, y: before.y + 50 })?.id).toBe(ids[0]);
  });
});

describe('the kanban tool', () => {
  it('puts the kanban’s top-left corner where a drag started, whichever way it went', () => {
    const { app, store } = harness();
    app.setTool({ kind: 'kanban' });
    expect(app.tool.kind).toBe('kanban');
    const start = { x: 400, y: 300 };
    const e = { altKey: true, shiftKey: false };
    call(app, 'finishCreate', { mode: 'create', start, tool: { kind: 'kanban' } }, { x: 100, y: 120 }, e);
    const made = [...store.cache.values()].filter((o) => o.type === 'container').find((o) => (o as BaseObj).x !== 0) as BaseObj;
    expect([made.x, made.y]).toEqual([400, 300]);
  });
});

describe('deleting', () => {
  it('moves a deleted lane’s cards to its neighbour in one undo step', () => {
    const { app, store, container, lanes } = harness();
    app.setSelection([lanes[0]]);
    app.deleteSelection();
    expect(titles(store, container, lanes[1])).toEqual(['A', 'B', 'C']);
    expect(store.get(lanes[0])).toBeUndefined();
    store.undo.undo();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
    expect(titles(store, container, lanes[1])).toEqual([]);
  });

  it('deletes a kanban with its lanes and cards, and undo brings them all back', () => {
    const { app, store, container, lanes, ids } = harness();
    app.setSelection([container]);
    app.deleteSelection();
    for (const id of [container, ...lanes, ...ids]) expect(store.get(id)).toBeUndefined();
    store.undo.undo();
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
  });

  it('refuses with a message when a locked card would be deleted or moved', () => {
    const { app, store, notify, container, lanes, ids } = harness();
    store.transact(() => store.update(ids[1], { locked: true }));
    app.setSelection([lanes[0]]);
    app.deleteSelection();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('locked'));
    app.setSelection([container]);
    app.deleteSelection();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
    expect(store.get(container)).toBeDefined();
  });
});

// ---------------------------------------------------------------- slice 3: cards

/** A sticky beside the kanban, or over one of its lanes. */
function addSticky(store: Store, id: Id, at: Point, text = 'Note') {
  store.transact(() => store.create({ id, type: 'sticky', x: at.x - 96, y: at.y - 96, w: 192, h: 192, rotation: 0, z: 'a5', fill: '#FFE16B', text, createdBy: 'me', updatedAt: 0 } as BaseObj));
}
const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, code: '', target: null, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, ...extra });
const press = (app: Harness, k: string, extra: Record<string, unknown> = {}) => {
  const listeners: ((e: unknown) => void)[] = [];
  vi.stubGlobal('window', { addEventListener: (t: string, fn: (e: unknown) => void) => { if (t === 'keydown') listeners.push(fn); }, removeEventListener() {} });
  Object.assign(app, { lifetime: new AbortController() });
  call(app, 'bindKeys');
  listeners.forEach((fn) => fn(key(k, extra)));
};

describe('creating and converting kanbans', () => {
  it('lets an editor choose the Kanban tool and create a board', () => {
    const { app, store } = harness();
    app.setTool({ kind: 'kanban' });
    expect(app.tool.kind).toBe('kanban');
    const id = app.createKanban({ x: 3000, y: 3000 });
    expect(store.get(id!)?.type).toBe('container');
  });

  it('makes a kanban from the selected stickies', () => {
    const { app, store } = harness();
    addSticky(store, 's1', { x: 3000, y: 3000 });
    addSticky(store, 's2', { x: 3300, y: 3000 });
    app.setSelection(['s1', 's2']);
    const id = app.makeKanbanFromSelection();
    expect(store.get(id!)?.type).toBe('container');
    expect(store.get('s1')!.type).toBe('card');
  });

  it('turns a sticky away from a lane into a loose card', () => {
    const { app, store } = harness();
    addSticky(store, 's1', { x: 3000, y: 3000 });
    expect(app.canTurnIntoCards(['s1'])).toBe(true);
    expect(app.turnIntoCards(['s1'])).toBe(true);
    expect(store.get('s1')).toMatchObject({ type: 'card' });
    expect(store.isLaidOut(store.get('s1')!)).toBe(false);
  });

  it('keeps creation and conversion unavailable on a read-only board', () => {
    const { app, store } = harness();
    addSticky(store, 's1', { x: 3000, y: 3000 });
    addSticky(store, 's2', { x: 3300, y: 3000 });
    store.setReadOnly(true);
    app.setTool({ kind: 'kanban' });
    app.setSelection(['s1', 's2']);
    expect(app.tool.kind).toBe('select');
    expect(app.createKanban({ x: 0, y: 0 })).toBeNull();
    expect(app.makeKanbanFromSelection()).toBeNull();
    expect(app.canTurnIntoCards()).toBe(false);
    expect(app.turnIntoCards()).toBe(false);
    expect(store.get('s1')!.type).toBe('sticky');
  });
});

describe('opening a card', () => {
  it('opens the dialog on double-click and on Enter, for editors', () => {
    const { app, store, r, ids } = harness();
    call(app, 'onDblClick', { ...client(r, centre(store, ids[1])) });
    expect(openCard).toHaveBeenLastCalledWith(ids[1], undefined);
    expect(app.selection).toEqual([ids[1]]);
    app.setSelection([ids[0]]);
    press(app, 'Enter');
    expect(openCard).toHaveBeenLastCalledWith(ids[0], undefined);
  });

  it('opens it for commenters (read-only in the dialog), and not for viewers', () => {
    const { app, store, r, ids } = harness();
    store.setReadOnly(true);
    call(app, 'onDblClick', { ...client(r, centre(store, ids[1])) });
    expect(openCard).toHaveBeenCalledTimes(1);
    commentsReadOnly.value = true;
    call(app, 'onDblClick', { ...client(r, centre(store, ids[1])) });
    expect(app.openCardDialog(ids[0])).toBe(false);
    expect(openCard).toHaveBeenCalledTimes(1);
  });
});

describe('K', () => {
  it('turns a sticky over a lane into a card there, and the card back into a sticky, one undo step each', () => {
    const { app, store, container, lanes } = harness();
    addSticky(store, 's1', centre(store, lanes[2], 0.3), 'Title\n\nMore');
    store.undo.clear();
    app.setSelection(['s1']);
    press(app, 'k');
    expect(store.get('s1')).toMatchObject({ type: 'card', text: 'Title', desc: 'More', parent: lanes[2] });
    expect(store.containerLayout(container)!.cards.get(lanes[2])).toEqual(['s1']);
    expect(app.selection).toEqual(['s1']);
    press(app, 'k');
    expect(store.get('s1')).toMatchObject({ type: 'sticky', text: 'Title\n\nMore' });
    store.undo.undo();
    expect(store.get('s1')).toMatchObject({ type: 'card' });
    store.undo.undo();
    expect(store.get('s1')).toMatchObject({ type: 'sticky', text: 'Title\n\nMore' });
  });

  it('does nothing on a read-only board', () => {
    const { app, store, lanes } = harness();
    addSticky(store, 's1', centre(store, lanes[2], 0.3));
    store.setReadOnly(true);
    app.setSelection(['s1']);
    press(app, 'k');
    expect(store.get('s1')!.type).toBe('sticky');
  });
});

describe('dropping a sticky on a lane', () => {
  it('moves it, then makes it a card at the drop place as its own undo step', () => {
    const { app, store, r, container, lanes, ids } = harness();
    addSticky(store, 's1', { x: 2000, y: 200 });
    store.undo.clear();
    const from = centre(store, 's1');
    const to = centre(store, ids[1], 0.3);
    call(app, 'onDown', pointer(r, from));
    for (let i = 1; i <= 4; i++) call(app, 'onMove', pointer(r, { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, 'pointermove'));
    expect(r.overlay.kanban?.line).toBeTruthy();
    call(app, 'onUp', pointer(r, to, 'pointerup'));
    expect(r.overlay.kanban?.line).toBeFalsy();
    expect(store.get('s1')).toMatchObject({ type: 'card', parent: lanes[0] });
    expect(store.containerLayout(container)!.cards.get(lanes[0])).toEqual([ids[0], 's1', ids[1], ids[2]]);
    store.undo.undo();
    expect(store.get('s1')!.type).toBe('sticky');
  });
});

describe('someone else\'s private notes during a running private step', () => {
  function withPrivate() {
    const h = harness();
    // as Flow decides it (src/flow.ts): a note of a private step that is not revealed is hidden from everyone but its author
    Object.assign(h.app.flow, { isHidden: (o: BaseObj) => !!o.privateStep && o.createdBy !== 'me' });
    h.store.transact(() => h.store.create({ id: 'secret', type: 'sticky', x: 3000, y: 3000, w: 192, h: 192, rotation: 0, z: 'a6', fill: '#FFE16B', text: 'Secret', privateStep: 'step1', createdBy: 'other', updatedAt: 0 } as BaseObj));
    addSticky(h.store, 'mine', { x: 3300, y: 3000 }, 'Mine');
    return h;
  }

  it('Cmd+A does not select them (TAB-207), so K leaves them hidden stickies', () => {
    const { app, store } = withPrivate();
    press(app, 'a', { metaKey: true });
    expect(app.selection).toContain('mine');
    expect(app.selection).not.toContain('secret');
    press(app, 'k');
    expect(store.get('secret')).toMatchObject({ type: 'sticky', privateStep: 'step1' });
    expect(store.get('mine')!.type).toBe('card');
  });

  // The guards below are defence in depth: the selection never holds a hidden note, so each test puts one there directly
  // (past setSelection) to show that the conversion itself still refuses it (mayConvertSticky).
  it('K with a hidden note in the selection anyway leaves it a hidden sticky', () => {
    const { app, store } = withPrivate();
    app.selection = ['secret', 'mine'];
    press(app, 'k');
    expect(store.get('secret')).toMatchObject({ type: 'sticky', privateStep: 'step1' });
    expect(store.get('mine')!.type).toBe('card');
  });

  it('Make kanban with a hidden note in the selection anyway leaves it out', () => {
    const { app, store } = withPrivate();
    app.selection = ['secret', 'mine'];
    expect(app.makeKanbanFromSelection()).not.toBeNull();
    expect(store.get('secret')).toMatchObject({ type: 'sticky', privateStep: 'step1' });
    expect(store.get('mine')!.type).toBe('card');
  });

  it('dropped on a lane with a hidden note in the selection anyway, it moves but stays a hidden sticky', () => {
    const { app, store, r, ids } = withPrivate();
    app.selection = ['secret', 'mine'];
    const from = centre(store, 'secret');
    const to = centre(store, ids[1], 0.3);
    call(app, 'onDown', pointer(r, from));
    for (let i = 1; i <= 4; i++) call(app, 'onMove', pointer(r, { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, 'pointermove'));
    call(app, 'onUp', pointer(r, to, 'pointerup'));
    expect(store.get('secret')).toMatchObject({ type: 'sticky', privateStep: 'step1' });
    expect(store.get('mine')!.type).toBe('card');
  });
});

describe('pasting, duplicating and importing kanbans', () => {
  const foreign = () => [
    { id: 'kx', type: 'container', layout: 'kanban', name: 'From elsewhere', x: 0, y: 0, w: 900, h: 400, rotation: 0, z: 'a0', createdBy: 'x', updatedAt: 0 },
    { id: 'lane-x', type: 'lane', parent: 'kx', rank: ranksBetween(null, null, 1, 'kx')[0], name: 'Backlog', stage: 'todo', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1', createdBy: 'x', updatedAt: 0 },
    { id: 'cx', type: 'card', parent: 'lane-x', rank: ranksBetween(null, null, 1, 'lane-x')[0], text: 'Foreign card', x: 0, y: 0, w: 264, h: 72, rotation: 0, z: 'a2', createdBy: 'x', updatedAt: 0 },
    { id: 'sx', type: 'sticky', text: 'Note', x: 400, y: 500, w: 192, h: 192, rotation: 0, z: 'a3', createdBy: 'x', updatedAt: 0 },
    { id: 'conn-x', type: 'connector', from: { kind: 'bound', id: 'cx', anchor: 'auto' }, to: { kind: 'bound', id: 'sx', anchor: 'auto' }, route: 'elbow', startHead: 'none', endHead: 'arrow', z: 'a4', createdBy: 'x', updatedAt: 0 },
  ] as unknown as BaseObj[];
  const count = (store: Store, type: string) => [...store.cache.values()].filter((o) => o.type === type).length;

  it('pastes a kanban, its lane and card, and their connector from another board', () => {
    const { app, store, notify } = harness();
    app.pasteText(JSON.stringify({ driftboard: 1, objects: foreign() }));
    expect(count(store, 'container')).toBe(2);
    expect([...store.cache.values()].filter((o) => o.type === 'lane')).toHaveLength(4);
    expect(count(store, 'card')).toBe(4);
    expect(count(store, 'connector')).toBe(1);
    const imported = [...store.cache.values()].find((o) => o.type === 'container' && (o as BaseObj).name === 'From elsewhere') as BaseObj;
    const layout = store.containerLayout(imported.id)!;
    const card = [...layout.cards.values()].flat()[0];
    expect(store.get(card)).toMatchObject({ type: 'card', text: 'Foreign card' });
    const connector = [...store.cache.values()].find((o) => o.type === 'connector') as BaseObj & { from: { id: Id } };
    expect(connector.from.id).toBe(card);
    expect(notify).not.toHaveBeenCalled();
  });

  it('still duplicates a kanban that is on this board', () => {
    const { app, store, container } = harness();
    app.setSelection([container]);
    app.duplicate();
    expect(count(store, 'container')).toBe(2);
  });

});

describe('placing templates with kanbans', () => {
  // Lanes and cards cannot be in a template until slice 5 (the validator refuses them), so a container is enough here.
  const kanbanTemplate = (): TemplateDef => ({
    id: 'test-kanban', name: 'Kanban test', category: 'Planning', description: '',
    build: (b) => {
      b.objs.push({ id: 'tk', type: 'container', layout: 'kanban', name: 'From a template', x: b.ox, y: b.oy, w: 900, h: 400, rotation: 0, z: '', createdBy: 'me', updatedAt: 0 } as BaseObj);
      b.sticky('Note', 0, 500);
    },
  });
  const custom = (): CustomTemplate => ({
    id: 'c1', version: 1, name: 'Saved', category: 'Custom', description: '', createdBy: 'me', createdAt: 0, updatedAt: 0,
    content: {
      objects: [
        { id: 'tk', type: 'container', layout: 'kanban', name: 'Saved kanban', x: 0, y: 0, w: 900, h: 400, rotation: 0, z: 'a0', createdBy: 'me', updatedAt: 0 },
        { id: 'ts', type: 'sticky', text: 'Note', x: 0, y: 500, w: 192, h: 192, rotation: 0, z: 'a1', fill: '#FFE16B', createdBy: 'me', updatedAt: 0 },
      ] as BaseObj[],
      steps: [], bounds: { x: 0, y: 0, w: 900, h: 692 },
    },
  });
  const withFlow = (app: Harness) => Object.assign(app.flow, { state: () => ({ steps: [] }), setSteps() {}, end() {} });
  const count = (store: Store, type: string) => [...store.cache.values()].filter((o) => o.type === type).length;

  it('built-in and saved templates keep their kanbans and the rest of their objects', () => {
    const { app, store, notify } = harness();
    withFlow(app);
    insertTemplate(app, kanbanTemplate());
    insertCustomTemplate(app, custom());
    expect(count(store, 'container')).toBe(3);
    expect(count(store, 'sticky')).toBe(2);
    expect(notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- slice 4: lanes and discipline

describe('the kanban header, the lane ⋯ and the add-lane +', () => {
  const headerPoint = (store: Store, container: Id, pick: (c: HeaderControls) => { x: number; y: number; w: number; h: number } | null | undefined, chips: FilterChip[] = [], editable = true) => {
    const o = store.getPlaced(container) as BaseObj;
    const r = pick(kanbanHeaderControls(o, chips, editable))!;
    return { x: o.x + r.x + r.w / 2, y: o.y + r.y + r.h / 2 };
  };
  const menuCalls = (app: Harness) => (app.openKanbanMenu as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]]);

  it('an editor: Filter, the kanban ⋯ and a lane ⋯ open their menus; the + adds a lane', () => {
    const { app, store, r, container, lanes } = harness();
    call(app, 'onDown', pointer(r, headerPoint(store, container, (c) => c.filter?.rect)));
    call(app, 'onDown', pointer(r, headerPoint(store, container, (c) => c.menu)));
    const lane = store.geometry(store.get(lanes[1])!);
    const m = laneMenuRect(lane);
    call(app, 'onDown', pointer(r, { x: m.x + 14, y: m.y + 14 }));
    expect(menuCalls(app)).toEqual([['filter', container], ['container', container], ['lane', lanes[1]]]);
    expect(app["drag" as keyof Harness]).toBeNull();
    const add = store.containerLayout(container)!.addLane;
    call(app, 'onDown', pointer(r, { x: add.x + 16, y: add.y + 16 }));
    expect(store.containerLayout(container)!.lanes).toHaveLength(4);
  });

  it('a viewer or a commenter: Filter only; no ⋯, no +', () => {
    const { app, store, r, container, lanes } = harness();
    const menuAt = headerPoint(store, container, (c) => c.menu);
    store.setReadOnly(true);
    call(app, 'onDown', pointer(r, headerPoint(store, container, (c) => c.filter?.rect, [], false)));
    call(app, 'onDown', pointer(r, menuAt));
    const m = laneMenuRect(store.geometry(store.get(lanes[1])!));
    call(app, 'onDown', pointer(r, { x: m.x + 14, y: m.y + 14 }));
    const add = store.containerLayout(container)!.addLane;
    call(app, 'onDown', pointer(r, { x: add.x + 16, y: add.y + 16 }));
    // without the ⋯ the Filter button sits where the ⋯ was, so the second click opens the filter too
    expect(menuCalls(app).every(([kind]) => kind === 'filter')).toBe(true);
    expect(menuCalls(app).length).toBeGreaterThan(0);
    expect(store.containerLayout(container)!.lanes).toHaveLength(3);
    app.openLaneMenu(lanes[0]);
    app.openContainerControl(container, 'menu');
    expect(menuCalls(app).every(([kind]) => kind === 'filter')).toBe(true);
  });

  it('a chip\'s remove button takes that part of the filter away', () => {
    const { app, store, r, container } = harness();
    app.setKanbanFilter(container, { mine: true, labels: [], due: ['none'], text: '' });
    const chips = app.filterChipsOf(container);
    expect(chips.map((c) => c.key)).toEqual(['mine', 'due:none']);
    call(app, 'onDown', pointer(r, headerPoint(store, container, (c) => c.chips[0].remove, chips)));
    expect(app.kanbanFilter(container)).toMatchObject({ mine: false, due: ['none'] });
  });

  it('a locked kanban still opens its menu (to unlock it) and its filter', () => {
    const { app, store, r, container } = harness();
    store.transact(() => store.update(container, { locked: true }));
    call(app, 'onDown', pointer(r, headerPoint(store, container, (c) => c.menu)));
    expect(menuCalls(app)).toEqual([['container', container]]);
  });
});

describe('lane and kanban menu actions', () => {
  it('each is one undo step; a refusal is a toast and writes nothing', () => {
    const { app, store, container, lanes, notify } = harness();
    const steps = () => (store.undo as unknown as { undoStack: unknown[] }).undoStack.length;
    expect(app.editLaneFromMenu(lanes[1], { fill: 'teal' })).toBe(true);
    expect(app.moveLaneFromMenu(lanes[1], 'left')).toBe(true);
    expect(app.addLaneTo(container)).not.toBeNull();
    expect(steps()).toBe(3);
    store.transact(() => store.update(lanes[2], { locked: true }));
    store.undo.clear();
    expect(app.editLaneFromMenu(lanes[2], { fill: 'blue' })).toBe(false);
    expect(notify).toHaveBeenLastCalledWith('This lane is locked. Unlock it to change it.');
    expect(app.deleteLane(lanes[2], false)).toBe(false);
    expect(steps()).toBe(0);
  });

  it('Delete lane moves its cards to the neighbour; with its cards removes them; one undo step each', () => {
    const { app, store, container, lanes, ids } = harness();
    expect(app.deleteLane(lanes[0], false)).toBe(true);
    expect(store.containerLayout(container)!.cards.get(lanes[1])).toEqual(ids);
    store.undo.undo();
    expect(store.containerLayout(container)!.cards.get(lanes[0])).toEqual(ids);
    expect(app.deleteLane(lanes[0], true)).toBe(true);
    for (const id of ids) expect(store.get(id)).toBeUndefined();
    store.undo.undo();
    for (const id of ids) expect(store.get(id)?.parent).toBe(lanes[0]);
  });

  it('delete with locked cards, or in a locked kanban, is refused', () => {
    const { app, store, container, lanes, ids, notify } = harness();
    store.transact(() => store.update(ids[1], { locked: true }));
    expect(app.deleteLane(lanes[0], true)).toBe(false);
    expect(notify).toHaveBeenLastCalledWith('This lane has locked cards. Unlock them to delete it.');
    store.transact(() => store.update(container, { locked: true }));
    expect(app.deleteLane(lanes[1], false)).toBe(false);
    expect(app.deleteKanban(container)).toBe(false);
    expect(app.moveLaneFromMenu(lanes[1], 'left')).toBe(false);
    expect(app.addLaneTo(container)).toBeNull();
    expect(store.containerLayout(container)!.lanes).toEqual(lanes);
  });

  it('Delete kanban takes its lanes and cards; Lock and Unlock toggle it', () => {
    const { app, store, container, lanes, ids } = harness();
    app.toggleKanbanLock(container);
    expect(store.get(container)!.locked).toBe(true);
    app.toggleKanbanLock(container);
    expect(store.get(container)!.locked).toBeFalsy();
    expect(app.deleteKanban(container)).toBe(true);
    for (const id of [container, ...lanes, ...ids]) expect(store.get(id)).toBeUndefined();
  });

  it('read-only (viewers and commenters): no menu action writes', () => {
    const { app, store, container, lanes } = harness();
    store.setReadOnly(true);
    expect(app.editLaneFromMenu(lanes[0], { fill: 'blue' })).toBe(false);
    expect(app.moveLaneFromMenu(lanes[0], 'right')).toBe(false);
    expect(app.addLaneTo(container)).toBeNull();
    expect(app.deleteLane(lanes[0], false)).toBe(false);
    expect(app.deleteKanban(container)).toBe(false);
    app.toggleKanbanLock(container);
    expect(store.get(container)!.locked).toBeFalsy();
    expect(store.containerLayout(container)!.lanes).toEqual(lanes);
  });

  it('a stage change redraws the lane\'s cards (their due chips depend on it)', () => {
    const { app, r, lanes, ids } = harness();
    const dirty = (r as unknown as { dirty: Set<Id> }).dirty;
    dirty.clear();
    app.editLaneFromMenu(lanes[0], { stage: 'done' });
    for (const id of ids) expect(dirty.has(id)).toBe(true);
  });
});

describe('WIP block on the canvas', () => {
  function full() {
    const h = harness();
    addCard(h.store, h.lanes[1], 'D', { createdBy: 'me' });
    h.app.editLaneFromMenu(h.lanes[1], { wip: 1, wipMode: 'block' });
    return h;
  }

  it('dragging over a full block lane shows Full and no drop line; the drop is refused with the toast', () => {
    const { app, store, r, ids, lanes, container, notify } = full();
    const to = centre(store, lanes[1], 0.3);
    dragCard(app, r, centre(store, ids[0]), to);
    expect(r.overlay.kanban?.full?.text).toBe('Full · 1 / 1');
    expect(r.overlay.kanban?.line).toBeFalsy();
    call(app, 'onUp', pointer(r, to, 'pointerup'));
    expect(notify).toHaveBeenCalledWith('Doing is full: 1 of 1');
    expect(store.containerLayout(container)!.cards.get(lanes[0])).toContain(ids[0]);
    expect(r.overlay.kanban?.full).toBeFalsy();
  });

  it('a lane with room shows the drop line', () => {
    const { app, store, r, ids, lanes } = full();
    dragCard(app, r, centre(store, ids[0]), centre(store, lanes[2], 0.3));
    expect(r.overlay.kanban?.line).toBeTruthy();
    expect(r.overlay.kanban?.full).toBeFalsy();
  });

  it('Alt+Right into it is refused with the toast; Alt+Down inside it is not', () => {
    const { app, store, ids, lanes, container, notify } = full();
    app.setSelection([ids[0]]);
    call(app, 'keyboardCardMove', 'right');
    expect(notify).toHaveBeenCalledWith('Doing is full: 1 of 1');
    expect(store.containerLayout(container)!.cards.get(lanes[0])).toContain(ids[0]);
    call(app, 'keyboardCardMove', 'down');
    expect(store.containerLayout(container)!.cards.get(lanes[0])![1]).toBe(ids[0]);
  });
});

describe('filters (docs/kanban.md, Filters)', () => {
  it('are never written to the board: no document change, no undo step; kept in this browser', () => {
    const { app, store, container } = harness();
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) });
    const before = Y.encodeStateAsUpdate(store.doc);
    const steps = (store.undo as unknown as { undoStack: unknown[] }).undoStack.length;
    app.setKanbanFilter(container, { mine: true, labels: ['x'], due: ['today'], text: 'login' });
    expect(Y.encodeStateAsUpdate(store.doc)).toEqual(before);
    expect((store.undo as unknown as { undoStack: unknown[] }).undoStack.length).toBe(steps);
    expect(JSON.parse(saved.get(`tabula:filter:board1:${container}`)!)).toMatchObject({ mine: true, text: 'login' });
    app.setKanbanFilter(container, EMPTY_FILTER);
    expect(saved.size).toBe(0);
    expect(Y.encodeStateAsUpdate(store.doc)).toEqual(before);
  });

  it('a saved filter comes back on the next visit; storage that throws means no filter', () => {
    const { app, container } = harness();
    storage.set(`tabula:filter:board1:${container}`, JSON.stringify({ mine: true }));
    expect(app.kanbanFilter(container).mine).toBe(true);
    const h2 = harness();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem() {} });
    expect(h2.app.kanbanFilter(h2.container)).toEqual(EMPTY_FILTER);
    h2.app.setKanbanFilter(h2.container, { ...EMPTY_FILTER, text: 'a' });
    expect(h2.app.kanbanFilter(h2.container).text).toBe('a');
  });

  it('dim what does not match (35%), skip it in a marquee, and count matches; viewers filter too', () => {
    const { app, store, r, container, ids } = harness();
    store.transact(() => store.update(ids[1], { ownerId: 'me', ownerName: 'Me' }));
    store.setReadOnly(true);
    app.setKanbanFilter(container, { ...EMPTY_FILTER, mine: true });
    expect(ids.map((id) => app.isDimmed(store.get(id)!))).toEqual([true, false, true]);
    expect(objectMarkup(store.getPlaced(ids[0])!, r.ctx)).toContain('opacity="0.35"');
    expect(objectMarkup(store.getPlaced(ids[1])!, r.ctx)).not.toContain('opacity=');
    expect(app.filterCounts(container)).toEqual({ matching: 1, total: 3 });
    store.setReadOnly(false);
    const lane = store.geometry(store.get(store.get(ids[0])!.parent!)!);
    call(app, 'onDown', pointer(r, { x: lane.x - 40, y: lane.y - 80 }));
    call(app, 'onMove', pointer(r, { x: lane.x + lane.w + 4, y: lane.y + lane.h + 4 }, 'pointermove'));
    expect(app.selection.filter((id) => ids.includes(id))).toEqual([ids[1]]);
  });

  it('an export draws every card at full strength and no Filter button', () => {
    const { app, store, r, container, ids } = harness();
    app.setKanbanFilter(container, { ...EMPTY_FILTER, text: 'nothing matches this' });
    const ctx = { ...r.ctx, filterChips: undefined, dimmed: undefined, editable: false };
    expect(objectMarkup(store.getPlaced(ids[0])!, ctx)).not.toContain('opacity=');
    const head = objectMarkup(store.getPlaced(container)!, ctx);
    expect(head).not.toContain('k-filter');
    expect(head).not.toContain('k-menu');
    expect(head).not.toContain('k-addlane');
    expect(objectMarkup(store.getPlaced(container)!, r.ctx)).toContain('FILTER · 1');
  });
});

describe('Add card in a full block lane (Slice 4 notes)', () => {
  class FakeInputEl extends FakeEl {
    value = '';
    listeners = new Map<string, ((e: unknown) => void)[]>();
    addEventListener(t: string, fn: (e: unknown) => void) {
      this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
    }
    focus() {}
    blur() {}
  }
  function fullLane() {
    const h = harness();
    addCard(h.store, h.lanes[1], 'D', { createdBy: 'me' });
    h.app.editLaneFromMenu(h.lanes[1], { name: 'Review', wip: 1, wipMode: 'block' });
    const els: FakeInputEl[] = [];
    vi.stubGlobal('document', { createElement: () => { const e = new FakeInputEl(); els.push(e); return e; }, createElementNS: () => new FakeEl(), activeElement: null });
    const input = new CardInput(h.app);
    Object.assign(h.app, { cardInput: input });
    // the CardInput makes its wrap, then its input, then its hint
    return { ...h, input, field: els[1] };
  }

  it('the store refuses it with the Full message; warn lanes and lanes with room take it', () => {
    const { store, lanes } = fullLane();
    expect(addCardRefusal(store, lanes[1])).toBe('Review is full: 1 of 1');
    expect(addCard(store, lanes[1], 'E', { createdBy: 'me' })).toBeNull();
    expect(addCardRefusal(store, lanes[2])).toBeNull();
    store.transact(() => store.update(lanes[1], { wipMode: undefined }));
    expect(addCard(store, lanes[1], 'E', { createdBy: 'me' })).not.toBeNull();
  });

  it('the add row draws disabled with the limit in its tooltip', () => {
    const { store, r, lanes } = fullLane();
    const svg = objectMarkup(store.getPlaced(lanes[1])!, r.ctx);
    expect(svg).toContain('k-add-full');
    expect(svg).toContain('<title>Review is full: 1 of 1</title>');
    expect(objectMarkup(store.getPlaced(lanes[2])!, r.ctx)).not.toContain('k-add-full');
  });

  it('a click on the add row and a double-click on empty lane space open nothing and say why', () => {
    const { app, store, r, lanes, notify, input } = fullLane();
    const layout = store.containerLayout(store.get(lanes[1])!.parent!)!;
    const row = addRow(layout.rects.get(lanes[1])!, laneCards(layout, lanes[1]));
    call(app, 'onDown', pointer(r, { x: row.x + 20, y: row.y + row.h / 2 }));
    expect(input.active).toBeNull();
    expect(notify).toHaveBeenLastCalledWith('Review is full: 1 of 1');
    notify.mockClear();
    const lane = layout.rects.get(lanes[1])!;
    call(app, 'onDblClick', pointer(r, { x: lane.x + lane.w / 2, y: lane.y + lane.h - 20 }, 'dblclick'));
    expect(input.active).toBeNull();
    expect(notify).toHaveBeenLastCalledWith('Review is full: 1 of 1');
  });

  it('Enter in the inline input adds nothing once the lane is full, and says why', () => {
    const { app, store, lanes, notify, input, field, container } = fullLane();
    app.editLaneFromMenu(lanes[2], { name: 'Done', wip: 1, wipMode: 'block' });
    input.start(lanes[2]);
    expect(input.active).toBe(lanes[2]);
    const enter = (text: string) => {
      field.value = text;
      field.listeners.get('keydown')!.forEach((fn) => fn({ key: 'Enter', preventDefault() {}, stopPropagation() {} }));
    };
    enter('First');
    expect(store.containerLayout(container)!.cards.get(lanes[2])).toHaveLength(1);
    enter('Second');
    expect(store.containerLayout(container)!.cards.get(lanes[2])).toHaveLength(1);
    expect(notify).toHaveBeenLastCalledWith('Done is full: 1 of 1');
  });
});

describe('review fixes: filters and labels', () => {
  it('filtering 2,000 cards reads the board\'s labels a constant number of times per draw, not per card', () => {
    const { app, store, r, container, lanes } = harness();
    const bug = createLabel(store, 'Bug', 'pink')!;
    const extra = addLane(store, container, { createdBy: 'me' })!;
    const all = [...lanes, extra];
    store.transact(() => {
      for (const lane of all) {
        const ranks = ranksBetween(null, null, 497, lane);
        ranks.forEach((rank, i) => store.create({ id: `${lane}-${i}`, type: 'card', parent: lane, rank, text: `Card ${i}`, labels: i % 3 ? [] : [bug], x: 0, y: 0, w: 264, h: 34, rotation: 0, z: 'a0', createdBy: 'me', updatedAt: 0 } as BaseObj));
      }
    });
    const cards = [...store.cache.values()].filter((o) => o.type === 'card');
    expect(cards.length).toBeGreaterThanOrEqual(1990);
    app.setKanbanFilter(container, { ...EMPTY_FILTER, labels: [bug], text: 'card' });
    const reads = vi.mocked(listLabels);
    reads.mockClear();
    // a draw: the header (chips), every card (dimming), and the popover's count
    objectMarkup(store.getPlaced(container)!, r.ctx);
    for (const c of cards) objectMarkup(store.getPlaced(c.id)!, r.ctx);
    const n = app.filterCounts(container);
    expect(n.total).toBe(cards.length);
    expect(n.matching).toBeGreaterThan(600);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('renaming or deleting a filtered label on another client updates the chips and the dimming', () => {
    const { app, store, container, ids } = harness();
    const bug = createLabel(store, 'Bug', 'pink')!;
    store.transact(() => store.update(ids[0], { labels: [bug] }));
    app.setKanbanFilter(container, { ...EMPTY_FILTER, labels: [bug] });
    expect(app.filterChipsOf(container).map((c) => c.text)).toEqual(['Bug']);
    expect(ids.map((id) => app.isDimmed(store.get(id)!))).toEqual([false, true, true]);
    const invalidate = vi.spyOn(app.r, 'invalidateKanban');
    // another client: its update arrives through the shared document
    const other = new Store(new Y.Doc());
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(store.doc));
    renameLabel(other, bug, 'Defect');
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(store.doc)));
    expect(app.filterChipsOf(container).map((c) => c.text)).toEqual(['Defect']);
    expect(invalidate).toHaveBeenCalledWith(container);
    deleteLabel(other, bug);
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(store.doc)));
    expect(app.filterChipsOf(container)).toEqual([]);
    expect(ids.map((id) => app.isDimmed(store.get(id)!))).toEqual([false, false, false]);
  });

  it('a stored filter naming a label the board does not have drops it: count, on state and storage agree', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) });
    const { app, store, container } = harness();
    const bug = createLabel(store, 'Bug', 'pink')!;
    saved.set(`tabula:filter:board1:${container}`, JSON.stringify({ labels: [bug, 'gone'] }));
    expect(app.kanbanFilter(container).labels).toEqual([bug]);
    expect(app.filterChipsOf(container)).toHaveLength(1);
    // the next labels change (any) cleans what is stored too
    createLabel(store, 'Docs', 'violet');
    expect(JSON.parse(saved.get(`tabula:filter:board1:${container}`)!).labels).toEqual([bug]);
    deleteLabel(store, bug);
    expect(app.kanbanFilter(container).labels).toEqual([]);
    expect(app.filterChipsOf(container)).toEqual([]);
    expect(saved.has(`tabula:filter:board1:${container}`)).toBe(false);
  });
});

describe('review fixes: lanes', () => {
  it('deleting a lane whose cards would go into a full block lane is refused with the Full toast; with its cards it is not', () => {
    const { app, store, lanes, ids, notify } = harness();
    addCard(store, lanes[1], 'D', { createdBy: 'me' });
    app.editLaneFromMenu(lanes[1], { name: 'Doing', wip: 1, wipMode: 'block' });
    expect(app.deleteLane(lanes[0], false)).toBe(false);
    expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Doing is full: 1 of 1/));
    for (const id of ids) expect(store.get(id)?.parent).toBe(lanes[0]);
    app.setSelection([lanes[0]]);
    app.deleteSelection();
    expect(store.get(lanes[0])).toBeDefined();
    expect(app.deleteLane(lanes[0], true)).toBe(true);
    expect(store.get(lanes[0])).toBeUndefined();
  });

  it('Move left or right is refused when the repair of tied ranks would rewrite a locked lane', () => {
    const { app, store, container, lanes, notify } = harness();
    const same = (store.get(lanes[0]) as BaseObj).rank;
    store.transact(() => lanes.forEach((id) => store.update(id, { rank: same })));
    const order = store.containerLayout(container)!.lanes;
    store.transact(() => store.update(order[0], { locked: true }));
    const before = order.map((id) => (store.get(id) as BaseObj).rank);
    expect(app.moveLaneFromMenu(order[2], 'left')).toBe(false);
    expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/locked/));
    expect(order.map((id) => (store.get(id) as BaseObj).rank)).toEqual(before);
  });
});

describe('the list sheet from the canvas (slice 5)', () => {
  it('opens on Enter with a kanban selected, for a viewer too', () => {
    const { app, store, container } = harness();
    const openSheet = vi.fn<(id: Id, lane?: Id) => void>();
    Object.assign(app, { openSheet });
    store.setReadOnly(true);
    app.setSelection([container]);
    press(app, 'Enter');
    expect(openSheet).toHaveBeenCalledWith(container, undefined);
  });

  it('opens on a double tap at phone width, on the lane tapped', () => {
    const { app, store, r, container, lanes, ids } = harness();
    const openSheet = vi.fn<(id: Id, lane?: Id) => void>();
    Object.assign(app, { openSheet });
    call(app, 'onDblClick', pointer(r, centre(store, ids[1]), 'dblclick'));
    expect(openSheet).toHaveBeenLastCalledWith(container, lanes[0]);
    call(app, 'onDblClick', pointer(r, centre(store, lanes[2], 0.6), 'dblclick'));
    expect(openSheet).toHaveBeenLastCalledWith(container, lanes[2]);
    expect(openCard).not.toHaveBeenCalled();
  });

  it('lifts a card on a touch screen only after a long press', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    try {
      const { app, store, r, container, lanes, ids } = harness();
      const touch = (p: Point, type = 'pointerdown') => ({ ...pointer(r, p, type), pointerType: 'touch' });
      // a short press and a move does nothing
      call(app, 'onDown', touch(centre(store, ids[0])));
      call(app, 'onMove', touch(centre(store, lanes[1], 0.3), 'pointermove'));
      call(app, 'onUp', touch(centre(store, lanes[1], 0.3), 'pointerup'));
      expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
      // held for 600 ms, it lifts and drops where the finger goes, one undo step
      call(app, 'onDown', touch(centre(store, ids[0])));
      vi.advanceTimersByTime(600);
      expect((app as unknown as { drag: { mode: string; moved: boolean } }).drag).toMatchObject({ mode: 'cards', moved: true });
      for (let i = 1; i <= 4; i++) call(app, 'onMove', touch(centre(store, lanes[1], 0.3), 'pointermove'));
      call(app, 'onUp', touch(centre(store, lanes[1], 0.3), 'pointerup'));
      expect(titles(store, container, lanes[1])).toEqual(['A']);
      store.undo.undo();
      expect(titles(store, container, lanes[0])).toEqual(['A', 'B', 'C']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('kanban templates and copies (slice 5)', () => {
  const withFlow = (app: Harness) => Object.assign(app.flow, { state: () => ({ steps: [] }), setSteps: vi.fn<() => void>(), end() {} });
  const containers = (store: Store) => [...store.cache.values()].filter((o) => o.type === 'container').map((o) => o.id);

  it('includes all four kanban templates', () => {
    expect(TEMPLATES.filter((t) => ['kanban', 'sprint-board', 'bug-triage', 'personal-tasks'].includes(t.id)).map((t) => t.name))
      .toEqual(['Kanban', 'Sprint board', 'Bug triage', 'Personal tasks']);
  });

  it('places the Sprint board with its labels merged by name, in one undo step, leaving the session alone', () => {
    const { app, store } = harness();
    const flow = withFlow(app);
    const feature = createLabel(store, 'FEATURE', 'teal')!;
    store.undo.clear();
    insertTemplate(app, TEMPLATES.find((t) => t.id === 'sprint-board')!);
    expect(flow.setSteps).not.toHaveBeenCalled();
    const id = containers(store).find((c) => (store.get(c) as BaseObj).name === 'Sprint board')!;
    const layout = store.containerLayout(id)!;
    expect(layout.lanes.map((l) => (store.get(l) as BaseObj).name)).toEqual(['Backlog', 'Sprint', 'In review', 'Done']);
    expect(store.get(layout.lanes[2])).toMatchObject({ wip: 3 });
    expect(listLabels(store).map((l) => l.name).sort()).toEqual(['Chore', 'FEATURE']);
    const used = new Set([...layout.cards.values()].flat().flatMap((c) => (store.get(c) as BaseObj).labels ?? []));
    expect(used.has(feature)).toBe(true);
    for (const l of used) expect(listLabels(store).some((x) => x.id === l)).toBe(true);
    store.undo.undo();
    expect(containers(store)).toHaveLength(1);
    expect(listLabels(store).map((l) => l.name)).toEqual(['FEATURE']);
  });

  it('duplicates a kanban with its lanes and cards, ranks naming the copies', () => {
    const { app, store, container } = harness();
    app.setSelection([container]);
    app.duplicate();
    const copy = containers(store).find((c) => c !== container)!;
    const layout = store.containerLayout(copy)!;
    expect(layout.lanes).toHaveLength(3);
    expect(layout.cards.get(layout.lanes[0])!.map((c) => (store.get(c) as BaseObj).text)).toEqual(['A', 'B', 'C']);
    for (const c of layout.cards.get(layout.lanes[0])!) expect((store.get(c) as BaseObj).rank!.endsWith(`@${layout.lanes[0]}`)).toBe(true);
    expect(store.containerLayout(container)!.cards.get(store.containerLayout(container)!.lanes[0])).toHaveLength(3);
  });
});

describe('dragging a lane header (slice 5, part 2)', () => {
  const laneNames = (store: Store, container: Id) => store.containerLayout(container)!.lanes.map((l) => (store.get(l) as BaseObj).name);
  /** A point in a lane's header band, clear of its ⋯ button. */
  const header = (store: Store, id: Id, dx = 0) => {
    const g = store.geometry(store.get(id)!);
    return { x: g.x + g.w / 2 + dx, y: g.y + 16 };
  };
  const drag = (app: Harness, r: Renderer, from: Point, to: Point, type = 'mouse') => {
    call(app, 'onDown', { ...pointer(r, from), pointerType: type });
    for (let i = 1; i <= 4; i++) call(app, 'onMove', { ...pointer(r, { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, 'pointermove'), pointerType: type });
  };

  it('drops a lane where the pointer lets go, in one undo step, with a drop line while it moves', () => {
    const { app, store, r, container, lanes } = harness();
    drag(app, r, header(store, lanes[0]), header(store, lanes[2], 60));
    expect(r.overlay.kanban?.laneLine).toBeTruthy();
    expect(r.overlay.kanban?.laneFrom).toBeTruthy();
    expect(laneNames(store, container)).toEqual(['To do', 'Doing', 'Done']);
    call(app, 'onUp', pointer(r, header(store, lanes[2], 60), 'pointerup'));
    expect(laneNames(store, container)).toEqual(['Doing', 'Done', 'To do']);
    expect(r.overlay.kanban).toBeNull();
    expect(app.announce).toHaveBeenLastCalledWith('Moved To do to position 3 of 3');
    store.undo.undo();
    expect(laneNames(store, container)).toEqual(['To do', 'Doing', 'Done']);
  });

  it('puts a lane first when dropped left of the others', () => {
    const { app, store, r, container, lanes } = harness();
    drag(app, r, header(store, lanes[2]), header(store, lanes[0], -90));
    call(app, 'onUp', pointer(r, header(store, lanes[0], -90), 'pointerup'));
    expect(laneNames(store, container)).toEqual(['Done', 'To do', 'Doing']);
  });

  it('writes nothing for a click, a drop in its own place, or a cancelled drag', () => {
    const { app, store, r, container, lanes } = harness();
    const n = vi.fn<() => void>();
    store.doc.on('update', n);
    call(app, 'onDown', pointer(r, header(store, lanes[1])));
    call(app, 'onUp', pointer(r, header(store, lanes[1]), 'pointerup'));
    drag(app, r, header(store, lanes[1]), header(store, lanes[1], 20));
    call(app, 'onUp', pointer(r, header(store, lanes[1], 20), 'pointerup'));
    drag(app, r, header(store, lanes[0]), header(store, lanes[2], 60));
    call(app, 'onCancel', pointer(r, header(store, lanes[2], 60), 'pointercancel'));
    expect(n).not.toHaveBeenCalled();
    expect(laneNames(store, container)).toEqual(['To do', 'Doing', 'Done']);
    expect(app.dragging).toBe(false);
    expect(r.overlay.kanban).toBeNull();
  });

  it('does not move a locked lane, a lane of a locked kanban, or anything for a viewer', () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const a = harness();
    a.store.transact(() => a.store.update(a.lanes[0], { locked: true }));
    drag(a.app, a.r, header(a.store, a.lanes[0]), header(a.store, a.lanes[2], 60));
    call(a.app, 'onUp', pointer(a.r, header(a.store, a.lanes[2], 60), 'pointerup'));
    expect(laneNames(a.store, a.container)).toEqual(['To do', 'Doing', 'Done']);
    const b = harness();
    b.store.transact(() => b.store.update(b.container, { locked: true }));
    drag(b.app, b.r, header(b.store, b.lanes[1]), header(b.store, b.lanes[2], 60));
    call(b.app, 'onUp', pointer(b.r, header(b.store, b.lanes[2], 60), 'pointerup'));
    expect(laneNames(b.store, b.container)).toEqual(['To do', 'Doing', 'Done']);
    const c = harness();
    c.store.setReadOnly(true);
    drag(c.app, c.r, header(c.store, c.lanes[0]), header(c.store, c.lanes[2], 60));
    call(c.app, 'onUp', pointer(c.r, header(c.store, c.lanes[2], 60), 'pointerup'));
    expect(laneNames(c.store, c.container)).toEqual(['To do', 'Doing', 'Done']);
  });

  it('leaves a finger on a lane header to pan, and a pointer on the card area to cards', () => {
    const { app, store, r, container, lanes } = harness();
    drag(app, r, header(store, lanes[0]), header(store, lanes[2], 60), 'touch');
    call(app, 'onUp', { ...pointer(r, header(store, lanes[2], 60), 'pointerup'), pointerType: 'touch' });
    expect(laneNames(store, container)).toEqual(['To do', 'Doing', 'Done']);
  });

  it('writes nothing, and leaves no marks, when the lane or its kanban is hidden before the drop', () => {
    for (const hide of ['lane', 'kanban'] as const) {
      const { app, store, r, container, lanes } = harness();
      drag(app, r, header(store, lanes[0]), header(store, lanes[2], 60));
      store.transact(() => store.update(hide === 'lane' ? lanes[0] : container, { hidden: true }));
      call(app, 'onUp', pointer(r, header(store, lanes[2], 60), 'pointerup'));
      store.transact(() => store.update(hide === 'lane' ? lanes[0] : container, { hidden: false }));
      expect(laneNames(store, container)).toEqual(['To do', 'Doing', 'Done']);
      expect(r.overlay.kanban).toBeNull();
    }
  });

  it('reads the place again at the drop: a lane that went since the last move, or a view that moved, does not misplace it', () => {
    const { app, store, r, container, lanes } = harness();
    const last = addLane(store, container, { createdBy: 'me' })!;
    drag(app, r, header(store, lanes[0]), header(store, last, 60));
    // the last lane goes (an undo or a remote delete) before the pointer lets go: the pointer is now past every lane
    store.transact(() => store.remove([last]));
    call(app, 'onUp', pointer(r, header(store, lanes[2], 60), 'pointerup'));
    expect(laneNames(store, container)).toEqual(['Doing', 'Done', 'To do']);
  });

  it('gives the drag up, marks and all, when a second pointer goes down', () => {
    const { app, store, r, container, lanes } = harness();
    drag(app, r, header(store, lanes[0]), header(store, lanes[2], 60), 'pen');
    expect(r.overlay.kanban?.laneLine).toBeTruthy();
    call(app, 'onDown', { ...pointer(r, header(store, lanes[1])), pointerType: 'touch', pointerId: 2 });
    expect(r.overlay.kanban).toBeNull();
    expect((app as unknown as { drag: { mode: string } | null }).drag?.mode).not.toBe('lane');
    expect(laneNames(store, container)).toEqual(['To do', 'Doing', 'Done']);
  });

  it('is given up when the board turns read-only mid-drag', () => {
    const { app, store, r, container, lanes } = harness();
    drag(app, r, header(store, lanes[0]), header(store, lanes[2], 60));
    store.setReadOnly(true);
    call(app, 'onUp', pointer(r, header(store, lanes[2], 60), 'pointerup'));
    expect(laneNames(store, container)).toEqual(['To do', 'Doing', 'Done']);
  });
});
