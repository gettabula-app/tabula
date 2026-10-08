import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { builtinThumbnail, thumbnailSvg } from '../src/template-thumb';
import { TEMPLATES } from '../src/templates';
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
    expect(svg).toContain('&lt;img</tspan>');
    expect(svg).toContain('onerror=alert(1)&gt;</tspan>');
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
