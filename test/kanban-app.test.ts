import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { Renderer } from '../src/render';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import { KANBAN, LIMITS, ranksBetween } from '../shared/containers';
import { addRow, laneCards } from '../src/ui/kanban-logic';
import type { BaseObj, Id, Point } from '../src/types';

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
/** The kanban flag (src/flags.ts), by the URL or by localStorage. */
const storage = new Map<string, string>();
function flagOn(by: 'url' | 'storage' = 'url') {
  if (by === 'url') vi.stubGlobal('location', { search: '?debug&kanban' });
  else storage.set('driftboard:flag:kanban', '1');
}

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
  });
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
    flagOn();
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

describe('the kanban flag (src/flags.ts)', () => {
  it('off: no Kanban tool, no kanban from a selection, no loose cards; existing kanbans still edit', () => {
    const { app, store, ids, container, lanes } = harness();
    app.setTool({ kind: 'kanban' });
    expect(app.tool.kind).toBe('select');
    expect(app.createKanban({ x: 0, y: 0 })).toBeNull();
    addSticky(store, 's1', { x: 3000, y: 3000 });
    addSticky(store, 's2', { x: 3300, y: 3000 });
    app.setSelection(['s1', 's2']);
    expect(app.kanbanCreation).toBe(false);
    expect(app.makeKanbanFromSelection()).toBeNull();
    expect(app.canTurnIntoCards()).toBe(false);
    expect(app.turnIntoCards()).toBe(false);
    expect(store.get('s1')!.type).toBe('sticky');
    expect([...store.cache.values()].filter((o) => o.type === 'container')).toHaveLength(1);
    // a sticky over a lane still becomes a card there, and the kanban edits as before
    addSticky(store, 's3', centre(store, lanes[1], 0.3));
    expect(app.canTurnIntoCards(['s3'])).toBe(true);
    expect(app.turnIntoCards(['s3'])).toBe(true);
    expect(store.containerLayout(container)!.cards.get(lanes[1])).toEqual(['s3']);
    app.setSelection([ids[0]]);
    expect(app.openCardDialog(ids[0])).toBe(true);
  });

  it('on by ?kanban: the tool, Make kanban and loose cards are there', () => {
    const { app, store } = harness();
    flagOn('url');
    app.setTool({ kind: 'kanban' });
    expect(app.tool.kind).toBe('kanban');
    app.setTool({ kind: 'select' });
    addSticky(store, 's1', { x: 3000, y: 3000 });
    addSticky(store, 's2', { x: 3300, y: 3000 });
    app.setSelection(['s1', 's2']);
    expect(app.kanbanCreation).toBe(true);
    expect(app.canTurnIntoCards()).toBe(true);
    const id = app.makeKanbanFromSelection();
    expect(store.get(id!)?.type).toBe('container');
    expect(store.get('s1')!.type).toBe('card');
  });

  it('on by localStorage driftboard:flag:kanban = 1', () => {
    const { app, store } = harness();
    flagOn('storage');
    addSticky(store, 's1', { x: 3000, y: 3000 });
    expect(app.turnIntoCards(['s1'])).toBe(true);
    expect(store.get('s1')).toMatchObject({ type: 'card' });
    expect(store.isLaidOut(store.get('s1')!)).toBe(false);
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
    flagOn();
    // written by someone else in a private step that is still running: hidden on this screen
    h.store.transact(() => h.store.create({ id: 'secret', type: 'sticky', x: 3000, y: 3000, w: 192, h: 192, rotation: 0, z: 'a6', fill: '#FFE16B', text: 'Secret', privateStep: 'step1', createdBy: 'other', updatedAt: 0 } as BaseObj));
    addSticky(h.store, 'mine', { x: 3300, y: 3000 }, 'Mine');
    return h;
  }

  it('Cmd+A then K leaves them hidden stickies', () => {
    const { app, store } = withPrivate();
    press(app, 'a', { metaKey: true });
    expect(app.selection).toContain('secret');
    press(app, 'k');
    expect(store.get('secret')).toMatchObject({ type: 'sticky', privateStep: 'step1' });
    expect(store.get('mine')!.type).toBe('card');
  });

  it('Cmd+A then Make kanban leaves them out', () => {
    const { app, store } = withPrivate();
    press(app, 'a', { metaKey: true });
    app.makeKanbanFromSelection();
    expect(store.get('secret')).toMatchObject({ type: 'sticky', privateStep: 'step1' });
  });

  it('dropped on a lane with a selection, they move but stay hidden stickies', () => {
    const { app, store, r, ids } = withPrivate();
    app.setSelection(['secret', 'mine']);
    const from = centre(store, 'secret');
    const to = centre(store, ids[1], 0.3);
    call(app, 'onDown', pointer(r, from));
    for (let i = 1; i <= 4; i++) call(app, 'onMove', pointer(r, { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, 'pointermove'));
    call(app, 'onUp', pointer(r, to, 'pointerup'));
    expect(store.get('secret')).toMatchObject({ type: 'sticky', privateStep: 'step1' });
    expect(store.get('mine')!.type).toBe('card');
  });
});

describe('pasting, duplicating and importing while the kanban flag is off', () => {
  const foreign = () => [
    { id: 'kx', type: 'container', layout: 'kanban', name: 'From elsewhere', x: 0, y: 0, w: 900, h: 400, rotation: 0, z: 'a0', createdBy: 'x', updatedAt: 0 },
    { id: 'cx', type: 'card', text: 'Loose', x: 0, y: 500, w: 264, h: 34, rotation: 0, z: 'a1', createdBy: 'x', updatedAt: 0 },
    { id: 'sx', type: 'sticky', text: 'Note', x: 400, y: 500, w: 192, h: 192, rotation: 0, z: 'a2', createdBy: 'x', updatedAt: 0 },
    { id: 'lx', type: 'connector', from: { kind: 'bound', id: 'cx', anchor: 'auto' }, to: { kind: 'bound', id: 'sx', anchor: 'auto' }, route: 'elbow', startHead: 'none', endHead: 'arrow', z: 'a3', createdBy: 'x', updatedAt: 0 },
  ] as unknown as BaseObj[];
  const count = (store: Store, type: string) => [...store.cache.values()].filter((o) => o.type === type).length;

  it('leaves out kanbans and cards that are not copies of ones on this board, with their connectors, and says so', () => {
    const { app, store, notify } = harness();
    const before = { containers: count(store, 'container'), cards: count(store, 'card') };
    const out = app.insertObjects(foreign(), { x: 0, y: 2000 });
    expect(out.map((o) => o.type)).toEqual(['sticky']);
    expect(count(store, 'container')).toBe(before.containers);
    expect(count(store, 'card')).toBe(before.cards);
    expect(count(store, 'connector')).toBe(0);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Kanbans'));
  });

  it('still duplicates a kanban that is on this board', () => {
    const { app, store, container } = harness();
    app.setSelection([container]);
    app.duplicate();
    expect(count(store, 'container')).toBe(2);
  });

  it('lets everything through with the flag', () => {
    const { app, store } = harness();
    flagOn();
    app.insertObjects(foreign(), { x: 0, y: 2000 });
    expect(count(store, 'container')).toBe(2);
    expect(count(store, 'connector')).toBe(1);
  });
});
