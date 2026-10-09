import { describe, expect, it } from 'vitest';
import { STICKY, layoutProposal, nextFree, stickyFill, type Existing } from '../src/ai-apply';
import { STICKY_COLORS } from '../src/palette';

// docs/ai.md, "Proposals": the app lays a proposal out itself, right of everything on the board (the MCP's nextFree), and
// the preview and the add share this layout.

const board = (content: { x: number; y: number; w: number; h: number } | null, objects: Record<string, Existing> = {}) => ({
  content,
  get: (id: string) => objects[id],
});

describe('nextFree', () => {
  it('is 80 right of the content, level with its top; the origin on an empty board', () => {
    expect(nextFree({ x: 10, y: -40, w: 500, h: 300 })).toEqual({ x: 590, y: -40 });
    expect(nextFree(null)).toEqual({ x: 0, y: 0 });
  });

  it('also clears the areas of other previews', () => {
    expect(nextFree({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 180, y: 0, w: 400, h: 400 }])).toEqual({ x: 660, y: 0 });
    expect(nextFree(null, [{ x: 0, y: 50, w: 100, h: 100 }])).toEqual({ x: 180, y: 50 });
  });
});

describe('stickyFill', () => {
  it('maps a colour name in any case to the palette, and anything else to the first colour', () => {
    expect(stickyFill('pink')).toBe(STICKY_COLORS.find((c) => c.name === 'Pink')!.fill);
    expect(stickyFill('TEAL')).toBe(STICKY_COLORS.find((c) => c.name === 'Teal')!.fill);
    expect(stickyFill(undefined)).toBe(STICKY_COLORS[0].fill);
    expect(stickyFill('magenta')).toBe(STICKY_COLORS[0].fill);
  });
});

describe('a create proposal', () => {
  it('lays stickies out in a near-square grid at nextFree', () => {
    const l = layoutProposal({ kind: 'create', objects: [1, 2, 3, 4, 5].map((n) => ({ text: `n${n}` })) }, board({ x: 0, y: 0, w: 100, h: 100 }));
    if (l?.kind !== 'create') throw new Error('kind');
    expect(l.frame).toBeNull();
    expect(l.stickies.map((s) => [s.x, s.y])).toEqual([[180, 0], [396, 0], [612, 0], [180, 216], [396, 216]]);
    expect(l.stickies.every((s) => s.w === STICKY && s.h === STICKY)).toBe(true);
    expect(l.area).toEqual({ x: 180, y: 0, w: 3 * 216 - 24, h: 2 * 216 - 24 });
  });

  it('puts them inside a frame with padding when the proposal names one', () => {
    const l = layoutProposal({ kind: 'create', objects: [{ text: 'a', color: 'Blue' }], frame: { title: 'Summary' } }, board(null));
    if (l?.kind !== 'create') throw new Error('kind');
    expect(l.frame).toEqual({ x: 0, y: 0, w: STICKY + 96, h: STICKY + 96, title: 'Summary' });
    expect(l.stickies[0]).toMatchObject({ x: 48, y: 48, text: 'a', fill: stickyFill('Blue') });
  });
});

describe('a group proposal', () => {
  const objects: Record<string, Existing> = {
    a: { type: 'sticky', x: 0, y: 0, w: 192, h: 192 },
    b: { type: 'sticky', x: 300, y: 0, w: 192, h: 192 },
    c: { type: 'sticky', x: 600, y: 0, w: 220, h: 192 },
    t: { type: 'text', x: 0, y: 400, w: 100, h: 28 },
    l: { type: 'sticky', x: 0, y: 600, w: 192, h: 192, locked: true },
  };

  it('moves the stickies into columns under their titles, keeping their sizes', () => {
    const l = layoutProposal({ kind: 'group', groups: [{ title: 'One', ids: ['a', 'c'] }, { title: 'Two', ids: ['b'] }] }, board({ x: 0, y: 0, w: 820, h: 192 }, objects));
    if (l?.kind !== 'group') throw new Error('kind');
    expect(l.headers.map((h) => [h.title, h.x, h.y])).toEqual([['One', 900, 0], ['Two', 1140, 0]]);
    expect(l.moves).toEqual([
      { id: 'a', from: { x: 0, y: 0, w: 192, h: 192 }, to: { x: 900, y: 48, w: 192, h: 192 } },
      { id: 'c', from: { x: 600, y: 0, w: 220, h: 192 }, to: { x: 900, y: 264, w: 220, h: 192 } },
      { id: 'b', from: { x: 300, y: 0, w: 192, h: 192 }, to: { x: 1140, y: 48, w: 192, h: 192 } },
    ]);
    expect(l.area).toEqual({ x: 900, y: 0, w: 2 * 240 - 48, h: 456 });
  });

  it('does not fit a board where a sticky it names is gone, locked or not a sticky', () => {
    const b = board({ x: 0, y: 0, w: 100, h: 100 }, objects);
    expect(layoutProposal({ kind: 'group', groups: [{ title: 'x', ids: ['a', 'gone'] }] }, b)).toBeNull();
    expect(layoutProposal({ kind: 'group', groups: [{ title: 'x', ids: ['a', 'l'] }] }, b)).toBeNull();
    expect(layoutProposal({ kind: 'group', groups: [{ title: 'x', ids: ['a', 't'] }] }, b)).toBeNull();
  });
});
