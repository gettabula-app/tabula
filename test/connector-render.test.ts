import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { Renderer } from '../src/render';
import type { BaseObj, ConnectorObj, End, Id, Side } from '../src/types';

// Just enough of a page for the Renderer to draw into: every drawn object is a <g> whose markup is written once per
// draw, so the number of writes says how often it was redrawn.
const writes = new Map<Id, string[]>();

class FakeEl {
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  classList = { add() {} };
  className = '';
  nextSibling = null;
  firstChild = null;
  private html = '';
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = v;
    const id = this.dataset.id;
    if (id) writes.set(id, [...(writes.get(id) ?? []), v]);
  }
  append() {}
  appendChild() {}
  insertBefore() {}
  remove() {}
  setAttribute() {}
  querySelector() {
    return new FakeEl();
  }
  getBoundingClientRect() {
    return { width: 1600, height: 1200, left: 0, top: 0 };
  }
}

const box = (id: string, x: number, y: number): BaseObj => ({ id, type: 'shape', kind: 'rect', x, y, w: 100, h: 100, rotation: 0, z: 'a0' });

const conn = (id: string, from: End, to: End): ConnectorObj => ({
  id, type: 'connector', z: 'a1', from, to, route: 'straight', startHead: 'none', endHead: 'none',
});

const at = (id: string, anchor: 'auto' | Side): End => ({ kind: 'bound', id, anchor });

describe('Renderer and connector slots', () => {
  let store: Store;
  let r: Renderer;
  const draw = () => (r as unknown as { renderObjects(): void }).renderObjects();
  const drawn = (id: Id) => writes.get(id)?.length ?? 0;

  beforeEach(() => {
    writes.clear();
    vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(box('hub', 0, 0));
      store.create(box('up', 400, -300));
      store.create(box('down', 400, 300));
      store.create(box('far', 3000, 3000));
      store.create(conn('c1', at('hub', 'right'), at('up', 'left')));
    });
    r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
    draw();
  });

  afterEach(() => {
    r.destroy();
    vi.unstubAllGlobals();
  });

  it('draws a lone connector at the anchor', () => {
    expect(drawn('c1')).toBe(1);
    expect(writes.get('c1')![0]).toContain('M100 50L');
  });

  it('redraws a connector, and drops its bounds, when another one joins its side', () => {
    const before = r.bounds(store.get('c1')!)!;
    store.transact(() => store.create(conn('c2', at('hub', 'right'), at('down', 'left'))));
    expect(r.bounds(store.get('c1')!)).not.toEqual(before);
    draw();
    expect(drawn('c1')).toBe(2);
    expect(drawn('c2')).toBe(1);
    expect(writes.get('c1')![1]).toContain('M100 36L');
    expect(writes.get('c2')![0]).toContain('M100 64L');
  });

  it('redraws the one left when a connector leaves', () => {
    store.transact(() => store.create(conn('c2', at('hub', 'right'), at('down', 'left'))));
    draw();
    store.transact(() => store.remove(['c1']));
    draw();
    expect(drawn('c2')).toBe(2);
    expect(writes.get('c2')![1]).toContain('M100 50L');
  });

  it('redraws both when moving a target changes their order', () => {
    store.transact(() => store.create(conn('c2', at('hub', 'right'), at('down', 'left'))));
    draw();
    store.transact(() => store.update('up', { y: 600 }));
    draw();
    expect(writes.get('c1')!.at(-1)).toContain('M100 64L');
    expect(writes.get('c2')!.at(-1)).toContain('M100 36L');
  });

  it('leaves connectors alone when something unrelated changes', () => {
    store.transact(() => store.create(conn('c2', at('hub', 'right'), at('down', 'left'))));
    draw();
    const count = drawn('c1');
    store.transact(() => store.update('far', { x: 3100 }));
    draw();
    expect(drawn('c1')).toBe(count);
  });

  it('gives hit-testing bounds that match what will be drawn, before the next frame', () => {
    store.transact(() => store.create(conn('c2', at('hub', 'right'), at('down', 'left'))));
    // c1 now leaves the hub at y 36 instead of 50
    expect(r.bounds(store.get('c1')!)).toEqual({ x: 100, y: -250, w: 300, h: 286 });
  });

  it('builds the layout once per change', () => {
    const first = r.connectorLayout();
    expect(r.connectorLayout()).toBe(first);
    store.transact(() => store.update('far', { x: 3100 }));
    expect(r.connectorLayout()).not.toBe(first);
  });
});
