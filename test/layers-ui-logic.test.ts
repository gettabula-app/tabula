import { describe, expect, it } from 'vitest';
import {
  DRAG_START, canDrag, clickSelection, collapsedKey, dropTarget, hiddenText, isSelectable, keyIntent, lineEdge, navigate, parseCollapsed,
  pastDragStart, renameChange, rowName, serializeCollapsed, siblingSlots, subject, toggleLabel, toggleVerb, typeGlyph,
} from '../src/layers-ui-logic';
import { NAME_MAX, TYPE_LABEL, type LayerNode } from '../src/layers';
import { ICONS } from '../src/ui/dom';

const node = (id: string, extra: Partial<LayerNode> = {}): LayerNode => ({
  id, type: 'sticky', label: id, depth: 0, parent: null, locked: false, hidden: false, movable: true, expandable: false, expanded: false, childCount: 0, ...extra,
});

const NONE = { alt: false, ctrl: false, meta: false, shift: false };

// top first: a, frame f (open) with children c, d, then frame g (closed); frames are listed last
const rows = (): LayerNode[] => [
  node('a'),
  node('f', { type: 'frame', expandable: true, expanded: true, childCount: 2 }),
  node('c', { depth: 1, parent: 'f' }),
  node('d', { depth: 1, parent: 'f' }),
  node('g', { type: 'frame', expandable: true, expanded: false, childCount: 1 }),
];

describe('collapsed containers', () => {
  it('keeps the storage id the app uses for its other per-board settings', () => {
    expect(collapsedKey('b1')).toBe('driftboard:layers-collapsed:b1');
  });

  it('round-trips a set of ids', () => {
    expect(parseCollapsed(serializeCollapsed(new Set(['f', 'g'])))).toEqual(new Set(['f', 'g']));
  });

  it('reads nothing, junk or the wrong shape as an empty set', () => {
    expect(parseCollapsed(null)).toEqual(new Set());
    expect(parseCollapsed('')).toEqual(new Set());
    expect(parseCollapsed('{')).toEqual(new Set());
    expect(parseCollapsed('{"a":1}')).toEqual(new Set());
    expect(parseCollapsed('["a",1,null,"b"]')).toEqual(new Set(['a', 'b']));
  });
});

describe('words', () => {
  it('shows the hidden count only when something is hidden', () => {
    expect(hiddenText(0)).toBeNull();
    expect(hiddenText(1)).toBe('1 hidden');
    expect(hiddenText(12)).toBe('12 hidden');
  });

  it('names a row by its type and label, once when they are the same', () => {
    expect(subject(node('x', { type: 'sticky', label: 'Ideas' }))).toBe('Sticky note: Ideas');
    expect(subject(node('x', { type: 'frame', label: 'Frame' }))).toBe('Frame');
    expect(subject(node('x', { type: 'mystery', label: 'Object' }))).toBe('Object');
    expect(subject(node('x', { type: 'mystery', label: 'Plan' }))).toBe('Object: Plan');
  });

  it('adds hidden and locked to the name a screen reader reads', () => {
    expect(rowName(node('x', { label: 'Ideas' }))).toBe('Sticky note: Ideas');
    expect(rowName(node('x', { label: 'Ideas', hidden: true }))).toBe('Sticky note: Ideas, hidden');
    expect(rowName(node('x', { label: 'Ideas', hidden: true, locked: true }))).toBe('Sticky note: Ideas, hidden, locked');
  });

  it('labels the toggles by what they are, the same whether pressed or not', () => {
    const on = node('x', { label: 'Ideas', hidden: true, locked: true });
    const off = node('x', { label: 'Ideas' });
    expect(toggleLabel('hide', off)).toBe('Hide Sticky note: Ideas');
    expect(toggleLabel('hide', on)).toBe('Hide Sticky note: Ideas');
    expect(toggleLabel('lock', off)).toBe('Lock Sticky note: Ideas');
    expect(toggleLabel('lock', on)).toBe('Lock Sticky note: Ideas');
    expect(toggleLabel('hide', node('f', { type: 'frame', label: 'Frame' }))).toBe('Hide Frame');
  });

  it('tells in the tooltip what pressing the toggle does', () => {
    expect(toggleVerb('hide', node('x'))).toBe('Hide');
    expect(toggleVerb('hide', node('x', { hidden: true }))).toBe('Show');
    expect(toggleVerb('lock', node('x'))).toBe('Lock');
    expect(toggleVerb('lock', node('x', { locked: true }))).toBe('Unlock');
  });
});

describe('glyphs', () => {
  it('gives every type the panel can list a glyph that exists', () => {
    for (const type of [...Object.keys(TYPE_LABEL), 'something-new']) {
      expect(Object.keys(ICONS)).toContain(typeGlyph(type));
    }
    for (const kind of ['rect', 'ellipse', 'diamond', 'rounded', undefined]) {
      expect(Object.keys(ICONS)).toContain(typeGlyph('shape', kind));
    }
  });

  it('draws what the object is', () => {
    expect(typeGlyph('sticky')).toBe('sticky');
    expect(typeGlyph('frame')).toBe('frame');
    expect(typeGlyph('shape', 'ellipse')).toBe('ellipse');
    expect(typeGlyph('shape', 'diamond')).toBe('diamond');
    expect(typeGlyph('shape', 'hexagon')).toBe('rect');
    expect(typeGlyph('uml-class')).toBe('uml');
  });

  it('has the eye and lock glyphs the toggles show', () => {
    for (const name of ['layers', 'eye', 'eyeOff', 'lock', 'unlock', 'menu']) expect(Object.keys(ICONS)).toContain(name);
  });
});

describe('aria positions', () => {
  it('numbers each row among its siblings', () => {
    const slots = siblingSlots(rows());
    expect(slots.get('a')).toEqual({ pos: 1, size: 3 });
    expect(slots.get('f')).toEqual({ pos: 2, size: 3 });
    expect(slots.get('g')).toEqual({ pos: 3, size: 3 });
    expect(slots.get('c')).toEqual({ pos: 1, size: 2 });
    expect(slots.get('d')).toEqual({ pos: 2, size: 2 });
  });
});

describe('clicking a row', () => {
  it('selects just that object', () => {
    expect(clickSelection(['x', 'y'], node('a'), false)).toEqual(['a']);
  });

  it('adds to the selection and takes out of it with Shift, Ctrl or Cmd', () => {
    expect(clickSelection(['x'], node('a'), true)).toEqual(['x', 'a']);
    expect(clickSelection(['x', 'a'], node('a'), true)).toEqual(['x']);
  });

  it('only focuses a hidden or a locked row, whatever the keys held', () => {
    expect(clickSelection(['x'], node('a', { hidden: true }), false)).toBeNull();
    expect(clickSelection(['x'], node('a', { locked: true }), true)).toBeNull();
    expect(isSelectable(node('a', { hidden: true }))).toBe(false);
    expect(isSelectable(node('a', { locked: true }))).toBe(false);
    expect(isSelectable(node('a'))).toBe(true);
  });
});

describe('renaming', () => {
  it('writes a new name', () => {
    expect(renameChange('Old', 'Old', 'New')).toEqual({ write: true, name: 'New' });
    expect(renameChange(undefined, 'Sticky note', 'Ideas')).toEqual({ write: true, name: 'Ideas' });
  });

  it('writes nothing when the name is the same', () => {
    expect(renameChange('Old', 'Old', 'Old')).toEqual({ write: false });
    expect(renameChange('Old', 'Old', '  Old  ')).toEqual({ write: false });
  });

  it('does not turn a label made from the text or the type into a stored name', () => {
    expect(renameChange(undefined, 'Reviews were fast', 'Reviews were fast')).toEqual({ write: false });
    expect(renameChange(undefined, 'Frame', 'Frame')).toEqual({ write: false });
    expect(renameChange(undefined, 'Frame', '   ')).toEqual({ write: false });
  });

  it('clears a stored name when the field is emptied', () => {
    expect(renameChange('Old', 'Old', '')).toEqual({ write: true, name: undefined });
    expect(renameChange('Old', 'Old', ' \n ')).toEqual({ write: true, name: undefined });
  });

  it('stores one line of at most the longest name', () => {
    expect(renameChange(undefined, 'Frame', 'two\nlines')).toEqual({ write: true, name: 'two lines' });
    const long = renameChange(undefined, 'Frame', 'x'.repeat(NAME_MAX + 20));
    expect(long.name).toHaveLength(NAME_MAX);
  });
});

describe('keys', () => {
  it('moves focus with the arrows, Home and End', () => {
    expect(keyIntent('ArrowUp', NONE)).toBe('prev');
    expect(keyIntent('ArrowDown', NONE)).toBe('next');
    expect(keyIntent('ArrowRight', NONE)).toBe('right');
    expect(keyIntent('ArrowLeft', NONE)).toBe('left');
    expect(keyIntent('Home', NONE)).toBe('first');
    expect(keyIntent('End', NONE)).toBe('last');
  });

  it('selects with Enter or Space, adding with Shift', () => {
    expect(keyIntent('Enter', NONE)).toBe('select');
    expect(keyIntent(' ', NONE)).toBe('select');
    expect(keyIntent('Enter', { ...NONE, shift: true })).toBe('selectMore');
    expect(keyIntent(' ', { ...NONE, shift: true })).toBe('selectMore');
  });

  it('renames with F2 and toggles with H and L, in either case', () => {
    expect(keyIntent('F2', NONE)).toBe('rename');
    expect(keyIntent('h', NONE)).toBe('hide');
    expect(keyIntent('H', NONE)).toBe('hide');
    expect(keyIntent('l', NONE)).toBe('lock');
    expect(keyIntent('L', { ...NONE, shift: true })).toBe('lock');
  });

  it('moves the row with Alt and the up and down arrows', () => {
    expect(keyIntent('ArrowUp', { ...NONE, alt: true })).toBe('moveUp');
    expect(keyIntent('ArrowDown', { ...NONE, alt: true })).toBe('moveDown');
    expect(keyIntent('ArrowLeft', { ...NONE, alt: true })).toBeNull();
    expect(keyIntent('h', { ...NONE, alt: true })).toBeNull();
  });

  it('leaves Ctrl and Cmd combinations, Tab and Escape to the page', () => {
    expect(keyIntent('z', { ...NONE, ctrl: true })).toBeNull();
    expect(keyIntent('h', { ...NONE, meta: true })).toBeNull();
    expect(keyIntent('ArrowDown', { ...NONE, ctrl: true })).toBeNull();
    expect(keyIntent('Tab', NONE)).toBeNull();
    expect(keyIntent('Escape', NONE)).toBeNull();
    expect(keyIntent('Delete', NONE)).toBeNull();
    expect(keyIntent('x', NONE)).toBeNull();
  });
});

describe('moving through the rows', () => {
  const list = rows();

  it('goes to the row above and below, and stops at the ends', () => {
    expect(navigate(list, 'f', 'prev')).toEqual({ focus: 'a' });
    expect(navigate(list, 'f', 'next')).toEqual({ focus: 'c' });
    expect(navigate(list, 'a', 'prev')).toBeNull();
    expect(navigate(list, 'g', 'next')).toBeNull();
  });

  it('goes to the first and last row', () => {
    expect(navigate(list, 'd', 'first')).toEqual({ focus: 'a' });
    expect(navigate(list, 'd', 'last')).toEqual({ focus: 'g' });
    expect(navigate(list, 'a', 'first')).toBeNull();
    expect(navigate(list, 'g', 'last')).toBeNull();
  });

  it('opens a closed container with ArrowRight, then enters it', () => {
    expect(navigate(list, 'g', 'right')).toEqual({ expand: 'g' });
    expect(navigate(list, 'f', 'right')).toEqual({ focus: 'c' });
    expect(navigate(list, 'a', 'right')).toBeNull();
    expect(navigate(list, 'c', 'right')).toBeNull();
  });

  it('does not enter an open container that has nothing in it', () => {
    const empty = [node('e', { type: 'frame', expandable: true, expanded: true }), node('z')];
    expect(navigate(empty, 'e', 'right')).toBeNull();
  });

  it('closes an open container with ArrowLeft, then goes to the parent', () => {
    expect(navigate(list, 'f', 'left')).toEqual({ collapse: 'f' });
    expect(navigate(list, 'c', 'left')).toEqual({ focus: 'f' });
    expect(navigate(list, 'g', 'left')).toBeNull();
    expect(navigate(list, 'a', 'left')).toBeNull();
  });

  it('does nothing for a row that is not listed', () => {
    expect(navigate(list, 'nope', 'next')).toBeNull();
    expect(navigate([], 'a', 'first')).toBeNull();
  });
});

describe('dragging', () => {
  it('starts after four pixels in any direction', () => {
    expect(DRAG_START).toBe(4);
    expect(pastDragStart(0, 0)).toBe(false);
    expect(pastDragStart(3, 0)).toBe(false);
    expect(pastDragStart(0, -4)).toBe(true);
    expect(pastDragStart(3, 3)).toBe(true);
  });

  it('is not offered for laid out rows or on a board nobody can change', () => {
    expect(canDrag(node('a'), false)).toBe(true);
    expect(canDrag(node('a'), true)).toBe(false);
    expect(canDrag(node('a', { movable: false }), false)).toBe(false);
  });

  const flat = [node('a'), node('b'), node('c'), node('d')];

  it('drops above the upper half of a row and below the lower half', () => {
    expect(dropTarget(flat, 'd', 'b', 0.25)).toEqual({ target: 'b', where: 'above' });
    expect(dropTarget(flat, 'd', 'b', 0.75)).toEqual({ target: 'b', where: 'below' });
    expect(dropTarget(flat, 'a', 'c', 0.5)).toEqual({ target: 'c', where: 'below' });
  });

  it('shows no line where the row already is', () => {
    expect(dropTarget(flat, 'b', 'a', 0.75)).toBeNull();
    expect(dropTarget(flat, 'b', 'c', 0.25)).toBeNull();
    expect(dropTarget(flat, 'b', 'b', 0.25)).toBeNull();
  });

  it('only drops among rows of the same parent', () => {
    const list = rows();
    expect(dropTarget(list, 'c', 'd', 0.75)).toEqual({ target: 'd', where: 'below' });
    expect(dropTarget(list, 'c', 'a', 0.25)).toBeNull();
    expect(dropTarget(list, 'a', 'c', 0.25)).toBeNull();
    const kids = [node('f', { type: 'frame', expandable: true, expanded: true }), node('c', { depth: 1, parent: 'f' }), node('d', { depth: 1, parent: 'f' }), node('e', { depth: 1, parent: 'f' })];
    expect(dropTarget(kids, 'e', 'c', 0.25)).toEqual({ target: 'c', where: 'above' });
  });

  it('keeps frames among frames', () => {
    const list = [node('a'), node('b'), node('f', { type: 'frame' }), node('g', { type: 'frame' })];
    expect(dropTarget(list, 'a', 'f', 0.25)).toBeNull();
    expect(dropTarget(list, 'f', 'b', 0.75)).toBeNull();
    expect(dropTarget(list, 'g', 'f', 0.25)).toEqual({ target: 'f', where: 'above' });
  });

  it('does not drop on or from rows a container lays out', () => {
    const list = [node('a'), node('b', { movable: false }), node('c')];
    expect(dropTarget(list, 'a', 'b', 0.5)).toBeNull();
    expect(dropTarget(list, 'b', 'a', 0.5)).toBeNull();
    expect(dropTarget(list, 'c', 'a', 0.25)).toEqual({ target: 'a', where: 'above' });
  });

  it('knows nothing of rows that are not listed', () => {
    expect(dropTarget(flat, 'nope', 'a', 0.25)).toBeNull();
    expect(dropTarget(flat, 'a', 'nope', 0.25)).toBeNull();
  });

  it('draws the line on the top of the row above it, and under the last row beneath one it is below', () => {
    const list = rows();
    expect(lineEdge(list, { target: 'a', where: 'above' })).toEqual({ row: 'a', edge: 'top' });
    expect(lineEdge(list, { target: 'a', where: 'below' })).toEqual({ row: 'a', edge: 'bottom' });
    expect(lineEdge(list, { target: 'f', where: 'below' })).toEqual({ row: 'd', edge: 'bottom' });
    expect(lineEdge(list, { target: 'g', where: 'below' })).toEqual({ row: 'g', edge: 'bottom' });
    expect(lineEdge(list, { target: 'f', where: 'above' })).toEqual({ row: 'f', edge: 'top' });
  });
});
