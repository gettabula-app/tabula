import { describe, expect, it } from 'vitest';
import { anchorFor, type Anchor, type Thread } from '../src/comments';
import { pinAt, pinCenter, pinPath, pinViews, type PinView } from '../src/pins';
import type { BaseObj, Obj } from '../src/types';

const box = (over: Partial<BaseObj> = {}): BaseObj => ({
  id: 'b', type: 'shape', kind: 'rect', x: 100, y: 50, w: 200, h: 100, rotation: 0, z: 'a0', ...over,
});

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: 't1', createdAt: 1, authorId: 'alice', authorName: 'Alice', authorColor: '#f00', text: 'hi',
  anchor: { x: 10, y: 20 }, resolved: false, replies: [], ...over,
});

const none = (): Obj | undefined => undefined;
const at = (x: number, y: number, extra: Partial<PinView> = {}): PinView => ({
  id: 'p', x, y, label: 'A', color: '#f00', resolved: false, count: 1, selected: false, ...extra,
});

describe('pinViews', () => {
  it('returns nothing when comments are hidden', () => {
    const views = pinViews({ threads: [thread()], get: none, openId: null, draft: null, visible: false });
    expect(views).toEqual([]);
  });

  it('still returns the draft pin when comments are hidden', () => {
    const views = pinViews({ threads: [thread()], get: none, openId: null, draft: { x: 5, y: 6 }, visible: false });
    expect(views).toEqual([{ id: '__draft__', x: 5, y: 6, label: '+', color: '#FFD23F', resolved: false, count: 0, selected: false, draft: true }]);
  });

  it('places a pin at the anchor and takes the label from the author initial', () => {
    const [pin] = pinViews({ threads: [thread({ authorName: 'bob' })], get: none, openId: null, draft: null, visible: true });
    expect(pin).toMatchObject({ id: 't1', x: 10, y: 20, label: 'B', color: '#f00', resolved: false, count: 1, selected: false });
  });

  it('uses ? when the author has no name', () => {
    const [pin] = pinViews({ threads: [thread({ authorName: '' })], get: none, openId: null, draft: null, visible: true });
    expect(pin.label).toBe('?');
  });

  it('marks resolved threads and counts the first message plus replies', () => {
    const replies = [
      { id: 'r1', authorId: 'b', authorName: 'B', authorColor: '#0f0', text: 'x', createdAt: 2 },
      { id: 'r2', authorId: 'c', authorName: 'C', authorColor: '#00f', text: 'y', createdAt: 3 },
    ];
    const [pin] = pinViews({ threads: [thread({ resolved: true, replies })], get: none, openId: null, draft: null, visible: true });
    expect(pin.resolved).toBe(true);
    expect(pin.count).toBe(3);
  });

  it('selects the open thread only', () => {
    const views = pinViews({ threads: [thread({ id: 'a' }), thread({ id: 'b' })], get: none, openId: 'b', draft: null, visible: true });
    expect(views.map((v) => v.selected)).toEqual([false, true]);
  });

  it('follows the object when it moves', () => {
    const obj = box({ x: 100, y: 50, w: 200, h: 100 });
    const anchor = anchorFor({ x: 150, y: 100 }, obj);
    const moved = box({ x: 300, y: 80, w: 200, h: 100 });
    const get = (id: string) => (id === obj.id ? moved : undefined);
    const [pin] = pinViews({ threads: [thread({ anchor })], get, openId: null, draft: null, visible: true });
    expect(pin.x).toBeCloseTo(350, 6);
    expect(pin.y).toBeCloseTo(130, 6);
  });

  it('falls back to the stored position when the object is gone', () => {
    const anchor: Anchor = { x: 40, y: 60, obj: 'gone', fx: 0.5, fy: 0.5 };
    const [pin] = pinViews({ threads: [thread({ anchor })], get: none, openId: null, draft: null, visible: true });
    expect(pin).toMatchObject({ x: 40, y: 60 });
  });

  it('adds the draft pin after the thread pins', () => {
    const views = pinViews({ threads: [thread()], get: none, openId: null, draft: { x: 1, y: 2 }, visible: true });
    expect(views.map((v) => v.id)).toEqual(['t1', '__draft__']);
    expect(views[1]).toMatchObject({ draft: true, label: '+', resolved: false });
  });
});

describe('pinPath', () => {
  it('is a closed path with the tip at the origin', () => {
    expect(pinPath(11)).toBe('M0 0V-11A11 11 0 1 1 11 0Z');
  });

  it('has no NaN for several radii', () => {
    const paths = [0, 0.5, 1, 8.4615, 11, 40].map((r) => pinPath(r));
    expect(paths.some((d) => d.includes('NaN'))).toBe(false);
    expect(paths.every((d) => d.startsWith('M0 0') && d.endsWith('Z'))).toBe(true);
  });
});

describe('pinCenter', () => {
  it('sits up and to the right of the tip by the radius', () => {
    expect(pinCenter({ x: 10, y: 20 }, 11)).toEqual({ x: 21, y: 9 });
  });
});

describe('pinAt', () => {
  const pin = at(0, 0, { id: 'p1' });

  it('hits inside the circle', () => {
    expect(pinAt([pin], { x: 11, y: -11 }, 1)).toBe('p1');
  });

  it('hits the tip corner square, which lies outside the circle', () => {
    expect(pinAt([pin], { x: 0, y: 0 }, 1)).toBe('p1');
    expect(pinAt([pin], { x: 1, y: -1 }, 1)).toBe('p1');
  });

  it('allows a few screen pixels of tolerance around the circle', () => {
    expect(pinAt([pin], { x: 11 + 13.5, y: -11 }, 1)).toBe('p1');
    expect(pinAt([pin], { x: 11 + 14.5, y: -11 }, 1)).toBeNull();
  });

  it('misses points clearly outside', () => {
    expect(pinAt([pin], { x: -5, y: 5 }, 1)).toBeNull();
    expect(pinAt([pin], { x: 40, y: -11 }, 1)).toBeNull();
  });

  it('lets the later pin win when two overlap', () => {
    const under = at(0, 0, { id: 'under' });
    const over = at(0, 0, { id: 'over' });
    expect(pinAt([under, over], { x: 11, y: -11 }, 1)).toBe('over');
  });

  it('scales the hit tolerance with zoom, in world units', () => {
    const world = { x: 13, y: -5.5 };
    expect(pinAt([pin], world, 1)).toBe('p1');
    expect(pinAt([pin], world, 2)).toBeNull();
  });

  it('never hits the draft pin', () => {
    const draft = pinViews({ threads: [], get: none, openId: null, draft: { x: 0, y: 0 }, visible: true });
    expect(pinAt(draft, { x: 11, y: -11 }, 1)).toBeNull();
    expect(pinAt(draft, { x: 0, y: 0 }, 1)).toBeNull();
  });
});
