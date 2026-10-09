import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Renderer } from '../src/render';
import { Store } from '../src/store';
import { addCard, moveCards, newKanban } from '../src/containers';
import type { Id } from '../src/types';

// docs/kanban.md, slice 2: what the renderer redraws and tweens.

const els: FakeEl[] = [];
const writes = new Map<Id, string[]>();

class FakeEl {
  dataset: Record<string, string> = {};
  style: Record<string, string> & { setProperty(): void } = Object.assign(Object.create(null), { setProperty() {} });
  classList = { add() {} };
  className = '';
  nextSibling = null;
  firstChild = null;
  private html = '';
  constructor() {
    els.push(this);
  }
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
  removeAttribute() {}
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

let reduced = false;
let frames: (() => void)[] = [];

function setup() {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  const ids = ['A', 'B', 'C'].map((t) => addCard(store, lanes[0].id, t, { createdBy: 'me' })!);
  const r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
  r.setCamera({ x: -100, y: -100, zoom: 1 });
  const draw = () => (r as unknown as { renderObjects(): void }).renderObjects();
  draw();
  return { store, r, draw, container: container.id, lanes: lanes.map((l) => l.id), ids };
}

const elOf = (id: Id) => els.filter((e) => e.dataset.id === id).at(-1)!;
const count = (id: Id) => writes.get(id)?.length ?? 0;

beforeEach(() => {
  els.length = 0;
  writes.clear();
  reduced = false;
  frames = [];
  vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl() });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { frames.push(f); return frames.length; });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') && reduced }));
});

afterEach(() => vi.unstubAllGlobals());

describe('redrawing a kanban', () => {
  it('redraws both lanes and the container header when a card moves between lanes', () => {
    const { store, draw, container, lanes, ids } = setup();
    const before = [container, ...lanes].map(count);
    moveCards(store, [ids[2]], lanes[1], 0);
    draw();
    expect([container, ...lanes].map(count).map((n, i) => n - before[i])).toEqual([1, 1, 1, 1]);
    expect(writes.get(lanes[1])!.at(-1)).toMatch(/>1<\/text>/);
  });

  it('redraws what is on screen of every kanban when the zoom crosses 0.4, and not otherwise', () => {
    const { r, draw, ids } = setup();
    const n = count(ids[0]);
    r.setCamera({ zoom: 0.5 });
    draw();
    expect(count(ids[0])).toBe(n);
    r.setCamera({ zoom: 0.3 });
    draw();
    expect(count(ids[0])).toBe(n + 1);
    expect(writes.get(ids[0])!.at(-1)).not.toContain('>A<');
  });

  it('draws dragged cards as placeholders and redraws only what the drag touches', () => {
    const { r, draw, lanes, ids } = setup();
    const others = [ids[1], ids[2], lanes[2]].map(count);
    r.setKanbanState({ dragging: new Set([ids[0]]), dropLane: lanes[1] });
    draw();
    expect(writes.get(ids[0])!.at(-1)).toContain('stroke-dasharray');
    expect(writes.get(lanes[1])!.at(-1)).toContain('DROP HERE');
    expect([ids[1], ids[2], lanes[2]].map(count)).toEqual(others);
    r.setKanbanState({ dragging: new Set(), dropLane: null });
    draw();
    expect(writes.get(ids[0])!.at(-1)).toContain('>A<');
  });
});

describe('the drop tween', () => {
  it('slides a card the layout moved from where it was drawn, over 120 ms', () => {
    const { store, draw, lanes, ids } = setup();
    moveCards(store, [ids[0]], lanes[0], 3);
    draw();
    const b = elOf(ids[1]);
    expect(b.style.transform).toMatch(/^translate\(0px, \d+px\)$/);
    frames.forEach((f) => f());
    expect(b.style.transition).toBe('transform 120ms ease-out');
    expect(b.style.transform).toBe('');
  });

  it('snaps with reduced motion', () => {
    const { store, draw, lanes, ids } = setup();
    reduced = true;
    moveCards(store, [ids[0]], lanes[0], 3);
    draw();
    expect(elOf(ids[1]).style.transform).toBeUndefined();
  });

  it('does not tween what moves because its container moved', () => {
    const { store, draw, container, ids } = setup();
    store.transact(() => store.update(container, { x: 300 }));
    draw();
    expect(elOf(ids[1]).style.transform).toBeUndefined();
  });
});

// What a click hits is tested on BoardApp.hit itself, in test/kanban-app.test.ts.
