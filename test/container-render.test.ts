import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { objectMarkup } from '../src/markup';
import { Renderer, handlesFor } from '../src/render';
import { Store } from '../src/store';
import type { BaseObj, Id } from '../src/types';

// docs/kanban.md, slice 1: what the renderer and the markup do with containers, lanes and cards before slice 2 draws them.

// Just enough of a page for the Renderer: every drawn object is a <g> whose markup is written once per draw.
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

const box = (id: Id, type: BaseObj['type'], extra: Partial<BaseObj> = {}): BaseObj => ({ id, type, x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a0', ...extra });
const ctx = { get: () => undefined };

describe('a container removed while its lanes and cards stay', () => {
  let store: Store;
  let r: Renderer;
  const draw = () => (r as unknown as { renderObjects(): void }).renderObjects();
  const last = (id: Id) => writes.get(id)?.at(-1) ?? '';

  beforeEach(() => {
    writes.clear();
    vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(box('c', 'container', { layout: 'kanban', x: 100, y: 100, name: 'Board' }));
      store.create(box('l', 'lane', { parent: 'c', rank: 'a0@c', x: 700, y: 700, w: 30, h: 30 }));
      store.create(box('k', 'card', { parent: 'l', rank: 'a0@l', x: 555, y: 600, w: 40, h: 72 }));
    });
    r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
    draw();
  });

  afterEach(() => {
    r.destroy();
    vi.unstubAllGlobals();
  });

  it('draws the card where the layout puts it, then at its stored place, then where the layout puts it again', () => {
    const derived = store.geometry(store.get('k')!);
    expect(derived).toEqual({ x: 100 + 12 + 8, y: 100 + 48 + 12 + 48 + 8, w: 264, h: 72 });
    expect(r.bounds(store.get('k')!)).toEqual(derived);
    expect(last('k')).toContain(`translate(${derived.x} ${derived.y})`);

    store.undo.stopCapturing();
    store.transact(() => store.remove(['c']));
    store.undo.stopCapturing();
    // the bounds the renderer holds and the markup in the DOM both follow, not only the removed container
    expect(r.bounds(store.get('k')!)).toEqual({ x: 555, y: 600, w: 40, h: 72 });
    expect(r.bounds(store.get('l')!)).toEqual({ x: 700, y: 700, w: 30, h: 30 });
    draw();
    expect(last('k')).toContain('translate(555 600)');
    expect(last('l')).toContain('translate(700 700)');

    store.undo.undo();
    expect(r.bounds(store.get('k')!)).toEqual(derived);
    draw();
    expect(last('k')).toContain(`translate(${derived.x} ${derived.y})`);
    expect(last('c')).toContain('Board');
  });
});

describe('handles', () => {
  const get = () => undefined;

  it('has none on a container, a lane or a card: their size and place come from the layout', () => {
    for (const type of ['container', 'lane', 'card'] as const) expect(handlesFor(box('x', type, { w: 200, h: 100 }), get, 1)).toEqual([]);
  });

  it('still has them on other boxes', () => {
    const ids = handlesFor(box('s', 'sticky', { w: 200, h: 100 }), get, 1).map((h) => h.id);
    expect(ids).toContain('se');
    expect(ids).toContain('rot');
  });
});

describe('markup for containers, lanes and cards', () => {
  const outsideVars = (svg: string) => svg.replace(/var\([^)]*\)/g, '');

  it('draws a hairline box with a name for each, so none is an invisible region', () => {
    const container = objectMarkup(box('c', 'container', { layout: 'kanban', name: 'Sprint', w: 300, h: 200 }), ctx);
    const lane = objectMarkup(box('l', 'lane', { w: 280, h: 160 }), ctx);
    const card = objectMarkup(box('k', 'card', { w: 264, h: 72 }), ctx);
    expect(container).toContain('width="300" height="200"');
    expect(container).toContain('>Sprint</text>');
    expect(lane).toContain('>Lane</text>');
    expect(card).toContain('>Card</text>');
    for (const svg of [container, lane, card]) {
      expect(svg).toContain('<rect ');
      expect(svg).toContain('stroke-width="1"');
    }
  });

  it('draws a container whose layout it does not know with a note, and a known one without', () => {
    expect(objectMarkup(box('c', 'container', { layout: 'timeline', name: 'Plan' }), ctx)).toContain('Needs a newer Tabula');
    expect(objectMarkup(box('c', 'container', { name: 'Plan' }), ctx)).toContain('Needs a newer Tabula');
    expect(objectMarkup(box('c', 'container', { layout: 'kanban', name: 'Plan' }), ctx)).not.toContain('Needs a newer Tabula');
  });

  it('names an unnamed container, and cannot be fed markup through a name', () => {
    expect(objectMarkup(box('c', 'container', { layout: 'kanban' }), ctx)).toContain('>Container</text>');
    const evil = objectMarkup(box('c', 'container', { layout: 'kanban', name: '</text><script>x</script>' }), ctx);
    expect(evil).not.toContain('<script');
    expect(evil).toContain('&lt;script&gt;');
  });

  it('uses theme variables for colour, with no hard-coded colour outside their fallbacks', () => {
    for (const o of [box('c', 'container', { layout: 'kanban' }), box('l', 'lane'), box('k', 'card')]) {
      const svg = outsideVars(objectMarkup(o, ctx));
      expect(svg).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|\b(?:white|black)\b/i);
      expect(objectMarkup(o, ctx)).toContain('var(--canvas-ink');
    }
  });
});
