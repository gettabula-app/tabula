import { describe, expect, it } from 'vitest';
import { nearestInDirection, readingOrder, stepInOrder, type NavItem } from '../src/canvas-nav';

// docs/canvas-keyboard.md: reading order and arrow navigation, on plain boxes.

const box = (id: string, x: number, y: number, over: Partial<NavItem> = {}): NavItem => ({ id, cx: x, cy: y, w: 100, h: 100, parent: null, ...over });
const ids = (order: { id: string }[]) => order.map((e) => e.id);

describe('reading order', () => {
  it('reads rows from top to bottom and each row from left to right, with a tolerance for a row that is not straight', () => {
    const order = readingOrder([box('d', 100, 300), box('b', 300, 108), box('a', 100, 100), box('c', 500, 92), box('e', 300, 305)]);
    expect(ids(order)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('puts a frame\'s children right after it, one level deeper, in their own rows', () => {
    const order = readingOrder([
      box('frame', 300, 300, { w: 600, h: 400 }), box('n2', 400, 400, { parent: 'frame' }), box('n1', 200, 400, { parent: 'frame' }),
      box('after', 300, 800),
    ]);
    expect(order).toEqual([{ id: 'frame', level: 0 }, { id: 'n1', level: 1 }, { id: 'n2', level: 1 }, { id: 'after', level: 0 }]);
  });

  it('treats an object whose parent is gone as top level, and survives a parent cycle', () => {
    expect(ids(readingOrder([box('x', 0, 0, { parent: 'gone' })]))).toEqual(['x']);
    expect(ids(readingOrder([box('a', 0, 0, { parent: 'b' }), box('b', 200, 0, { parent: 'a' })])).sort()).toEqual(['a', 'b']);
  });

  it('reads connectors after the objects, in the order of the objects they start from', () => {
    const order = readingOrder([
      box('a', 0, 0), box('b', 300, 0), box('c', 600, 0),
      { id: 'k2', cx: 0, cy: 0, w: 0, h: 0, parent: null, connector: { from: 'b', to: 'c' } },
      { id: 'k1', cx: 0, cy: 0, w: 0, h: 0, parent: null, connector: { from: 'a', to: 'b' } },
    ]);
    expect(ids(order)).toEqual(['a', 'b', 'c', 'k1', 'k2']);
  });

  it('is empty for an empty board and stable for equal positions', () => {
    expect(readingOrder([])).toEqual([]);
    expect(ids(readingOrder([box('b', 0, 0), box('a', 0, 0)]))).toEqual(['a', 'b']);
  });
});

describe('the nearest object in a direction', () => {
  const grid = [box('a', 100, 100), box('b', 300, 100), box('c', 100, 300), box('d', 300, 300)];

  it('moves along a grid', () => {
    expect(nearestInDirection(grid, 'a', 'right')).toBe('b');
    expect(nearestInDirection(grid, 'a', 'down')).toBe('c');
    expect(nearestInDirection(grid, 'd', 'left')).toBe('c');
    expect(nearestInDirection(grid, 'd', 'up')).toBe('b');
  });

  it('answers null at an edge, for an unknown object, and ignores connectors', () => {
    expect(nearestInDirection(grid, 'a', 'left')).toBeNull();
    expect(nearestInDirection(grid, 'a', 'up')).toBeNull();
    expect(nearestInDirection(grid, 'nope', 'right')).toBeNull();
    const withConnector = [...grid, { id: 'k', cx: 200, cy: 100, w: 0, h: 0, parent: null, connector: { from: 'a', to: 'b' } }];
    expect(nearestInDirection(withConnector, 'a', 'right')).toBe('b');
  });

  it('keeps to the 90 degree cone: an object up and to the right is not "right" when it is more up than right', () => {
    const items = [box('a', 0, 0), box('steep', 100, -300), box('flat', 400, 50)];
    expect(nearestInDirection(items, 'a', 'right')).toBe('flat');
    expect(nearestInDirection(items, 'a', 'up')).toBe('steep');
  });

  it('prefers the nearer and the straighter one, and the same parent on a tie of distance', () => {
    const items = [box('a', 0, 0), box('near', 200, 0), box('far', 500, 0), box('offaxis', 200, 190)];
    expect(nearestInDirection(items, 'a', 'right')).toBe('near');
    const parents = [box('a', 0, 0, { parent: 'p' }), box('other', 200, 0, { parent: 'q' }), box('same', 220, 0, { parent: 'p' })];
    expect(nearestInDirection(parents, 'a', 'right')).toBe('same');
  });

  it('works from the centre of a big object and across overlaps', () => {
    const items = [box('big', 0, 0, { w: 800, h: 800 }), box('inside', 100, 0), box('beyond', 900, 0)];
    expect(nearestInDirection(items, 'big', 'right')).toBe('inside');
  });
});

describe('stepping in reading order', () => {
  const order = [{ id: 'a', level: 0 }, { id: 'b', level: 0 }, { id: 'c', level: 0 }];
  it('steps and stays at the ends, and starts at the right end when nothing is current', () => {
    expect(stepInOrder(order, 'a', 1)).toBe('b');
    expect(stepInOrder(order, 'c', 1)).toBe('c');
    expect(stepInOrder(order, 'a', -1)).toBe('a');
    expect(stepInOrder(order, null, 1)).toBe('a');
    expect(stepInOrder(order, null, -1)).toBe('c');
    expect(stepInOrder([], 'a', 1)).toBeNull();
  });
});
