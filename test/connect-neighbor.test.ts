import { describe, expect, it } from 'vitest';
import { NEIGHBOR_REACH, neighborInDirection } from '../src/geometry';
import type { BaseObj } from '../src/types';

const box = (id: string, x: number, y: number, extra: Partial<BaseObj> = {}): BaseObj =>
  ({ id, type: 'shape', kind: 'rect', z: 'a', x, y, w: 120, h: 80, rotation: 0, ...extra }) as BaseObj;

// the source sits at 0,0 to 120,80; "right" means beyond x = 120
const src = box('src', 0, 0);

describe('neighborInDirection', () => {
  it('finds the shape next to the clicked side', () => {
    const right = box('right', 220, 0);
    expect(neighborInDirection(src, 'right', [src, right])?.id).toBe('right');
    expect(neighborInDirection(src, 'left', [src, right])).toBeNull();
    const below = box('below', 0, 200);
    expect(neighborInDirection(src, 'bottom', [src, right, below])?.id).toBe('below');
    expect(neighborInDirection(src, 'top', [src, right, below])).toBeNull();
  });

  it('finds nothing when no shape is there, so a new one is made', () => {
    expect(neighborInDirection(src, 'right', [src])).toBeNull();
    expect(neighborInDirection(src, 'right', [])).toBeNull();
  });

  it('picks the nearest of several, and the better aligned one on a tie', () => {
    const far = box('far', 400, 0);
    const near = box('near', 200, 10);
    const nearOff = box('nearOff', 200, 60); // just as near, less aligned
    expect(neighborInDirection(src, 'right', [far, nearOff, near, src])?.id).toBe('near');
  });

  it('skips locked shapes, as dragging a connector does', () => {
    const locked = box('locked', 200, 0, { locked: true });
    const behind = box('behind', 400, 0);
    expect(neighborInDirection(src, 'right', [locked, behind])?.id).toBe('behind');
    expect(neighborInDirection(src, 'right', [locked])).toBeNull();
  });

  it('needs the shape roughly in line, beyond the side, and within reach', () => {
    expect(neighborInDirection(src, 'right', [box('diagonal', 200, 200)])).toBeNull(); // not overlapping across
    expect(neighborInDirection(src, 'right', [box('overlapping', 100, 0)])).toBeNull(); // starts before the side
    expect(neighborInDirection(src, 'right', [box('far', 120 + NEIGHBOR_REACH + 1, 0)])).toBeNull();
    expect(neighborInDirection(src, 'right', [box('edge', 120 + NEIGHBOR_REACH, 0)])?.id).toBe('edge');
    expect(neighborInDirection(src, 'right', [box('touching', 120, 79)])?.id).toBe('touching'); // one unit of overlap
  });

  it('follows a rotated source', () => {
    const turned = box('turned', 0, 0, { rotation: Math.PI / 2 }); // its right side now faces down
    const below = box('below', 0, 250);
    const right = box('right', 260, 0);
    expect(neighborInDirection(turned, 'right', [right, below])?.id).toBe('below');
  });
});
