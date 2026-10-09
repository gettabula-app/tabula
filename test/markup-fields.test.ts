import { DOMParser } from '@xmldom/xmldom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { objectMarkup } from '../src/markup';
import { safeObj } from '../src/safe-obj';
import { thumbnailSvg } from '../src/template-thumb';
import { exportSvg } from '../src/exporters';
import { Renderer } from '../src/render';
import { Store } from '../src/store';
import { validateContent } from '../src/custom-templates';
import type { BoardApp } from '../src/app';
import type { BaseObj, ConnectorObj, Head, Id, Obj, ObjType, Rect } from '../src/types';

// TAB-203, beyond colours: every stored field that reaches an SVG attribute (viewBox, numbers, enumerations, connector
// ends, points, members, fonts) is read through safeObj (src/safe-obj.ts), so a value written by another client, a file
// or a tool cannot end an attribute early. An exported SVG has no CSP, so this is the only thing that stops it there.

const BREAK = 'x" onload="alert(1)" data-evil="<b>\'';
const BREAKOUTS: unknown[] = [BREAK, "0' onmouseover='alert(1)", '1"/><script>alert(1)</script>', 'url(//evil.example/x)', '</svg><svg onload=alert(1)>', { toString: () => BREAK }, [BREAK], Infinity, NaN];

const TYPES: ObjType[] = [
  'shape', 'sticky', 'text', 'frame', 'icon', 'image', 'path', 'container', 'lane', 'card',
  'uml-class', 'uml-actor', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-initial', 'uml-final', 'uml-component',
];
const HEADS: Head[] = ['arrow', 'open', 'triangle', 'diamond', 'diamond-open', 'circle', 'bar', 'crow-many', 'crow-one'];

/**
 * Every field of the object model, set to `bad`, on top of a good object of `type` (so it still draws). Not `body`: an
 * icon body is markup by design and has its own sanitiser (sanitizeSvgBody, which parses it with the browser's DOMParser).
 */
function everyField(type: ObjType, bad: unknown): Obj {
  const fields = [
    'x', 'y', 'w', 'h', 'rotation', 'kind', 'name', 'text', 'fill', 'stroke', 'strokeWidth', 'dash', 'opacity', 'font', 'fontWeight',
    'fontSize', 'textColor', 'align', 'valign', 'ref', 'viewBox', 'sticker', 'asset', 'mime', 'nw', 'nh', 'alt', 'points',
    'stereotype', 'attributes', 'operations', 'layout', 'rank', 'laneW', 'stage', 'wip', 'wipMode', 'desc', 'ownerName', 'due', 'labels',
  ];
  const o: Record<string, unknown> = { id: `o-${type}`, type, x: 10, y: 20, w: 160, h: 120, rotation: 0, z: 'a0', text: 'T', body: '<path d="M0 0h24v24H0z"/>', points: [0, 0, 40, 40] };
  for (const f of fields) o[f] = bad;
  o.id = `o-${type}`;
  o.type = type;
  return o as unknown as Obj;
}

const goodBox = (type: ObjType): Obj => ({
  id: `g-${type}`, type, x: 10, y: 20, w: 160, h: 120, rotation: 0.3, z: 'a0', text: 'T', name: 'N', kind: 'cylinder', stereotype: 's',
  body: '<path d="M0 0h24v24H0z"/>', viewBox: [0, 0, 24, 24], points: [0, 0, 40, 40, 80, 10], dash: 'dashed', opacity: 0.5, alt: 'a', nw: 10, nh: 10,
  attributes: [{ visibility: '+', name: 'a', type: 'int', isStatic: true }], operations: [{ visibility: '-', name: 'f()', type: '', isAbstract: true }],
} as unknown as Obj);

const connector = (extra: Record<string, unknown>): ConnectorObj => ({
  id: 'c1', type: 'connector', z: 'a1', route: 'elbow', startHead: 'diamond', endHead: 'arrow', label: 'L', relation: 'aggregation',
  from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'bound', id: 'g-shape', anchor: 'left' }, ...extra,
} as unknown as ConnectorObj);

/** Element and attribute names in markup, parsed as XML: a breakout either fails to parse or shows up here. */
function parse(markup: string): { names: Set<string>; attrs: Set<string>; values: string[]; errors: string[] } {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level: string, msg: string) => { if (level !== 'warning') errors.push(msg); } })
    .parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
  const names = new Set<string>(), attrs = new Set<string>(), values: string[] = [];
  interface El { nodeName: string; attributes: ArrayLike<{ name: string; value: string }>; childNodes: ArrayLike<{ nodeType: number }> }
  const walk = (el: El) => {
    names.add(el.nodeName);
    for (let i = 0; i < el.attributes.length; i++) {
      attrs.add(el.attributes[i].name);
      values.push(el.attributes[i].value);
    }
    for (let i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 1) walk(el.childNodes[i] as unknown as El);
  };
  if (doc.documentElement) walk(doc.documentElement as unknown as El);
  return { names, attrs, values, errors };
}

const ctxWith = (objs: Obj[]) => ({ get: (id: string) => objs.find((o) => o.id === id) });

// The attributes and elements the markup draws with good data: the hostile output may use these and nothing else.
const baseline = (() => {
  const objs = TYPES.map(goodBox);
  let markup = objs.map((o) => objectMarkup(o, ctxWith(objs))).join('');
  for (const head of HEADS) markup += objectMarkup(connector({ startHead: head, endHead: head }), ctxWith(objs));
  markup += objectMarkup({ ...goodBox('sticky'), id: 'h' } as Obj, { ...ctxWith(objs), isHidden: () => true });
  const p = parse(markup);
  // presentation attributes of text the kanban draws only for some states (label chips, due dates), never data-driven names
  for (const a of ['letter-spacing', 'text-decoration', 'font-style', 'dominant-baseline']) p.attrs.add(a);
  return { attrs: p.attrs, names: p.names };
})();

describe('every stored field set to a breakout payload', () => {
  for (const type of TYPES) {
    it.each(BREAKOUTS.map((v) => [v]))(`${type}: %j`, (bad) => {
      const objs = [everyField(type, bad), goodBox('shape')];
      const out = objectMarkup(objs[0], ctxWith(objs));
      const p = parse(out);
      expect(p.errors).toEqual([]);
      expect([...p.attrs].filter((a) => !baseline.attrs.has(a))).toEqual([]);
      expect([...p.names].filter((n) => !baseline.names.has(n))).toEqual([]);
      expect([...p.attrs].filter((a) => /^on/i.test(a))).toEqual([]);
      expect(p.values.filter((v) => v.includes('<') || /url\((?!#sticky-)/.test(v) || /alert|evil/.test(v))).toEqual([]);
    });
  }

  it.each(BREAKOUTS.map((v) => [v]))('connector with every field hostile: %j', (bad) => {
    const objs = [goodBox('shape')];
    for (const field of ['route', 'startHead', 'endHead', 'relation', 'label', 'strokeWidth', 'opacity', 'dash']) {
      for (const end of [{ kind: 'free', x: bad, y: bad }, { kind: 'bound', id: 'g-shape', anchor: bad }, bad]) {
        const out = objectMarkup(connector({ [field]: bad, from: end, to: { kind: 'free', x: 300, y: 40 } }), ctxWith(objs));
        const p = parse(out);
        expect(p.errors).toEqual([]);
        expect([...p.attrs].filter((a) => !baseline.attrs.has(a))).toEqual([]);
      }
    }
  });
});

describe('the sinks one by one', () => {
  const draw = (o: Record<string, unknown>, objs: Obj[] = []) => objectMarkup(o as unknown as Obj, ctxWith(objs));

  it('icon viewBox: the reported breakout', () => {
    const out = draw({ ...goodBox('icon'), viewBox: ['0" onload="alert(1)', 0, 24, 24] });
    expect(out).not.toContain('onload');
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(draw({ ...goodBox('icon'), viewBox: [0, 0, '24"', 24] })).toContain('viewBox="0 0 24 24"');
  });

  it('a free connector end with a string coordinate (it went into d="M… " as it was)', () => {
    const out = draw(connector({ route: 'straight', startHead: 'none', endHead: 'none', from: { kind: 'free', x: '0" onload="alert(1)', y: 0 }, to: { kind: 'free', x: 10, y: 10 } }) as unknown as Record<string, unknown>);
    expect(out).not.toContain('onload');
    expect(out).toMatch(/d="M0 0L10 10"/);
  });

  it('a bound end on a box whose x is a string', () => {
    const box = { ...goodBox('shape'), x: '5" onload="alert(1)' } as unknown as Obj;
    const out = draw(connector({ route: 'straight', to: { kind: 'bound', id: 'g-shape', anchor: 'left' } }) as unknown as Record<string, unknown>, [box]);
    expect(out).not.toContain('onload');
  });

  it('enumerations outside their set fall back', () => {
    const o = safeObj({ ...goodBox('shape'), kind: 'blob"', dash: 'x', align: 'y', valign: 'z' } as unknown as Obj) as BaseObj;
    expect(o.kind).toBe('rect');
    expect(o.dash).toBeUndefined();
    expect(o.align).toBeUndefined();
    const c = safeObj(connector({ route: 'r"', startHead: '"', endHead: 1, relation: 'constructor' })) as ConnectorObj;
    expect([c.route, c.startHead, c.endHead, c.relation]).toEqual(['straight', 'none', 'none', undefined]);
  });

  it('text, members and fonts that are not strings do not break drawing', () => {
    const o = { ...goodBox('uml-class'), text: 7, attributes: 'abc', operations: [null, { name: 3, visibility: '"' }], font: 'x"; color: red', stereotype: {} };
    const out = draw(o);
    expect(parse(out).errors).toEqual([]);
    expect(out).not.toContain('color: red');
    expect(safeObj(o as unknown as Obj)).toMatchObject({ attributes: [], operations: [{ name: '', visibility: '', type: '' }] });
  });

  it('path points that are not numbers draw nothing rather than the payload', () => {
    const out = draw({ ...goodBox('path'), points: [0, 0, '1" onload="alert(1)', 4] });
    expect(out).not.toContain('onload');
  });
});

describe('thumbnails and exports', () => {
  it.each(BREAKOUTS.map((v) => [v]))('thumbnailSvg of hostile objects: %j', (bad) => {
    const objs = [...TYPES.map((t) => everyField(t, bad)), goodBox('shape')];
    const svg = thumbnailSvg(objs);
    const p = parse(svg.replace(/^<svg[^>]*>|<\/svg>$/g, ''));
    expect(p.errors).toEqual([]);
    expect([...p.attrs].filter((a) => /^on/i.test(a))).toEqual([]);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="[-\d. NaN]+" /);
  });

  it.each(BREAKOUTS.map((v) => [v]))('exportSvg of a board poisoned through raw Yjs: %j', (bad) => {
    const store = new Store(new Y.Doc());
    store.doc.transact(() => {
      for (const o of [...TYPES.map((t) => everyField(t, bad)), connector({ from: { kind: 'free', x: bad, y: bad }, route: bad })]) {
        store.objects.set(o.id, new Y.Map(Object.entries(o)));
      }
    });
    const app = { store, r: { contentBounds: (): Rect => ({ x: 0, y: 0, w: 400, h: 400 }), ctx: { get: (id: string) => store.getPlaced(id) } } } as unknown as BoardApp;
    const { svg } = exportSvg(app, undefined, { fontCss: '' });
    const p = parse(svg.replace(/^<svg[^>]*>|<\/svg>$/g, ''));
    expect(p.errors).toEqual([]);
    expect([...p.attrs].filter((a) => /^on/i.test(a))).toEqual([]);
    expect(p.values.filter((v) => v.includes('<') || /alert|evil/.test(v))).toEqual([]);
  });
});

describe('a template file with fields the markup could not trust', () => {
  const content = (o: Record<string, unknown>) => ({ objects: [{ id: 'a', type: 'icon', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: '1', ...o }], steps: [], bounds: { x: 0, y: 0, w: 10, h: 10 } });

  it('is refused', () => {
    expect(() => validateContent(content({ viewBox: ['0" onload="x', 0, 24, 24] }))).toThrow(/viewBox/);
    expect(() => validateContent(content({ viewBox: [0, 0, 24] }))).toThrow(/viewBox/);
    expect(() => validateContent(content({ type: 'path', points: [0, '1"'] }))).toThrow(/points/);
    expect(() => validateContent(content({ type: 'shape', kind: 'blob"' }))).toThrow(/unknown kind/);
    expect(() => validateContent(content({ type: 'shape', align: 'x' }))).toThrow(/unknown align/);
    expect(() => validateContent(content({ viewBox: [0, 0, 24, 24] }))).not.toThrow();
  });
});

// Just enough of a page for the Renderer (see test/connector-render.test.ts).
class FakeEl {
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  classList = { add() {} };
  className = '';
  nextSibling = null;
  firstChild = null;
  innerHTML = '';
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

describe('the renderer overlays with poisoned storage', () => {
  let store: Store;
  let r: Renderer;
  const overlay = () => {
    (r as unknown as { renderOverlay(): void }).renderOverlay();
    return (r as unknown as { overlayLayer: FakeEl }).overlayLayer.innerHTML;
  };

  beforeEach(() => {
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

  it.each(BREAKOUTS.map((v) => [v]))('selection, hover, drop target, guides and pins stay well formed with %j', (bad) => {
    const objs = [everyField('shape', bad), everyField('frame', bad), connector({ from: { kind: 'free', x: bad, y: bad }, to: { kind: 'bound', id: 'o-shape', anchor: 'left' } })];
    store.doc.transact(() => objs.forEach((o) => store.objects.set(o.id, new Y.Map(Object.entries(o)))));
    const ids: Id[] = objs.map((o) => o.id);
    r.setOverlay({
      selection: ids, hover: 'c1', dropTarget: 'o-frame', lockedHover: null,
      guides: [{ kind: 'line', x1: bad, y1: 0, x2: 10, y2: bad } as never, { kind: 'gap', axis: 'x', from: bad, to: 10, at: bad, label: BREAK } as never],
    });
    r.setPins([{ id: 't', x: bad as number, y: bad as number, label: 'A', color: '#326DD3', resolved: false, count: 1, selected: false }]);
    const out = overlay();
    const p = parse(out);
    expect(p.errors).toEqual([]);
    expect([...p.attrs].filter((a) => /^on/i.test(a))).toEqual([]);
    expect(p.values.filter((v) => v.includes('<') || /alert|evil/.test(v))).toEqual([]);
  });

  it('a grid size that is not a positive number does not hang the renderer', () => {
    for (const bad of [0, -1, NaN, '24" onload="x', Infinity]) {
      (r as unknown as { gridSize: unknown }).gridSize = bad;
      (r as unknown as { gridType: string }).gridType = 'dots';
      (r as unknown as { renderGrid(): void }).renderGrid();
      expect((r as unknown as { gridDefs: FakeEl }).gridDefs.innerHTML).toContain('width="');
    }
  });
});
