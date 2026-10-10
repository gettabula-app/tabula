import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { Renderer } from '../src/render';
import { Store } from '../src/store';
import { textHeight } from '../src/markup';
import type { BaseObj, Obj, Point } from '../src/types';

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
  setPointerCapture() {}
  querySelector() { return new FakeEl(); }
  getBoundingClientRect() { return { width: 1600, height: 1200, left: 0, top: 0 }; }
  getContext() { return null; }
}

type Harness = BoardApp & Record<string, unknown>;

const sticky = (id: string, x = 100, y = 100): BaseObj => ({
  id, type: 'sticky', x, y, w: 192, h: 192, rotation: 0, z: 'a0', text: 'Keep me', fill: '#FFE16B',
});

function harness(seed: Obj[] = []) {
  const store = new Store(new Y.Doc());
  store.transact(() => seed.forEach((o) => store.create(o)));
  store.undo.clear();
  const r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
  r.setCamera({ x: 0, y: 0, zoom: 1 });
  const app = Object.create(BoardApp.prototype) as Harness;
  Object.assign(app, {
    store, r, selection: [], scope: null, tool: { kind: 'select' }, drag: null, longPress: null, pendingFrame: 0, queuedFn: null,
    kbMoving: null, cursorTimer: 1, listeners: new Map(), spaceDown: false,
    lastPointer: { x: 240, y: 180 }, clipboard: [], user: { id: 'me', name: 'Me', color: '#326DD3' },
    notify: vi.fn<(message: string) => void>(), announce: vi.fn<(message: string) => void>(), emit() {},
    conn: { awareness: { setLocalStateField() {}, getStates: () => new Map(), clientID: 1 }, comments: { readOnly: () => false, list: () => [] } },
    editor: { active: false, commit() {}, start() {} },
    cardInput: { active: false, start() {}, stop() {} },
    flow: { handleClick: () => false, isHidden: () => false, isVoting: () => false, activeStep: () => null },
    isPinching: () => false,
  });
  return { app, store, r };
}

const objects = (store: Store) => [...store.cache.values()];
const texts = (store: Store) => objects(store).filter((o) => o.type === 'text') as BaseObj[];
const setPointer = (app: Harness, p: Point) => { Reflect.set(app, 'lastPointer', p); };

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

describe('plain text paste', () => {
  it('creates one text object for a single line, sized to its content and centred at the pointer', () => {
    const { app, store } = harness();
    setPointer(app, { x: 240, y: 180 });

    app.pasteText('Just one line');

    const [o] = texts(store);
    expect(texts(store)).toHaveLength(1);
    expect(o).toMatchObject({ type: 'text', text: 'Just one line' });
    expect(o.w).toBeLessThan(360);
    expect(o.h).toBe(textHeight(o));
    expect({ x: o.x + o.w / 2, y: o.y + o.h / 2 }).toEqual({ x: 240, y: 180 });
    expect(app.selection).toEqual([o.id]);
  });

  it('keeps every line in one text object, including runs of three blank lines', () => {
    const { app, store } = harness();
    const pasted = 'First line\nSecond line\n\n\n\nFourth line';

    app.pasteText(pasted);

    expect(texts(store)).toHaveLength(1);
    expect(texts(store)[0].text).toBe(pasted);
  });

  it('wraps a long line at 360 board units and sizes the height to the wrapped text', () => {
    const { app, store } = harness();
    const pasted = 'w'.repeat(400);

    app.pasteText(pasted);

    expect(texts(store)).toHaveLength(1);
    expect(texts(store)[0]).toMatchObject({ text: pasted, w: 360 });
    expect(texts(store)[0].h).toBe(textHeight(texts(store)[0]));
    expect(texts(store)[0].h).toBeGreaterThan(26);
  });

  it('normalizes CRLF and trims only leading and trailing blank lines', () => {
    const { app, store } = harness();

    app.pasteText('\r\n\r\nFirst\r\n\r\n\r\nLast\r\n');

    expect(texts(store)).toHaveLength(1);
    expect(texts(store)[0].text).toBe('First\n\n\nLast');
  });

  it('uses the viewport centre when the last pointer is outside the viewport', () => {
    const { app, store, r } = harness();
    setPointer(app, { x: 5000, y: 5000 });

    app.pasteText('At the centre');

    const [o] = texts(store);
    expect(texts(store)).toHaveLength(1);
    expect({ x: o.x + o.w / 2, y: o.y + o.h / 2 }).toEqual({
      x: r.viewport().x + r.viewport().w / 2,
      y: r.viewport().y + r.viewport().h / 2,
    });
  });

  it('cuts pasted text at the board limit and notifies the person', () => {
    const { app, store } = harness();

    app.pasteText('x'.repeat(4100));

    expect(texts(store)).toHaveLength(1);
    expect(texts(store)[0].text).toBe('x'.repeat(4000));
    expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/cut.*4,000/i));
  });

  it('parents the pasted text to the frame at the paste point, including a locked nested frame', () => {
    const { app, store } = harness([
      { id: 'outer', type: 'frame', x: 40, y: 30, w: 500, h: 500, rotation: 0, z: 'a0', name: 'Outer' } as BaseObj,
      { id: 'inner', type: 'frame', x: 120, y: 110, w: 280, h: 260, rotation: 0, z: 'a1', name: 'Inner', parent: 'outer', locked: true } as BaseObj,
    ]);
    setPointer(app, { x: 220, y: 200 });

    app.pasteText('Inside the frame');

    expect(texts(store)).toHaveLength(1);
    expect(texts(store)[0].parent).toBe('inner');
  });

  it('leaves a selected sticky unchanged and selects the new text', () => {
    const original = sticky('keep');
    const { app, store } = harness([original]);
    app.setSelection(['keep']);
    const before = structuredClone(store.get('keep'));

    app.pasteText('A new object');

    expect(store.get('keep')).toEqual(before);
    expect(texts(store)).toHaveLength(1);
    expect(app.selection).toEqual([texts(store)[0].id]);
  });

  it('adds the pasted text in one undo step', () => {
    const { app, store } = harness([sticky('keep')]);
    const previousUndoDepth = store.undo.undoStack.length;

    app.pasteText('Undo me');

    const [pasted] = texts(store);
    expect(store.undo.undoStack).toHaveLength(previousUndoDepth + 1);
    store.undo.undo();
    expect(store.get(pasted.id)).toBeUndefined();
  });

  it('keeps internal driftboard paste on the object-copy path', () => {
    const { app, store } = harness([sticky('source')]);
    Reflect.set(app, 'clipboard', [structuredClone(store.get('source')!)]);
    setPointer(app, { x: 300, y: 260 });

    app.pasteInternal();

    const stickies = objects(store).filter((o) => o.type === 'sticky');
    expect(stickies).toHaveLength(2);
    expect(stickies.find((o) => o.id !== 'source')).toMatchObject({ type: 'sticky', text: 'Keep me' });
    expect(texts(store)).toHaveLength(0);
    expect(app.selection).toHaveLength(1);
    expect(app.selection[0]).not.toBe('source');
  });
});
