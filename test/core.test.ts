import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, LOCAL } from '../src/store';
import type { BaseObj, ConnectorObj } from '../src/types';
import { autoSide, connectorGeom, hitBox, objBounds, toLocal } from '../src/geometry';
import { formatClass, parseClass, parseMember } from '../src/uml';
import { layout, parseMermaid, toMermaid } from '../src/mermaid';
import { objectMarkup, sanitizeSvgBody } from '../src/markup';
import { parseCatalogue } from '../src/fonts';
import { wrap } from '../src/text';

const box = (id: string, x: number, y: number, w = 100, h = 60, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'shape', kind: 'rect', x, y, w, h, rotation: 0, z: 'a0', ...extra,
});

describe('store and CRDT merging', () => {
  it('merges concurrent edits to different fields of one object', () => {
    const d1 = new Y.Doc(), d2 = new Y.Doc();
    const s1 = new Store(d1), s2 = new Store(d2);
    s1.transact(() => s1.create(box('a', 0, 0)));
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    // offline edits on both sides
    s1.transact(() => s1.update('a', { x: 240 }));
    s2.transact(() => s2.update('a', { fill: '#DCEBFF', text: 'Hello' }));
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    for (const s of [s1, s2]) {
      const o = s.get('a') as BaseObj;
      expect(o.x).toBe(240);
      expect(o.fill).toBe('#DCEBFF');
      expect(o.text).toBe('Hello');
    }
  });

  it('keeps objects created on two devices while offline', () => {
    const d1 = new Y.Doc(), d2 = new Y.Doc();
    const s1 = new Store(d1), s2 = new Store(d2);
    s1.transact(() => s1.create(box('one', 0, 0)));
    s2.transact(() => s2.create(box('two', 300, 0)));
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    expect([...s1.cache.keys()].sort()).toEqual(['one', 'two']);
    expect([...s2.cache.keys()].sort()).toEqual(['one', 'two']);
  });

  it('undo only reverts local changes', () => {
    const d = new Y.Doc();
    const s = new Store(d);
    s.transact(() => s.create(box('a', 0, 0)));
    s.undo.stopCapturing();
    // a remote change arrives (non-local origin)
    d.transact(() => s.objects.get('a')!.set('text', 'remote'), 'remote');
    s.undo.stopCapturing();
    s.transact(() => s.update('a', { x: 50 }));
    s.undo.undo();
    expect((s.get('a') as BaseObj).x).toBe(0);
    expect((s.get('a') as BaseObj).text).toBe('remote');
    expect(LOCAL).toBe('local');
  });

  it('orders frames first, then by z key', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(box('top', 0, 0, 10, 10, { z: s.topZ() }));
      s.create({ ...box('frame', 0, 0), type: 'frame', z: s.topZ() });
    });
    s.transact(() => s.create(box('newest', 0, 0, 10, 10, { z: s.topZ() })));
    expect(s.ordered().map((o) => o.id)).toEqual(['frame', 'top', 'newest']);
    const keys = s.topZs(3);
    expect(keys[0] < keys[1] && keys[1] < keys[2]).toBe(true);
  });

  it('indexes connectors by the shapes they are bound to', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(box('a', 0, 0));
      s.create(box('b', 300, 0));
      s.create({ id: 'c', type: 'connector', z: 'a1', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'b', anchor: 'auto' }, route: 'elbow', startHead: 'none', endHead: 'arrow' } as ConnectorObj);
    });
    expect(s.connectorsOf('a').map((c) => c.id)).toEqual(['c']);
    s.transact(() => s.update('c', { to: { kind: 'free', x: 0, y: 0 } }));
    expect(s.connectorsOf('b')).toEqual([]);
  });
});

describe('geometry', () => {
  const get = (m: Record<string, BaseObj>) => (id: string) => m[id];

  it('routes an elbow connector between facing sides', () => {
    const a = box('a', 0, 0), b = box('b', 300, 200);
    const g = connectorGeom(get({ a, b }), { from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'b', anchor: 'auto' }, route: 'elbow' })!;
    expect(g.start).toEqual({ x: 100, y: 30 });
    expect(g.end).toEqual({ x: 300, y: 230 });
    // every segment is horizontal or vertical
    for (let i = 1; i < g.pts.length; i++) {
      const p = g.pts[i - 1], q = g.pts[i];
      expect(p.x === q.x || p.y === q.y).toBe(true);
    }
    expect(g.endDir).toEqual({ x: 1, y: 0 });
  });

  it('picks the side facing the other shape', () => {
    const a = box('a', 0, 0);
    expect(autoSide(a, { x: 50, y: -500 })).toBe('top');
    expect(autoSide(a, { x: 900, y: 40 })).toBe('right');
  });

  it('hit-tests rotated shapes in their own frame', () => {
    const o = box('r', 0, 0, 200, 20, { rotation: Math.PI / 2 });
    // rotated 90° around its centre (100,10): now spans y -90..110 at x 90..110
    expect(hitBox(o, { x: 100, y: -80 }, 0)).toBe(true);
    expect(hitBox(o, { x: 10, y: 10 }, 0)).toBe(false);
    const l = toLocal(o, { x: 100, y: 10 });
    expect(l.x).toBeCloseTo(100);
    expect(l.y).toBeCloseTo(10);
    const b = objBounds(() => undefined, o)!;
    expect(b.w).toBeCloseTo(20);
    expect(b.h).toBeCloseTo(200);
  });
});

describe('UML', () => {
  it('round-trips a class through its text form', () => {
    const o = box('c', 0, 0, 200, 120, {
      type: 'uml-class', text: 'Order', stereotype: 'interface',
      attributes: [{ visibility: '-', name: 'id', type: 'UUID' }],
      operations: [{ visibility: '+', name: 'total()', type: 'Money', isAbstract: true }],
    });
    const text = formatClass(o);
    expect(text).toContain('«interface»');
    const parsed = parseClass(text);
    expect(parsed.text).toBe('Order');
    expect(parsed.stereotype).toBe('interface');
    expect(parsed.attributes).toEqual(o.attributes);
    expect(parsed.operations).toEqual(o.operations);
  });

  it('parses member visibility, type and flags', () => {
    expect(parseMember('static + count: int')).toEqual({ visibility: '+', name: 'count', type: 'int', isStatic: true });
    expect(parseMember('# send(to: User, msg: string): void')).toEqual({ visibility: '#', name: 'send(to: User, msg: string)', type: 'void' });
  });
});

describe('Mermaid', () => {
  const factory = () => {
    let n = 0;
    return {
      box: (type: BaseObj['type'], x: number, y: number, w: number, h: number, extra: Partial<BaseObj>) => ({ id: `b${n++}`, type, x, y, w, h, rotation: 0, z: 'a0', ...extra }) as BaseObj,
      connector: (from: ConnectorObj['from'], to: ConnectorObj['to'], extra: Partial<ConnectorObj>) => ({ id: `c${n++}`, type: 'connector', z: 'a0', from, to, route: 'elbow', startHead: 'none', endHead: 'arrow', ...extra }) as ConnectorObj,
    };
  };

  it('imports a flowchart with shapes, labels and chained edges', () => {
    const p = parseMermaid('flowchart LR\n  A[Start] --> B{Valid?}\n  B -->|yes| C([Done])\n  B -- no --> A\n  C -.-> D[(Log)]');
    expect(p.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([
      ['A', 'rect', 'Start'], ['B', 'diamond', 'Valid?'], ['C', 'terminator', 'Done'], ['D', 'cylinder', 'Log'],
    ]);
    expect(p.edges.map((e) => `${e.from}>${e.to}:${e.label ?? ''}:${e.dashed}`)).toEqual(['A>B::false', 'B>C:yes:false', 'B>A:no:false', 'C>D::true']);
    const objs = layout(p, { x: 0, y: 0 }, factory());
    expect(objs.filter((o) => o.type === 'connector')).toHaveLength(4);
  });

  it('reads a node whose name starts with a keyword as a node, and still skips the keyword lines', () => {
    const p = parseMermaid('flowchart TD\n  style1 --> B\n  clickA --> directionX\n  classes --> endpoint\n  subgraph one\n  B --> C\n  end\n  style B fill:#f9f\n  classDef hot fill:#f00\n  class C hot\n  click C callback\n  linkStyle 0 stroke:#f00\n  direction LR');
    expect(p.nodes.map((n) => n.id)).toEqual(['style1', 'B', 'clickA', 'directionX', 'classes', 'endpoint', 'C']);
    expect(p.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['style1>B', 'clickA>directionX', 'classes>endpoint', 'B>C']);
  });

  it('imports a class diagram with relations pointing the right way', () => {
    const p = parseMermaid('classDiagram\n  class Animal {\n    +name: string\n    +speak() void\n  }\n  Animal <|-- Duck\n  Order *-- LineItem : contains');
    const gen = p.edges.find((e) => e.relation === 'generalization')!;
    expect([gen.from, gen.to]).toEqual(['Duck', 'Animal']);
    const comp = p.edges.find((e) => e.relation === 'composition')!;
    expect([comp.from, comp.to, comp.label]).toEqual(['Order', 'LineItem', 'contains']);
    expect(p.nodes.find((n) => n.id === 'Animal')!.members!.map((m) => m.name)).toEqual(['name', 'speak()']);
  });

  it('imports state and sequence diagrams', () => {
    const st = parseMermaid('stateDiagram-v2\n  [*] --> Draft\n  Draft --> Paid : pay\n  Paid --> [*]');
    expect(st.nodes.map((n) => n.kind)).toEqual(['initial', 'state', 'state', 'final']);
    const sq = parseMermaid('sequenceDiagram\n  actor U as User\n  participant API\n  U->>API: POST /orders\n  API-->>U: 201 Created');
    expect(sq.edges.map((e) => e.relation)).toEqual(['message', 'reply']);
    const objs = layout(sq, { x: 0, y: 0 }, factory());
    expect(objs.filter((o) => o.type === 'uml-lifeline')).toHaveLength(2);
  });

  it('reads the activation shorthand of a sequence message as part of the arrow, not of the name', () => {
    const sq = parseMermaid('sequenceDiagram\n  A->>+B: hi\n  B-->>-A: ok\n  A->>B: again');
    expect(sq.nodes.map((n) => n.id)).toEqual(['A', 'B']);
    expect(sq.edges.map((e) => `${e.from}>${e.to}:${e.relation}`)).toEqual(['A>B:message', 'B>A:reply', 'A>B:message']);
  });

  it('exports a class diagram back to Mermaid', () => {
    const a = box('a', 0, 0, 100, 100, { type: 'uml-class', text: 'Animal', attributes: [], operations: [] });
    const d = box('d', 0, 200, 100, 100, { type: 'uml-class', text: 'Duck', attributes: [], operations: [] });
    const c = { id: 'c', type: 'connector', z: 'a', from: { kind: 'bound', id: 'd', anchor: 'auto' }, to: { kind: 'bound', id: 'a', anchor: 'auto' }, route: 'elbow', startHead: 'none', endHead: 'triangle', relation: 'generalization' } as ConnectorObj;
    expect(toMermaid([a, d, c])).toContain('Duck --|> Animal');
  });
});

describe('rendering safety and fonts', () => {
  it('strips scripts and handlers from icon bodies', () => {
    const dirty = '<path d="M0 0" onload="alert(1)"/><script>alert(2)</script><a href="javascript:alert(3)"><path/></a>';
    const clean = sanitizeSvgBody(dirty);
    expect(clean).not.toMatch(/onload|<script|javascript:/i);
    expect(clean).toContain('<path d="M0 0"');
  });

  it('keeps the ids of two icons that share a body apart', () => {
    const body = '<defs><linearGradient id="g"><stop stop-color="#f00"/></linearGradient></defs><path fill="url(#g)" d="M0 0h24v24H0z"/>';
    const get = () => undefined;
    const a = box('a1', 0, 0, 48, 48, { type: 'icon', body, viewBox: [0, 0, 24, 24] });
    const b = box('b2', 60, 0, 48, 48, { type: 'icon', body, viewBox: [0, 0, 24, 24] });
    const svg = objectMarkup(a, { get }) + objectMarkup(b, { get });
    expect(svg).toContain('id="ia1-g"');
    expect(svg).toContain('id="ib2-g"');
    expect(svg).toContain('fill="url(#ia1-g)"');
    expect(svg).toContain('fill="url(#ib2-g)"');
    expect(svg).not.toContain('url(#g)');
  });

  it('embeds a sticker body inline with no external references', () => {
    const sticker = box('s1', 0, 0, 120, 120, { type: 'icon', sticker: true, ref: 'twemoji:rocket', body: '<path fill="#55ACEE" d="M0 0h36v36H0z"/>', viewBox: [0, 0, 36, 36] });
    const svg = objectMarkup(sticker, { get: () => undefined });
    expect(svg).toContain('<path fill="#55ACEE" d="M0 0h36v36H0z"/>');
    expect(svg).not.toMatch(/href="http|url\(http/);
  });

  it('escapes text in markup', () => {
    const svg = objectMarkup(box('t', 0, 0, 200, 80, { text: '<img src=x onerror=alert(1)>' }), { get: () => undefined });
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;img');
  });

  it('wraps text to the available width', () => {
    const lines = wrap('the quick brown fox jumps over the lazy dog', '400 16px sans-serif', 80);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('reads the Fontshare catalogue shape', () => {
    const fonts = parseCatalogue({
      fonts: [{
        name: 'General Sans', slug: 'general-sans', category: 'Sans', font_tags: [{ name: 'Branding' }],
        styles: [
          { weight: { weight: 400 }, is_italic: false, is_variable: false },
          { weight: { weight: 400 }, is_italic: true, is_variable: false },
          { weight: { weight: 700 }, is_italic: false, is_variable: false },
          { weight: { weight: 0 }, is_italic: false, is_variable: true },
        ],
      }],
    });
    expect(fonts[0]).toEqual({ name: 'General Sans', slug: 'general-sans', category: 'Sans', weights: [400, 700], italic: true, variable: true, tags: ['Branding'] });
  });
});

describe('export markup is well-formed XML', async () => {
  const { DOMParser } = await import('@xmldom/xmldom');
  const { UML_ELEMENTS } = await import('../src/uml');
  const { SHAPE_KINDS } = await import('../src/shapes');
  it('parses every object type as XML without errors', () => {
    const objs: (BaseObj | ConnectorObj)[] = [
      ...SHAPE_KINDS.map((k, i) => box(`s${i}`, i * 200, 0, 160, 90, { kind: k.kind, text: `${k.label} & <more>` })),
      ...UML_ELEMENTS.map((d, i) => box(`u${i}`, i * 240, 400, d.w, d.h, { type: d.type, ...structuredClone(d.defaults) })),
      box('st', 0, 900, 192, 192, { type: 'sticky', text: 'Sticky "quoted"' }),
      box('tx', 300, 900, 240, 30, { type: 'text', text: 'Plain text' }),
      box('fr', 0, 1200, 600, 400, { type: 'frame', name: 'Frame & co' }),
      box('ic', 700, 900, 48, 48, { type: 'icon', body: '<path fill="currentColor" d="M0 0h24v24H0z"/>', viewBox: [0, 0, 24, 24] }),
      box('pa', 800, 900, 100, 100, { type: 'path', points: [0, 0, 50, 50, 100, 20] }),
    ];
    const get = (id: string) => objs.find((o) => o.id === id);
    const heads = ['none', 'arrow', 'open', 'triangle', 'diamond', 'diamond-open', 'circle', 'bar', 'crow-many', 'crow-one'] as const;
    heads.forEach((hd, i) => objs.push({ id: `c${i}`, type: 'connector', z: 'a', from: { kind: 'bound', id: 's0', anchor: 'auto' }, to: { kind: 'bound', id: 's3', anchor: 'auto' }, route: (['straight', 'elbow', 'curved'] as const)[i % 3], startHead: hd, endHead: hd, label: 'a < b & c' } as ConnectorObj));
    for (const o of objs) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">${objectMarkup(o, { get })}</svg>`;
      const errors: string[] = [];
      new DOMParser({ onError: (level: string, msg: string) => { if (level !== 'warning') errors.push(msg); } }).parseFromString(svg, 'image/svg+xml');
      expect(errors, `${o.type} ${o.id}`).toEqual([]);
    }
  });
});
