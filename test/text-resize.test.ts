import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { Renderer, handlesFor } from '../src/render';
import { Store } from '../src/store';
import { styleOf } from '../src/markup';
import { center, rotate } from '../src/geometry';
import { FONT_MAX, FONT_MIN, WRAP_KEY_STEP, WRAP_MIN, cornerBox, cornerFactor, keyResize, scaledText } from '../src/text-resize';
import type { BaseObj, Point } from '../src/types';

// TAB-233: a selected text has handles on its sides (the wrap width) and corners (the type size, with the width), a finger
// reaches them from further away, and Alt+Shift+arrows do the same from the keyboard. The arithmetic is src/text-resize.ts.

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

const text = (extra: Partial<BaseObj> = {}): BaseObj => ({ id: 't', type: 'text', x: 100, y: 100, w: 200, h: 26, rotation: 0, z: 'a0', text: 'Hello Tabula', fontSize: 20, ...extra } as BaseObj);

function harness(o: BaseObj = text()) {
  const store = new Store(new Y.Doc());
  store.transact(() => store.create(o));
  store.undo.clear();
  const r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
  r.setCamera({ x: 0, y: 0, zoom: 1 });
  const app = Object.create(BoardApp.prototype) as Harness;
  const announce = vi.fn<(msg: string) => void>();
  Object.assign(app, {
    store, r, selection: [o.id], tool: { kind: 'select' }, drag: null, longPress: null, pendingFrame: 0, queuedFn: null,
    kbMoving: null, cursorTimer: 1, listeners: new Map(), spaceDown: false, lastPointer: { x: 0, y: 0 }, announce,
    user: { id: 'me', name: 'Me', color: '#326DD3' },
    conn: { awareness: { setLocalStateField() {}, getStates: () => new Map(), clientID: 1 }, comments: { readOnly: () => false, list: () => [] } },
    cardInput: { start() {}, stop() {} }, editor: { active: false, commit() {}, start() {} },
    flow: { handleClick: () => false, isHidden: () => false, isVoting: () => false, activeStep: () => null },
    isPinching: () => false, role: null,
  });
  return { app, store, r, announce };
}

const client = (r: Renderer, p: Point) => { const s = r.toScreen(p); return { clientX: s.x, clientY: s.y }; };
const pointer = (r: Renderer, p: Point, type = 'pointerdown', pointerType = 'mouse') => ({ type, pointerId: 1, pointerType, button: 0, shiftKey: false, altKey: false, preventDefault() {}, ...client(r, p) });
const call = (app: Harness, name: string, ...args: unknown[]) => (app[name] as (...a: unknown[]) => unknown).apply(app, args);
const get = (store: Store) => store.get('t') as BaseObj;

function drag(app: Harness, r: Renderer, from: Point, to: Point, pointerType = 'mouse') {
  call(app, 'onDown', pointer(r, from, 'pointerdown', pointerType));
  for (let i = 1; i <= 4; i++) call(app, 'onMove', pointer(r, { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, 'pointermove', pointerType));
  call(app, 'onUp', pointer(r, to, 'pointerup', pointerType));
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl(), activeElement: null });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => vi.unstubAllGlobals());

describe('the handles of a text', () => {
  it('are the sides and the four corners and the turn handle, never the top and bottom, none when locked', () => {
    const o = text();
    const ids = (x: BaseObj) => handlesFor(x, () => undefined, 1).map((h) => h.id).sort();
    expect(ids(o)).toEqual(['e', 'ne', 'nw', 'rot', 'se', 'sw', 'w']);
    expect(ids(text({ locked: true }))).toEqual([]);
    expect(ids({ ...o, type: 'sticky' } as BaseObj)).toContain('n');
  });
});

describe('the arithmetic', () => {
  const box = { w: 200, h: 26 };
  it('reads a corner pull as a factor along the diagonal', () => {
    expect(cornerFactor(box, 'se', { x: 400, y: 52 })).toBeCloseTo(2);
    expect(cornerFactor(box, 'se', { x: 100, y: 13 })).toBeCloseTo(0.5);
    expect(cornerFactor(box, 'nw', { x: -200, y: -26 })).toBeCloseTo(2);
    expect(cornerFactor(box, 'ne', { x: 400, y: -26 })).toBeCloseTo(2);
    expect(cornerFactor(box, 'sw', { x: -200, y: 52 })).toBeCloseTo(2);
    expect(cornerFactor({ w: 0, h: 0 }, 'se', { x: 5, y: 5 })).toBe(1);
  });

  it('scales type and width together, in whole points, within limits', () => {
    expect(scaledText(text(), 2)).toEqual({ fontSize: 40, w: 400 });
    expect(scaledText(text({ fontSize: undefined }), 1.5)).toEqual({ fontSize: 30, w: 300 });
    expect(scaledText(text(), 0).fontSize).toBe(FONT_MIN);
    expect(scaledText(text(), 1000).fontSize).toBe(FONT_MAX);
    expect(scaledText(text(), Number.NaN)).toEqual({ fontSize: 20, w: 200 });
    expect(scaledText(text({ w: 9 }), 0.1).w).toBeGreaterThanOrEqual(WRAP_MIN);
  });

  it('keeps the opposite corner where it was', () => {
    expect(cornerBox(box, 'se', 400, 52)).toEqual({ l: 0, t: 0, r: 400, b: 52 });
    expect(cornerBox(box, 'nw', 400, 52)).toEqual({ l: -200, t: -26, r: 200, b: 26 });
    expect(cornerBox(box, 'ne', 400, 52)).toEqual({ l: 0, t: -26, r: 400, b: 26 });
    expect(cornerBox(box, 'sw', 400, 52)).toEqual({ l: -200, t: 0, r: 200, b: 52 });
  });

  it('maps the keys: left and right the wrap width, up and down the type with its width', () => {
    expect(keyResize(text(), 'right')).toMatchObject({ w: 200 + WRAP_KEY_STEP });
    expect(keyResize(text(), 'left')).toMatchObject({ w: 200 - WRAP_KEY_STEP });
    expect(keyResize(text({ w: WRAP_MIN }), 'left')).toBeNull();
    expect(keyResize(text(), 'up')).toMatchObject({ fontSize: 21, w: 210 });
    expect(keyResize(text(), 'down')).toMatchObject({ fontSize: 19, w: 190 });
    expect(keyResize(text({ fontSize: FONT_MIN }), 'down')).toBeNull();
    expect(keyResize(text({ fontSize: FONT_MAX }), 'up')).toBeNull();
    expect(keyResize(text(), 'right')!.h).toBeGreaterThan(0);
  });
});

describe('dragging a handle', () => {
  it('a side handle changes the wrap width and leaves the type alone, in one undo step', () => {
    const { app, store, r } = harness();
    drag(app, r, { x: 300, y: 113 }, { x: 420, y: 113 });
    expect(get(store).w).toBeGreaterThan(300);
    expect(styleOf(get(store)).fontSize).toBe(20);
    expect(get(store).x).toBe(100);
    store.undo.undo();
    expect(get(store)).toMatchObject({ w: 200, x: 100 });
  });

  it('a corner scales the type and the width, anchored at the opposite corner, in one undo step', () => {
    const { app, store, r } = harness();
    // the bottom right corner (300, 126) pulled to double the size along the diagonal
    drag(app, r, { x: 300, y: 126 }, { x: 500, y: 152 });
    const o = get(store);
    expect(o.fontSize).toBe(40);
    expect(o.w).toBeCloseTo(400);
    expect(o.x).toBeCloseTo(100);
    expect(o.y).toBeCloseTo(100);
    store.undo.undo();
    expect(get(store)).toMatchObject({ fontSize: 20, w: 200, x: 100, y: 100 });
  });

  it('the top left corner moves the box so that the bottom right stays', () => {
    const { app, store, r } = harness();
    drag(app, r, { x: 100, y: 100 }, { x: 0, y: 87 });
    const o = get(store);
    expect(o.fontSize).toBeGreaterThan(20);
    expect(o.x + o.w).toBeCloseTo(300);
    expect(o.y + o.h).toBeCloseTo(126);
  });

  it('a corner of a turned text keeps the opposite corner at the same place on the board', () => {
    const o0 = text({ rotation: Math.PI / 6 });
    const { app, store, r } = harness(o0);
    const anchor0 = rotate({ x: o0.x, y: o0.y }, center(o0), o0.rotation);
    const corner = rotate({ x: o0.x + o0.w, y: o0.y + o0.h }, center(o0), o0.rotation);
    const pull = { x: anchor0.x + (corner.x - anchor0.x) * 2, y: anchor0.y + (corner.y - anchor0.y) * 2 };
    drag(app, r, corner, pull);
    const o = get(store);
    expect(o.fontSize).toBe(40);
    const anchor1 = rotate({ x: o.x, y: o.y }, center(o), o.rotation);
    expect(anchor1.x).toBeCloseTo(anchor0.x, 3);
    expect(anchor1.y).toBeCloseTo(anchor0.y, 3);
  });

  it('a finger takes a handle from further away than a mouse does', () => {
    const near = { x: 300 + 15, y: 126 + 12 };
    const mouse = harness();
    drag(mouse.app, mouse.r, near, { x: 500, y: 152 }, 'mouse');
    expect(get(mouse.store).fontSize).toBe(20);
    const touch = harness();
    drag(touch.app, touch.r, near, { x: 500, y: 152 }, 'touch');
    expect(get(touch.store).fontSize).toBeGreaterThan(20);
  });

  it('a locked text and a read-only board are not resized', () => {
    const a = harness(text({ locked: true }));
    drag(a.app, a.r, { x: 300, y: 126 }, { x: 500, y: 152 });
    expect(get(a.store)).toMatchObject({ fontSize: 20, w: 200 });
    const b = harness();
    b.store.setReadOnly(true);
    drag(b.app, b.r, { x: 300, y: 126 }, { x: 500, y: 152 });
    expect(get(b.store)).toMatchObject({ fontSize: 20, w: 200 });
  });
});

describe('Alt+Shift+arrows', () => {
  it('widen and narrow the wrap, enlarge and shrink the type, each press one undo step, announced', () => {
    const { app, store, announce } = harness();
    expect(call(app, 'resizeTextByKey', 'right')).toBe(true);
    expect(get(store).w).toBe(200 + WRAP_KEY_STEP);
    expect(announce).toHaveBeenLastCalledWith(`Text width ${200 + WRAP_KEY_STEP}`);
    call(app, 'resizeTextByKey', 'up');
    expect(get(store).fontSize).toBe(21);
    expect(announce).toHaveBeenLastCalledWith('Text size 21');
    store.undo.undo();
    expect(get(store).fontSize).toBe(20);
    store.undo.undo();
    expect(get(store).w).toBe(200);
  });

  it('do nothing to a locked text, or when something else is selected, and say it was not theirs', () => {
    const a = harness(text({ locked: true }));
    expect(call(a.app, 'resizeTextByKey', 'right')).toBe(false);
    expect(get(a.store).w).toBe(200);
    const b = harness();
    b.store.transact(() => b.store.create({ id: 's', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a1', text: 'x' } as BaseObj));
    (b.app as Harness).selection = ['t', 's'];
    expect(call(b.app, 'resizeTextByKey', 'right')).toBe(false);
  });
});
