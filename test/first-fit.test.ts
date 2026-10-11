import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Renderer } from '../src/render';
import { FIRST_FIT_WINDOW_MS, watchFirstFit } from '../src/first-fit';
import { Store } from '../src/store';
import type { Obj } from '../src/types';

// The first view of a board whose content arrives after the first frame (a relay that is still syncing): the camera is
// fitted once when it arrives, unless the person has already moved it or made an edit of their own.

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
  querySelector() { return new FakeEl(); }
  getBoundingClientRect() { return { width: 390, height: 844, left: 0, top: 0 }; }
  getContext() { return null; }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl(), activeElement: null });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => vi.unstubAllGlobals());

const note = (id: string, x: number): Obj => ({ id, type: 'sticky', x, y: 0, w: 300, h: 200, z: id, rotation: 0, text: id, updatedAt: 1 }) as never;

/** A relay's board with content, and the update that carries it to a client that opened empty. */
function serverUpdate() {
  const server = new Store(new Y.Doc());
  server.transact(() => { server.create(note('a', 0)); server.create(note('b', 900)); });
  return Y.encodeStateAsUpdate(server.doc);
}

function open() {
  const store = new Store(new Y.Doc());
  const r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
  const clock = { t: 1_000 };
  const fit = watchFirstFit(store, r, () => clock.t);
  return { store, r, fit, clock };
}

const arrive = (store: Store, update: Uint8Array) => Y.applyUpdate(store.doc, update, 'remote');
const phoneFit = (r: Renderer) => {
  const b = r.contentBounds()!;
  const edge = (x: number) => (x - r.cam.x) * r.cam.zoom;
  return { left: edge(b.x), right: edge(b.x + b.w) };
};

describe('the first fit of a board that is empty at the first frame', () => {
  it('fits once when the content arrives later, between the rail and the right edge', () => {
    const { store, r, fit } = open();
    fit.start();
    expect(r.cam).toMatchObject({ zoom: 1, x: -195, y: -422 }); // empty: centred at 100%
    arrive(store, serverUpdate());
    const { left, right } = phoneFit(r);
    expect(r.cam.zoom).toBeLessThan(0.4);
    expect(left).toBeGreaterThanOrEqual(84 - 0.5);
    expect(right).toBeLessThanOrEqual(390 - 16 + 0.5);
  });

  it('fits only once: later changes leave the camera alone', () => {
    const { store, r, fit } = open();
    fit.start();
    arrive(store, serverUpdate());
    const after = { ...r.cam };
    const more = new Store(new Y.Doc());
    more.transact(() => more.create(note('c', 5000)));
    arrive(store, Y.encodeStateAsUpdate(more.doc));
    expect(r.cam).toEqual(after);
  });

  it('does not touch a camera the person has moved', () => {
    const { store, r, fit } = open();
    fit.start();
    r.setCamera({ x: 500, y: 40, zoom: 2 });
    arrive(store, serverUpdate());
    expect(r.cam).toMatchObject({ x: 500, y: 40, zoom: 2 });
  });

  it('does not run after the person\'s own first edit', () => {
    const { store, r, fit } = open();
    fit.start();
    store.transact(() => store.create(note('mine', 0)));
    const own = { ...r.cam };
    arrive(store, serverUpdate());
    expect(r.cam).toEqual(own);
  });

  it('does not run once the sync window has passed', () => {
    const { store, r, clock, fit } = open();
    fit.start();
    clock.t += FIRST_FIT_WINDOW_MS + 1;
    const before = { ...r.cam };
    arrive(store, serverUpdate());
    expect(r.cam).toEqual(before);
  });

  it('still fits at the first frame when the board already has content', () => {
    const store = new Store(new Y.Doc());
    arrive(store, serverUpdate());
    const r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
    const fit = watchFirstFit(store, r);
    fit.start();
    expect(r.cam.zoom).toBeLessThan(0.4);
  });

  it('does not treat a meta redraw (setCamera with no change) as the person moving it', () => {
    const { store, r, fit } = open();
    fit.start();
    r.setCamera({});
    arrive(store, serverUpdate());
    expect(r.cam.zoom).toBeLessThan(0.4);
  });
});
