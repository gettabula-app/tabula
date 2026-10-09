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
    conn: { awareness: { setLocalStateField() {}, getStates: () => new Map(), clientID: 1 } },
    cardInput: { start: startInput, stop() {} },
    announce: vi.fn<(msg: string) => void>(),
    editor: { active: false, commit() {}, start() {} },
    flow: { handleClick: () => false, isHidden: () => false, isVoting: () => false, activeStep: () => null },
    isPinching: () => false,
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
