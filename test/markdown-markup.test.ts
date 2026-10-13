import { describe, expect, it } from 'vitest';
import { describeObject } from '../src/canvas-describe';
import { layerLabel } from '../src/layers';
import { markdownBoxHeight, objectMarkup, type MarkupCtx } from '../src/markup';
import type { BaseObj, Obj } from '../src/types';

// The Markdown block as the canvas and the exports draw it (src/markup.ts): plain SVG, every stored value escaped, and a quiet fallback for bad data.

const ctx = (extra: Partial<MarkupCtx> = {}) => ({ get: () => undefined, ...extra }) as unknown as MarkupCtx;
const md = (text: unknown, extra: Record<string, unknown> = {}) => ({ id: 'md1', type: 'markdown', x: 10, y: 20, w: 360, h: 200, rotation: 0, z: 'a', text, ...extra }) as unknown as BaseObj;

describe('markdownMarkup', () => {
  it('draws the text, the task boxes and the table as SVG elements inside a clipped box, with no foreignObject', () => {
    const svg = objectMarkup(md('# Title\n\n- [ ] one\n- [x] two\n\n| a | b |\n| - | - |\n| 1 | 2 |'), ctx());
    expect(svg).toContain('>Title</text>');
    expect(svg).toContain('data-md-task="2"');
    expect(svg).toContain('data-md-task="3"');
    expect(svg).toContain('<svg x="0" y="0" width="360" height="200" overflow="hidden">');
    expect(svg).toContain('<line ');
    expect(svg).not.toMatch(/foreignObject|<script|<iframe|<img/);
    expect(svg).toMatch(/^<g transform="translate\(10 20\)"/);
  });

  it('escapes whatever the text holds: a quote, an angle bracket or an attribute breaker is text, never markup', () => {
    const hostile = '"><script>alert(1)</script><rect onload="x" /> [a"onmouseover="x](https://e.example/"onmouseover="x) [b](javascript:alert(1))';
    const svg = objectMarkup(md(hostile), ctx());
    expect(svg).not.toMatch(/<script|onload="|onmouseover="x"|javascript:/);
    expect(svg).toContain('&lt;script&gt;');
    // every attribute value in the output is quoted and free of a bare quote
    const attrs = [...svg.matchAll(/ ([a-z:-]+)="([^"]*)"/g)];
    expect(attrs.length).toBeGreaterThan(5);
    expect(svg.replace(/ ([a-z:-]+)="[^"]*"/g, '')).not.toMatch(/ [a-z:-]+=/);
  });

  it('links become anchors only for checked addresses, web links open in a new tab with noopener', () => {
    const svg = objectMarkup(md('[w](https://example.com/a?b=1&c=2) [m](mailto:a@b.co) [o](#obj:abc) [x](javascript:alert(1)) [y](data:text/html,hi)'), ctx());
    expect(svg).toContain('href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"');
    expect(svg).toContain('href="mailto:a@b.co"');
    expect(svg).toContain('href="#obj:abc"');
    expect(svg).not.toMatch(/javascript:|data:text/);
    expect(svg.match(/<a /g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('draws only the background while it is being edited, and nothing from the source', () => {
    const svg = objectMarkup(md('secret words', { fill: '#FFE16B' }), ctx({ editingId: 'md1' }));
    expect(svg).not.toContain('secret');
    expect(svg).toContain('fill="#FFE16B"');
  });

  it('survives data that is not what it should be: a number for the text, a bad colour, NaN sizes', () => {
    for (const bad of [42, null, undefined, { a: 1 }, ['x'], '']) {
      expect(() => objectMarkup(md(bad), ctx())).not.toThrow();
    }
    const svg = objectMarkup(md('hello', { textColor: '"><script>', fontSize: Number.NaN, w: Number.NaN }), ctx());
    expect(svg).not.toMatch(/<script|NaN/);
  });

  it('uses the text colour for its tints and lines, so it fits every theme', () => {
    const svg = objectMarkup(md('`code` and [link](https://example.com)', { textColor: '#336699' }), ctx());
    expect(svg).toContain('fill="#336699"');
    expect(svg).toContain('stroke="#336699"');
  });

  it('measures its own height: more text or a narrower width needs more room', () => {
    const base = md('one line');
    const long = md('word '.repeat(200));
    expect(markdownBoxHeight(long)).toBeGreaterThan(markdownBoxHeight(base) * 3);
    expect(markdownBoxHeight(long, 200)).toBeGreaterThan(markdownBoxHeight(long, 600));
    expect(markdownBoxHeight(md(''))).toBeGreaterThan(0);
  });
});

describe('what the outline and the layers panel say about it', () => {
  const ctxD = { get: () => undefined, childCount: () => 0 };
  it('names it by its first heading or line and reads the text and the tasks out', () => {
    const d = describeObject(md('# Plan for May\n\n- [ ] a\n- [x] b\n- [x] c') as Obj, ctxD);
    expect(d.name).toBe('Markdown block, "Plan for May"');
    expect(d.description).toContain('Plan for May. a. b. c');
    expect(d.description).toContain('3 tasks, 2 done.');
    expect(describeObject(md('plain') as Obj, ctxD).description).not.toContain('task');
    expect(describeObject(md('x', { locked: true }) as Obj, ctxD).name).toBe('Markdown block, "x", locked');
  });

  it('labels the layer with its first heading or line, not its marks', () => {
    expect(layerLabel(md('## **Bold** [t](https://x.test) heading\ntext') as Obj)).toBe('Bold t heading');
    expect(layerLabel(md('') as Obj)).toBe('Markdown block');
  });
});
