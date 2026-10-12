import { describe, expect, it } from 'vitest';
import { boardLabel, describeObject } from '../src/canvas-describe';
import type { Obj } from '../src/types';

// docs/canvas-keyboard.md, "The outline: what a screen reader is told".

const obj = (o: Record<string, unknown>) => ({ z: 'a', x: 0, y: 0, w: 100, h: 100, rotation: 0, ...o }) as unknown as Obj;
const make = (list: Obj[], counts: Record<string, number> = {}) => ({
  get: (id: string) => list.find((o) => o.id === id),
  childCount: (id: string) => counts[id] ?? 0,
});

describe('object names', () => {
  it('names a sticky note by colour and text, and a long text is cut with the whole in the description', () => {
    const ctx = make([]);
    expect(describeObject(obj({ id: 's', type: 'sticky', fill: '#FFE16B', text: 'Reviews were fast' }), ctx))
      .toEqual({ name: 'Sticky note, yellow, "Reviews were fast"', description: '' });
    const long = 'word '.repeat(60).trim();
    const d = describeObject(obj({ id: 's', type: 'sticky', text: long }), ctx);
    expect(d.name.endsWith('…"')).toBe(true);
    expect(d.name.length).toBeLessThan(160);
    expect(d.description).toContain(long);
    expect(describeObject(obj({ id: 's', type: 'sticky', fill: '#123456', text: '' }), ctx).name).toBe('Sticky note');
  });

  it('says locked, and where an object is', () => {
    const frame = obj({ id: 'f', type: 'frame', name: 'Ideas' });
    const d = describeObject(obj({ id: 's', type: 'sticky', text: 'x', locked: true, parent: 'f' }), make([frame]));
    expect(d.name).toBe('Sticky note, "x", locked');
    expect(d.description).toBe('In frame Ideas.');
  });

  it('counts what is inside a frame, a group, a container and a lane', () => {
    const ctx = make([], { f: 4, g: 1, c: 0 });
    expect(describeObject(obj({ id: 'f', type: 'frame', name: 'Ideas' }), ctx).name).toBe('Frame Ideas, 4 items');
    expect(describeObject(obj({ id: 'g', type: 'group' }), ctx).name).toBe('Group, 1 item');
    expect(describeObject(obj({ id: 'c', type: 'container', name: 'Sprint' }), ctx).name).toBe('Board Sprint, 0 items');
  });

  it('describes an image by its alt text, or says it has none', () => {
    const ctx = make([]);
    expect(describeObject(obj({ id: 'i', type: 'image', alt: 'Team photo' }), ctx).name).toBe('Image, "Team photo"');
    const bare = describeObject(obj({ id: 'i', type: 'image' }), ctx);
    expect(bare.name).toBe('Image, no description');
    expect(bare.description).toBe('No description yet.');
  });

  it('names a connector by its ends and label, and copes with a free end and a removed object', () => {
    const a = obj({ id: 'a', type: 'sticky', text: 'Backlog' });
    const b = obj({ id: 'b', type: 'shape', text: '' });
    const ctx = make([a, b]);
    const bound = (id: string) => ({ kind: 'bound', id, anchor: 'auto' });
    expect(describeObject(obj({ id: 'k', type: 'connector', from: bound('a'), to: bound('b'), label: 'blocks' }), ctx).name)
      .toBe('Connector from Backlog to shape, "blocks"');
    expect(describeObject(obj({ id: 'k', type: 'connector', from: bound('a'), to: { kind: 'free', x: 1, y: 2 } }), ctx).name)
      .toBe('Connector from Backlog to empty canvas');
    expect(describeObject(obj({ id: 'k', type: 'connector', from: bound('gone'), to: bound('a') }), ctx).name)
      .toBe('Connector from a removed object to Backlog');
  });

  it('names a shape, a text, a drawing and an unknown kind', () => {
    const ctx = make([]);
    expect(describeObject(obj({ id: 'x', type: 'shape', text: 'Backlog' }), ctx).name).toBe('Shape, "Backlog"');
    expect(describeObject(obj({ id: 'x', type: 'text', text: 'Q3 goals' }), ctx).name).toBe('Text, "Q3 goals"');
    expect(describeObject(obj({ id: 'x', type: 'path' }), ctx).name).toBe('Drawing');
    expect(describeObject(obj({ id: 'x', type: 'mystery' }), ctx).name).toBe('Object');
  });
});

describe('the board label', () => {
  it('counts the objects, and tells an empty board how to start', () => {
    expect(boardLabel(14)).toBe('Whiteboard, 14 objects');
    expect(boardLabel(1)).toBe('Whiteboard, 1 object');
    expect(boardLabel(0)).toBe('Whiteboard, 0 objects. Press N to add a sticky note.');
  });
});
