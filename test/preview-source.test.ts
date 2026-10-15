import { describe, expect, it } from 'vitest';
import { previewSourceObjects } from '../src/preview-source';
import { inlineForImage, paintOrder, previewSvgFor } from '../src/preview-render';
import type { Obj } from '../src/types';

// DEV stand-in for the production "everyone's view" (src/preview-source.ts). Objects are plain data here: the rules read ids, types,
// `hidden`, `privateStep`, `parent` and the bound ends of connectors, and nothing else.

const box = (id: string, extra: Record<string, unknown> = {}): Obj => ({
  id, type: 'sticky', x: 0, y: 0, w: 100, h: 100, rotation: 0, z: id, fill: '#FFE066', text: `note ${id}`, ...extra,
} as Obj);

const arrow = (id: string, from: Obj['id'] | null, to: Obj['id'] | null): Obj => ({
  id, type: 'connector', z: id,
  from: from === null ? { kind: 'free', x: 0, y: 0 } : { kind: 'bound', id: from, anchor: 'auto' },
  to: to === null ? { kind: 'free', x: 300, y: 0 } : { kind: 'bound', id: to, anchor: 'auto' },
  route: 'straight', startHead: 'none', endHead: 'arrow',
} as unknown as Obj);

const ids = (list: Obj[]) => list.map((o) => o.id);
const shown = { reveal: false };

describe('previewSourceObjects (dev stand-in)', () => {
  it('keeps ordinary objects in their order and does not change the input', () => {
    const input = [box('a'), box('b'), box('c')];
    const before = JSON.stringify(input);
    const out = previewSourceObjects(input, shown);
    expect(ids(out)).toEqual(['a', 'b', 'c']);
    expect(out).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('drops an unrevealed private note and keeps it once the flow is revealed', () => {
    const input = [box('public'), box('private', { privateStep: 'step-1', createdBy: 'maja' })];
    expect(ids(previewSourceObjects(input, shown))).toEqual(['public']);
    expect(ids(previewSourceObjects(input, { reveal: true }))).toEqual(['public', 'private']);
  });

  it('drops a private note of any author, the author included: the preview is what everyone sees', () => {
    const input = [box('mine', { privateStep: 'step-1', createdBy: 'maja' }), box('theirs', { privateStep: 'step-1', createdBy: 'omar' })];
    expect(previewSourceObjects(input, shown)).toEqual([]);
  });

  it('drops an object with hidden set, and everything inside it', () => {
    const frame = { ...box('frame', { type: 'frame', hidden: true, w: 400, h: 300 }) } as Obj;
    const inside = box('inside', { parent: 'frame' });
    const deeper = box('deeper', { parent: 'inside' });
    const sibling = box('sibling');
    expect(ids(previewSourceObjects([frame, inside, deeper, sibling], shown))).toEqual(['sibling']);
  });

  it('drops a connector bound to a dropped note, keeps one bound to a shown note and a free line', () => {
    const input = [
      box('public'),
      box('private', { privateStep: 'step-1' }),
      arrow('to-private', 'public', 'private'),
      arrow('to-public', 'public', 'public'),
      arrow('free', null, 'public'),
    ];
    expect(ids(previewSourceObjects(input, shown))).toEqual(['public', 'to-public', 'free']);
  });

  it('ends a malformed parent cycle instead of looping', () => {
    const input = [box('x', { parent: 'y' }), box('y', { parent: 'x' })];
    expect(ids(previewSourceObjects(input, shown))).toEqual(['x', 'y']);
  });
});

describe('paintOrder (dev stand-in)', () => {
  it('gives the store order, and puts an object the store left out last, so nothing is missing from the picture', () => {
    const a = box('a');
    const b = box('b');
    const c = box('c');
    const cache = new Map([[a.id, a], [b.id, b], [c.id, c]]);
    expect(ids(paintOrder({ ordered: () => [c, a], cache }))).toEqual(['c', 'a', 'b']);
    expect(ids(paintOrder({ ordered: () => [a, b, c], cache }))).toEqual(['a', 'b', 'c']);
  });
});

describe('previewSvgFor and inlineForImage (dev stand-in)', () => {
  it('a private note never reaches the picture, and reveals with the flow', () => {
    const secret = '#B0C4DE';
    const objects = [box('public', { fill: '#FFF4B0' }), box('private', { fill: secret, privateStep: 'step-1' })];
    expect(previewSvgFor(objects, shown)).not.toContain(secret);
    expect(previewSvgFor(objects, { reveal: true })).toContain(secret);
  });

  it('the picture has no theme variables and no color-mix, and keeps a translucent outline as an opacity', () => {
    const svg = previewSvgFor([box('a'), { ...box('f', { type: 'frame', w: 300, h: 200 }) } as Obj], shown);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/var\(/);
    expect(svg).not.toMatch(/color-mix\(/);
    expect(svg).toMatch(/fill-opacity="0\.\d+"|stroke-opacity="0\.\d+"/);
  });

  it('resolves a translucent colour attribute to its colour and opacity, and leaves plain colours alone', () => {
    const out = inlineForImage('<svg><rect fill="color-mix(in srgb, var(--ink, #18212B) 38%, transparent)"/><rect fill="var(--paper, #FFFFFF)"/></svg>');
    expect(out).toBe('<svg><rect fill="#18212B" fill-opacity="0.38"/><rect fill="#FFFFFF"/></svg>');
  });
});
