import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { blockThumbnailSvg, builtinThumbnail, thumbnailSvg } from '../src/template-thumb';
import { BAR_INK, frameColours, hexToHsl } from '../src/palette';
import { DEFAULT_META } from '../src/store';
import { Builder, TEMPLATES } from '../src/templates';
import type { BaseObj, ConnectorObj, Obj } from '../src/types';

const box = (id: string, type: BaseObj['type'], x: number, y: number, w: number, h: number, extra: Partial<BaseObj> = {}): BaseObj =>
  ({ id, type, x, y, w, h, rotation: 0, z: 'a0', text: id, ...extra }) as BaseObj;

const shape = (id: string, x: number, y: number) => box(id, 'shape', x, y, 100, 100, { kind: 'rect' });
const sticky = (id: string, x: number, y: number) => box(id, 'sticky', x, y, 100, 100);

/** The top-level drawn elements: one <g> per object, after <defs>. */
function drawn(svg: string) {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement!;
  const kids = Array.from(root.childNodes as unknown as Element[]).filter((n) => n.nodeType === 1);
  return { root, groups: kids.filter((n) => n.nodeName === 'g') };
}

describe('thumbnailSvg', () => {
  const objects: Obj[] = [shape('a', 0, 0), sticky('s', 200, 50)];

  it('returns a standalone svg with a viewBox of the box bounds plus 4% padding', () => {
    const { root } = drawn(thumbnailSvg(objects));
    expect(root.nodeName).toBe('svg');
    expect(root.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(root.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.getAttribute('focusable')).toBe('false');
    // bounds 0..300 by 0..150, pad = 4% of the larger side = 12
    expect(root.getAttribute('viewBox')).toBe('-12 -12 324 174');
  });

  it('draws one element per object, after the shared defs', () => {
    const svg = thumbnailSvg(objects);
    const { groups, root } = drawn(svg);
    expect(groups).toHaveLength(objects.length);
    expect(root.getElementsByTagName('defs')).toHaveLength(1);
    expect(svg).toContain('id="sticky-shadow"');
  });

  it('draws connectors between the boxes', () => {
    const link = { id: 'c', type: 'connector', z: 'a2', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 's', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' } as ConnectorObj;
    expect(drawn(thumbnailSvg([...objects, link])).groups).toHaveLength(3);
  });

  it('keeps theme variables so the thumbnail follows the theme', () => {
    const text = box('t', 'text', 0, 0, 200, 40, { text: 'Hello' });
    expect(thumbnailSvg([text])).toContain('var(--canvas-ink, #18212B)');
  });

  it('escapes user text', () => {
    const svg = thumbnailSvg([sticky('x', 0, 0)].map((o) => ({ ...o, text: '<img src=x onerror=alert(1)>' })));
    expect(svg).not.toContain('<img');
    // a word wider than the box wraps over tspans, so the text is read back across them
    const text = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]).join('');
    expect(text).toContain('&lt;img');
    expect(text).toContain('onerror=alert(1)&gt;');
  });

  it('uses a fallback viewBox when there are no boxes', () => {
    expect(drawn(thumbnailSvg([])).root.getAttribute('viewBox')).toBe('-4 -4 108 108');
  });

  it('draws everything up to maxObjects and only frames and stickies above it', () => {
    const mixed: Obj[] = [];
    for (let i = 0; i < 9; i++) mixed.push(i % 3 === 0 ? box(`f${i}`, 'frame', i * 150, 0, 120, 120, { name: 'F' }) : i % 3 === 1 ? sticky(`s${i}`, i * 150, 200) : shape(`h${i}`, i * 150, 400));
    expect(drawn(thumbnailSvg(mixed, { maxObjects: 9 })).groups).toHaveLength(9);
    const simple = drawn(thumbnailSvg(mixed, { maxObjects: 8 })).groups;
    expect(simple).toHaveLength(6);
    expect(simple.every((g) => g.getAttribute('transform'))).toBe(true);
  });

  it('switches to frames and stickies above the default 400 objects', () => {
    const many: Obj[] = Array.from({ length: 401 }, (_, i) => (i % 2 ? sticky(`s${i}`, i, 0) : shape(`h${i}`, i, 300)));
    expect(drawn(thumbnailSvg(many)).groups).toHaveLength(200);
    expect(drawn(thumbnailSvg(many.slice(0, 400))).groups).toHaveLength(400);
  });
});

describe('builtinThumbnail', () => {
  it('renders every built-in template without throwing', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
    for (const def of TEMPLATES) {
      const svg = builtinThumbnail(def);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(drawn(svg).groups.length).toBeGreaterThan(0);
    }
  });

  it('memoises per template', () => {
    const def = TEMPLATES[0];
    expect(builtinThumbnail(def)).toBe(builtinThumbnail(def));
  });
});

describe('Markdown blocks and tables in a thumbnail', () => {
  const md = (id: string, x: number, y: number, text: string) => box(id, 'markdown' as BaseObj['type'], x, y, 360, 200, { text });

  it('draws a quiet box at the object\'s own position and size, with no text, and never reads the content', () => {
    let reads = 0;
    const hostile = { ...md('m', 40, 60, 'x'.repeat(8000)) } as Record<string, unknown>;
    Object.defineProperty(hostile, 'text', { get() { reads++; return 'x'.repeat(8000); }, enumerable: true });
    const svg = thumbnailSvg([hostile as unknown as Obj]);
    expect(reads).toBe(0);
    expect(svg).toContain('<rect x="40" y="60" width="360" height="200" rx="4" fill="var(--paper, #FFFFFF)"');
    expect(svg).toContain('color-mix(in srgb, var(--ink, #18212B) 22%, var(--paper, #FFFFFF))');
    expect(svg).not.toContain('<text');
  });

  it('draws a table the same way, from its box only', () => {
    const svg = thumbnailSvg([{ ...box('t', 'table' as BaseObj['type'], 0, 0, 480, 120), 'r:r1': 'a0', 'k:c1': 'a0', 'c:r1:c1': 'cell text' } as unknown as Obj]);
    expect(svg).toContain('width="480" height="120" rx="4"');
    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('cell text');
  });

  it('draws 25 blocks of 8,000 characters at once, with no text measuring', () => {
    const blocks = Array.from({ length: 25 }, (_, i) => md(`m${i}`, (i % 5) * 400, Math.floor(i / 5) * 240, 'y'.repeat(8000)));
    const started = performance.now();
    const svg = thumbnailSvg(blocks);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(svg).not.toContain('<text');
    expect(svg.match(/rx="4"/g)).toHaveLength(25);
  });
});

// The block picture is what other people see of a board on the Boards home, so it is held to a stricter standard: nothing a person
// wrote reaches the markup. The objects below carry names, text, alt text, a font and an id that spell SECRET-NAME.
describe('blockThumbnailSvg', () => {
  const SECRET = 'SECRET-NAME';
  const withExtra = (o: Obj, extra: object) => ({ ...o, ...extra }) as unknown as Obj;
  const hostile: Obj[] = [
    withExtra(box(SECRET, 'frame', 0, 0, 400, 300), { name: SECRET, font: SECRET, fill: '#FFFFFF' }),
    withExtra(box('st', 'sticky', 40, 40, 160, 160, { text: SECRET }), { fill: '#FFE16B', name: SECRET }),
    withExtra(box('tx', 'text', 40, 220, 200, 40, { text: `${SECRET} line` }), { font: SECRET }),
    withExtra(box('im', 'image', 260, 40, 120, 90), { alt: `${SECRET} alt`, href: `https://${SECRET}.example` }),
    withExtra(box('lane', 'lane', 240, 160, 200, 120), { name: SECRET }),
    withExtra(box('md', 'markdown', 40, 260, 300, 30), { text: `# ${SECRET}` }),
    withExtra(box('sh', 'shape', 420, 40, 100, 100, { text: SECRET }), { kind: 'diamond', fill: '#18D0A0' }),
  ];

  /** Every attribute the markup writes must come from this allow-list: numbers, the fixed tokens, and plain hex colours. */
  const COLOUR = /^(none|#[0-9a-fA-F]{6}|var\(--paper, #FFFFFF\)|color-mix\(in srgb, var\(--ink, #18212B\) \d+%, (transparent|var\(--paper, #FFFFFF\))\))$/u;
  const NUMBERS = /^-?\d+(\.\d+)?$/u;
  const NUMBER_LIST = /^[-\d.\s,eE]+$/u;
  const PATH = /^[MLHVCSQTAZ0-9eE.,\s+-]*$/u;
  const FIXED: Record<string, RegExp | string> = {
    xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid meet',
    'vector-effect': 'non-scaling-stroke', 'stroke-width': /^\d+(\.\d+)?$/u, width: NUMBERS, height: NUMBERS, viewBox: NUMBER_LIST,
    x: NUMBERS, y: NUMBERS, rx: NUMBERS, ry: NUMBERS, cx: NUMBERS, cy: NUMBERS, points: NUMBER_LIST, d: PATH,
    fill: COLOUR, stroke: COLOUR,
  };

  function attributeProblems(svg: string): string[] {
    const problems: string[] = [];
    for (const [, name, value] of svg.matchAll(/ ([a-zA-Z:-]+)="([^"]*)"/gu)) {
      const rule = FIXED[name];
      if (rule === undefined) problems.push(`${name}="${value}"`);
      else if (typeof rule === 'string' ? value !== rule : !rule.test(value)) problems.push(`${name}="${value}"`);
    }
    return problems;
  }

  it('writes no words, names, ids, fonts or links from the objects', () => {
    const svg = blockThumbnailSvg(hostile);
    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('foreignObject');
    expect(svg).not.toContain('<title');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain(SECRET);
    expect(svg).not.toContain('https://');
  });

  it('writes only the allowed attributes, each with a number, a fixed token or a plain hex colour', () => {
    const svg = blockThumbnailSvg(hostile);
    expect(attributeProblems(svg)).toEqual([]);
    const withConnector = [...hostile, { id: 'c', type: 'connector', z: 'a2', from: { kind: 'bound', id: 'st', anchor: 'auto' }, to: { kind: 'bound', id: 'im', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' } as unknown as Obj];
    expect(attributeProblems(blockThumbnailSvg(withConnector))).toEqual([]);
  });

  it('draws a sticky as a colour block with two grey bars, and a frame as a neutral tinted box with no name', () => {
    const svg = blockThumbnailSvg([box('f', 'frame', 0, 0, 200, 200, { name: SECRET } as Partial<BaseObj>), box('s', 'sticky', 20, 20, 100, 100, { fill: '#FFE16B' } as Partial<BaseObj>)]);
    // paper frame, the frame, the sticky and its two bars
    expect(svg.match(/<rect /g)).toHaveLength(5);
    expect(svg).toContain('fill="#FFE16B"');
    expect(svg).toContain(`fill="${frameColours(undefined).fill}"`);
    expect(svg).not.toContain(SECRET);
  });

  it('falls back to our grey for a colour that is not a plain hex, and keeps a plain hex', () => {
    const bad = (fill: string) => blockThumbnailSvg([box('s', 'sticky', 0, 0, 100, 100, { fill } as Partial<BaseObj>)]);
    for (const fill of ['url(#x) onload="alert(1)"', 'javascript:alert(1)', 'red', '#GGGGGG', '#FFE16B30']) {
      expect(bad(fill)).toContain('fill="#E2E6EB"');
      expect(bad(fill)).not.toContain('javascript');
    }
    expect(bad('#ffe16b')).toContain('fill="#ffe16b"');
  });

  it('is deterministic: the same objects give the same string, and so does a copy of them', () => {
    const copy = JSON.parse(JSON.stringify(hostile)) as Obj[];
    expect(blockThumbnailSvg(hostile)).toBe(blockThumbnailSvg(hostile));
    expect(blockThumbnailSvg(copy)).toBe(blockThumbnailSvg(hostile));
  });

  it('is a 16:10 picture with a paper frame, so it letterboxes instead of cropping', () => {
    const { root } = drawn(blockThumbnailSvg(hostile));
    expect(root.nodeName).toBe('svg');
    const [x, , w, h] = (root.getAttribute('viewBox') ?? '').split(' ').map(Number);
    expect(w / h).toBeCloseTo(1.6, 2);
    expect(root.getAttribute('width')).toBe('480');
    expect(root.getAttribute('height')).toBe('300');
    expect(Number.isFinite(x)).toBe(true);
    // the paper frame is the first thing drawn, so it sits under every block
    const first = root.getElementsByTagName('rect')[0];
    expect(first.getAttribute('fill')).toBe('var(--paper, #FFFFFF)');
  });

  it('keeps a connector as a line between its two ends, with no label', () => {
    const link = { id: 'c', type: 'connector', z: 'a2', from: { kind: 'bound', id: 'st', anchor: 'auto' }, to: { kind: 'bound', id: 'im', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow', text: SECRET } as unknown as Obj;
    const svg = blockThumbnailSvg([hostile[1], hostile[3], link]);
    expect(svg).toMatch(/<path d="M[-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+"/u);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain(SECRET);
    // a curved route is drawn too: its command letters must pass the path allow-list
    const curved = { ...link, route: 'curved' } as unknown as Obj;
    const bent = blockThumbnailSvg([hostile[1], hostile[3], curved]);
    expect(bent).toMatch(/<path d="M[^"]*C[^"]*"/u);
    expect(attributeProblems(bent)).toEqual([]);
  });

  it('writes no words for any built-in template, and draws the kanban lanes as columns', () => {
    // the kanban's lanes have no colour of their own, so they take the neutral tint
    const laneFill = `fill="${frameColours(undefined).fill}"`;
    const objectsOf = (def: (typeof TEMPLATES)[number]) => {
      const b = new Builder({ user: { id: 'thumbnail' }, store: { getMeta: () => DEFAULT_META } }, 0, 0);
      def.build(b);
      return b.objs;
    };
    for (const def of TEMPLATES) {
      const objs = objectsOf(def);
      const svg = blockThumbnailSvg(objs);
      expect(svg).not.toContain('<text');
      expect(svg).not.toContain('foreignObject');
      expect(attributeProblems(svg)).toEqual([]);
      // a word of at least three letters: a number cannot collide with the coordinates in the markup
      const words = objs.flatMap((o) => ['name', 'text', 'alt'].map((field) => (o as unknown as Record<string, unknown>)[field]))
        .filter((value): value is string => typeof value === 'string' && /[A-Za-z]{3,}/u.test(value));
      for (const word of words) expect(svg).not.toContain(word);
    }
    expect(blockThumbnailSvg(objectsOf(TEMPLATES.find((t) => t.id === 'kanban')!))).toContain(laneFill);
  });
});

// The picture family (src/palette.ts): a frame's own colour is a soft tint with a darker edge of the same hue, neutral when it has no
// colour; the bars and the corners are the same numbers as the schematic tile. The picture is one board, so its unit is 1080 here.
describe('the picture family in a block picture', () => {
  const frameOf = (fill?: string) => blockThumbnailSvg([box('f', 'frame', 0, 0, 1000, 500, fill === undefined ? {} : { fill } as Partial<BaseObj>)]);

  it('tints a frame in its own colour: a soft fill and a darker edge, both of the colour\'s hue', () => {
    const c = frameColours('#FFE16B');
    expect(frameOf('#FFE16B')).toContain(`fill="${c.fill}" stroke="${c.edge}" stroke-width="1"`);
    const [hue] = hexToHsl('#FFE16B');
    const [hueFill, , lightFill] = hexToHsl(c.fill);
    const [hueEdge, , lightEdge] = hexToHsl(c.edge);
    expect(Math.abs(hueFill - hue)).toBeLessThan(2);
    expect(Math.abs(hueEdge - hue)).toBeLessThan(2);
    expect(lightFill).toBeGreaterThan(0.9);
    expect(lightEdge).toBeLessThan(lightFill);
    expect(lightEdge).toBeGreaterThan(0.5);
  });

  it('draws a frame with no colour, white, or a name we do not know in the neutral tint, with the outline ink for its edge', () => {
    const neutral = frameColours(undefined);
    expect(neutral.fill).toBe('color-mix(in srgb, var(--ink, #18212B) 6%, var(--paper, #FFFFFF))');
    expect(neutral.edge).toBe('color-mix(in srgb, var(--ink, #18212B) 28%, transparent)');
    for (const fill of [undefined, 'none', '#FFFFFF', 'nope']) expect(frameOf(fill)).toContain(`fill="${neutral.fill}" stroke="${neutral.edge}"`);
  });

  it('resolves a sticky colour name the way the board draws it (kanban lanes store `blue`), and a hex is kept', () => {
    expect(frameColours('blue')).toEqual(frameColours('#A3D2FF'));
    expect(blockThumbnailSvg([box('l', 'lane', 0, 0, 300, 400, { fill: 'blue' } as Partial<BaseObj>)])).toContain(`fill="${frameColours('#A3D2FF').fill}"`);
  });

  it('rounds every box by the same fraction of the picture, and draws bars in 38% ink at a tenth of the unit', () => {
    // the picture is 1080 units across (4% padding each side of a 1000-unit board): the corner radius is 1080 * 0.008
    expect(frameOf('#FFE16B')).toContain('rx="8.64"');
    const sticky = blockThumbnailSvg([box('s', 'sticky', 0, 0, 1000, 500, { fill: '#FFE16B' } as Partial<BaseObj>)]);
    expect(sticky).toContain('rx="8.64"');
    expect(BAR_INK).toBe('color-mix(in srgb, var(--ink, #18212B) 38%, transparent)');
    expect(sticky.split(BAR_INK)).toHaveLength(3);
    expect(sticky).toContain('height="10.8"');
  });
});
