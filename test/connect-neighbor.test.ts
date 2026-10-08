import { describe, expect, it } from 'vitest';
import { NEIGHBOR_REACH, freeSpotInDirection, neighborInDirection } from '../src/geometry';
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

describe('freeSpotInDirection', () => {
  // the source is 120 x 80 at the origin, so the default copy sits 96 beyond the clicked side
  const at = (side: Parameters<typeof freeSpotInDirection>[1], obstacles: BaseObj[]) => freeSpotInDirection(src, side, obstacles);

  it('uses the usual gap when nothing is in the way', () => {
    expect(at('right', [src])).toEqual({ x: 216, y: 0 });
    expect(at('left', [])).toEqual({ x: -216, y: 0 });
    expect(at('bottom', [src])).toEqual({ x: 0, y: 176 });
    expect(at('top', [src])).toEqual({ x: 0, y: -176 });
  });

  it('moves past a shape that sits where the copy would go', () => {
    const blocker = box('blocker', 200, 20, { locked: true }); // locked, so it is not a neighbour to connect to
    expect(at('right', [src, blocker])).toEqual({ x: 320 + 48, y: 0 });
    expect(at('left', [src, box('l', -200, 0)])).toEqual({ x: -200 - 48 - 120, y: 0 });
    expect(at('bottom', [src, box('b', 10, 150)])).toEqual({ x: 0, y: 230 + 48 });
    expect(at('top', [src, box('t', 0, -160)])).toEqual({ x: 0, y: -160 - 48 - 80 });
  });

  it('keeps clear of shapes that are only close to the spot', () => {
    // the copy would span x 216..336; a shape 20 beyond that is closer than the 48 of clearance, one 60 beyond is not
    expect(at('right', [src, box('close', 336 + 20, 0)])).toEqual({ x: 356 + 120 + 48, y: 0 });
    expect(at('right', [src, box('clear', 336 + 60, 0)])).toEqual({ x: 216, y: 0 });
  });

  it('steps past several shapes in a row and ignores ones that are far away', () => {
    const row = [box('a', 200, 0), box('b', 360, 0), box('c', 520, 0)];
    expect(at('right', [src, ...row])).toEqual({ x: 640 + 48, y: 0 });
    expect(at('right', [src, box('far', 216, 400)])).toEqual({ x: 216, y: 0 });
  });

  it('measures a rotated shape by its outline', () => {
    const turned = box('turned', 250, 0, { rotation: Math.PI / 2 }); // 120 x 80 turned on its side: spans x 270..350
    const spot = at('right', [src, turned]);
    expect(spot.x).toBeGreaterThanOrEqual(350 + 48 - 1e-6);
    expect(spot.y).toBe(0);
  });
});
