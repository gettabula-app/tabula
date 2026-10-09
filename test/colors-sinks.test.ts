import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { isSafeColor } from '../shared/colors';
import { DEFAULTS } from '../src/markup';
import { CANVAS_INK, FILLS, INK, PAPER, STICKY_COLORS, STROKES, TEXT_COLORS, USER_COLORS, personColor } from '../src/palette';
import { Renderer } from '../src/render';
import { Store } from '../src/store';
import { exportSvg } from '../src/exporters';
import { editColours } from '../src/editor';
import { clearGhostText, ghostMarkup, ghostSource, labelColors, personColor as runColor } from '../src/ai-live-logic';
import { layoutProposal, type Existing, type Layout, type Rect } from '../src/ai-apply';
import type { LiveRun } from '../src/ai-runs';
import type { BoardApp } from '../src/app';
import type { Id, Obj } from '../src/types';
import { HOSTILE_VALUES, markupProblems } from './hostile-colors';

// TAB-203, the render side: what is in storage may be poisoned (another client, an old file, a raw Yjs update), so
// every place that writes a stored or remote colour into markup or CSS draws only colours of the grammar.

const cases = HOSTILE_VALUES.map((v) => [v] as [unknown]);

/** Writes objects straight into Yjs, past the store's own checks, as a remote client or an old file could. */
function poison(store: Store, objs: Record<string, unknown>[]) {
  store.doc.transact(() => {
    for (const o of objs) store.objects.set(o.id as string, new Y.Map(Object.entries(o)));
  });
}

const poisonedBoard = (bad: unknown): Record<string, unknown>[] => [
  { id: 'a', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: 'a0', text: 'hi', fill: bad, textColor: bad },
  { id: 'b', type: 'shape', kind: 'rect', x: 300, y: 0, w: 100, h: 80, rotation: 0, z: 'a1', fill: bad, stroke: bad, textColor: bad, text: 'b' },
  { id: 'f', type: 'frame', x: 0, y: 300, w: 300, h: 200, rotation: 0, z: 'a2', name: 'F', fill: bad, stroke: bad, textColor: bad },
  { id: 'i', type: 'icon', x: 400, y: 300, w: 48, h: 48, rotation: 0, z: 'a3', body: '<path d="M0 0h24v24H0z"/>', textColor: bad, stroke: bad },
  { id: 'p', type: 'path', x: 0, y: 600, w: 100, h: 100, rotation: 0, z: 'a4', points: [0, 0, 50, 50, 100, 0], stroke: bad },
  { id: 'u', type: 'uml-class', x: 500, y: 0, w: 200, h: 140, rotation: 0, z: 'a5', text: 'C', fill: bad, stroke: bad, textColor: bad },
  { id: 'c', type: 'connector', z: 'a6', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'b', anchor: 'auto' }, route: 'elbow', startHead: 'diamond', endHead: 'arrow', label: 'x', stroke: bad },
];

describe('colours used as fallbacks are in the grammar themselves', () => {
  it('every default and palette colour', () => {
    const all = [
      ...Object.values(DEFAULTS).flatMap((d) => [d.fill, d.stroke, d.textColor]),
      ...STICKY_COLORS.map((c) => c.fill), ...FILLS.map((c) => c.value), ...STROKES.map((c) => c.value), ...TEXT_COLORS, ...USER_COLORS,
      CANVAS_INK, INK, PAPER,
    ];
    expect(all.filter((c) => !isSafeColor(c))).toEqual([]);
  });
});

describe('presence: a remote person colour from awareness', () => {
  it.each(cases)('personColor(%j) is one of the person colours and never throws', (bad) => {
    expect(USER_COLORS).toContain(personColor(bad));
  });

  it('an AI runner colour that is not #RRGGBB is replaced by a person colour', () => {
    for (const bad of HOSTILE_VALUES) {
      const run = { id: 'r1', by: { id: 'u1', name: 'A', color: bad } } as unknown as LiveRun;
      expect(USER_COLORS).toContain(runColor(run));
      const { fill, ink } = labelColors(bad as string);
      expect(isSafeColor(fill)).toBe(true);
      expect(isSafeColor(ink)).toBe(true);
    }
  });
});

// Just enough of a page for the Renderer (see test/connector-render.test.ts).
const writes = new Map<Id, string[]>();
class FakeEl {
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  classList = { add() {} };
  className = '';
  nextSibling = null;
  firstChild = null;
  private html = '';
  get innerHTML() { return this.html; }
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
  private kids = new Map<string, FakeEl>();
  querySelector(sel: string) {
    if (!this.kids.has(sel)) this.kids.set(sel, new FakeEl());
    return this.kids.get(sel)!;
  }
  getBoundingClientRect() { return { width: 1600, height: 1200, left: 0, top: 0 }; }
  getContext() { return null; }
}

describe('the renderer with poisoned storage and hostile remote colours', () => {
  let store: Store;
  let r: Renderer;
  const drawObjects = () => (r as unknown as { renderObjects(): void }).renderObjects();
  const drawOverlay = () => (r as unknown as { renderOverlay(): void }).renderOverlay();
  const overlay = () => (r as unknown as { overlayLayer: FakeEl }).overlayLayer.innerHTML;

  beforeEach(() => {
    writes.clear();
    vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    store = new Store(new Y.Doc());
    r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
  });

  afterEach(() => {
    r.destroy();
    vi.unstubAllGlobals();
  });

  it.each(cases)('draws every object clean when storage holds %j', (bad) => {
    poison(store, poisonedBoard(bad));
    drawObjects();
    for (const id of ['a', 'b', 'f', 'i', 'p', 'u', 'c']) {
      const out = writes.get(id)?.at(-1) ?? `nothing drawn for ${id}`;
      expect(out).toMatch(/^<g/);
      expect(markupProblems(out)).toEqual([]);
    }
  });

  it.each(cases)('draws a remote selection and a comment pin clean with colour %j', (bad) => {
    poison(store, poisonedBoard('#FFFFFF'));
    r.setOverlay({ remote: [{ ids: ['a', 'b'], color: bad as string }] });
    r.setPins([{ id: 't1', x: 10, y: 10, label: 'A', color: bad as string, resolved: false, count: 2, selected: true }]);
    drawOverlay();
    const out = overlay();
    expect(out).toContain('<rect');
    expect(markupProblems(out)).toEqual([]);
  });

  it.each(cases)('the awareness pipeline (personColor then the overlay) draws one of the person colours for %j', (bad) => {
    poison(store, poisonedBoard('#FFFFFF'));
    r.setOverlay({ remote: [{ ids: ['a'], color: personColor(bad) }] });
    drawOverlay();
    const stroke = /stroke="([^"]+)" stroke-width="[\d.]+" stroke-dasharray/.exec(overlay())?.[1];
    expect(USER_COLORS).toContain(stroke);
  });
});

describe('exports of a poisoned board', () => {
  it.each(cases)('exportSvg has no trace of %j', (bad) => {
    const store = new Store(new Y.Doc());
    poison(store, poisonedBoard(bad));
    const app = {
      store,
      r: { contentBounds: (): Rect => ({ x: 0, y: 0, w: 800, h: 800 }), ctx: { get: (id: string) => store.getPlaced(id) } },
    } as unknown as BoardApp;
    const { svg } = exportSvg(app, undefined, { fontCss: '' });
    expect(svg).toContain('<path');
    expect(markupProblems(svg)).toEqual([]);
  });
});

describe('the text editor over a poisoned object', () => {
  it.each(cases)('editColours never returns %j for an inline style', (bad) => {
    const objs = poisonedBoard(bad) as unknown as Obj[];
    const unsafe: string[] = [];
    for (const o of objs) {
      for (const mode of ['text', 'frame', 'label', 'shape'] as const) {
        const { color, background } = editColours(o, mode as Parameters<typeof editColours>[1]);
        for (const v of [color, background]) if (v !== '' && v !== 'var(--ink)' && !isSafeColor(v)) unsafe.push(`${mode}: ${v}`);
      }
    }
    expect(unsafe).toEqual([]);
  });
});

describe('AI preview ghosts', () => {
  const board = (objects: Record<string, Existing> = {}) => ({ content: { x: 0, y: 0, w: 400, h: 300 } as Rect | null, get: (id: string) => objects[id] });

  it.each(cases)('draws clean ghosts for a runner colour and sticky fill of %j', (bad) => {
    clearGhostText();
    const create = layoutProposal({ kind: 'create', objects: [{ text: 'a' }, { text: 'b' }], frame: { title: 'T' } }, board()) as Layout;
    const objects: Record<string, Existing> = { s: { type: 'sticky', x: 0, y: 0, w: 192, h: 192 } };
    const group = layoutProposal({ kind: 'group', groups: [{ title: 'G', ids: ['s'] }] }, board(objects)) as Layout;
    const env = { px: (v: number) => v, sticky: () => ({ text: 'x', fill: bad as string }) };
    for (const layout of [create, group]) {
      expect(markupProblems(ghostMarkup(layout, { color: bad as string }, env))).toEqual([]);
      expect(markupProblems(ghostMarkup(layout, { color: null }, env))).toEqual([]);
    }
    expect(isSafeColor(ghostSource({ fill: bad as string }, false, '#FFE16B').fill)).toBe(true);
  });
});
