import { describe, expect, it } from 'vitest';
import { autoOrientation, framesInOrder, pageRule, planPages, sheetFor, PAGE_MARGIN_MM, type PlanInput, type PrintFrame } from '../src/print-pages';

// Print / Save as PDF (TAB-146, docs/print.md): which pages a print makes, in which order, on which paper.

const frame = (id: string, x: number, y: number, name = id, w = 400, h = 300): PrintFrame => ({ id, name, x, y, w, h });
const input = (over: Partial<PlanInput>): PlanInput => ({
  scope: 'board', boardTitle: 'Plan', boardSize: { w: 1000, h: 600 }, selection: null, frames: [], ...over,
});

describe('print pages', () => {
  it('the whole board is one page with the board title', () => {
    expect(planPages(input({}))).toEqual([{ ids: undefined, title: 'Plan', w: 1000, h: 600 }]);
  });

  it('a selection is one page of exactly those objects; nothing selected is no page', () => {
    expect(planPages(input({ scope: 'selection', selection: { ids: ['a', 'b'], w: 300, h: 500 } }))).toEqual([{ ids: ['a', 'b'], title: 'Plan', w: 300, h: 500 }]);
    expect(planPages(input({ scope: 'selection' }))).toEqual([]);
    expect(planPages(input({ scope: 'selection', selection: { ids: [], w: 0, h: 0 } }))).toEqual([]);
  });

  it('frames print one per page in reading order: rows top to bottom, left to right in a row', () => {
    const frames = [frame('d', 0, 700), frame('b', 500, 10), frame('a', 0, 0), frame('c', 1000, 20)];
    expect(framesInOrder(frames).map((f) => f.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(planPages(input({ scope: 'frames', frames })).map((p) => p.ids)).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('a frame without a name gets a numbered title; empty frames are skipped; no frames is no pages', () => {
    const pages = planPages(input({ scope: 'frames', frames: [frame('a', 0, 0, '  '), frame('z', 500, 0, 'Zero', 0, 0), frame('b', 0, 500, 'Second')] }));
    expect(pages.map((p) => p.title)).toEqual(['Frame 1', 'Second']);
    expect(planPages(input({ scope: 'frames' }))).toEqual([]);
  });

  it('the orientation follows the majority of pages, a tie going to landscape', () => {
    const wide = { w: 800, h: 400 }, tall = { w: 400, h: 800 };
    expect(autoOrientation([wide, wide, tall])).toBe('landscape');
    expect(autoOrientation([tall, tall, wide])).toBe('portrait');
    expect(autoOrientation([wide, tall])).toBe('landscape');
  });

  it('the sheet swaps the paper for landscape and leaves the margins inside', () => {
    const a4 = sheetFor('a4', 'landscape', []);
    expect([a4.w, a4.h, a4.innerW, a4.innerH]).toEqual([297, 210, 297 - PAGE_MARGIN_MM * 2, 210 - PAGE_MARGIN_MM * 2]);
    expect(sheetFor('letter', 'portrait', [])).toMatchObject({ orientation: 'portrait', w: 215.9, h: 279.4 });
    expect(sheetFor('a4', 'auto', [{ w: 100, h: 400 }]).orientation).toBe('portrait');
  });

  it('writes the @page rule with the paper name, orientation and margin', () => {
    expect(pageRule('a4', sheetFor('a4', 'landscape', []))).toBe('@page { size: A4 landscape; margin: 12mm; }');
    expect(pageRule('letter', sheetFor('letter', 'portrait', []))).toBe('@page { size: letter portrait; margin: 12mm; }');
  });
});
