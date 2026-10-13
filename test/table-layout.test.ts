import { describe, expect, it } from 'vitest';
import { layoutTable } from '../src/table-layout';
import { setCellPatch, tableFromGrid, tableModel } from '../shared/tables';
import { clearMeasureCache } from '../src/text';

// The table layout (TAB-121, docs/tables.md): sizes from the columns and rows, and the cache that keeps a big table from being measured again and again.

let n = 0;
const ids = () => `l${(++n).toString(36)}`;
const style = { font: 'satoshi', size: 15, weight: 400 };
const table = (grid: string[][]) => ({ id: 't1', type: 'table', ...tableFromGrid(grid, ids)! }) as Record<string, unknown>;

describe('the table layout', () => {
  it('is as wide as its columns and as tall as its rows, each row at least one line', () => {
    const t = table([['a', 'b'], ['c', 'd']]);
    const l = layoutTable(t, style);
    expect(l.w).toBe(320);
    expect(l.colX).toEqual([0, 160, 320]);
    expect(l.rowY.length).toBe(3);
    expect(l.h).toBe(l.rowY[2]);
    expect(l.rowY[1]).toBeGreaterThanOrEqual(15 * 1.45 + 14);
    expect(l.cells).toHaveLength(4);
  });

  it('a long cell makes its row taller, and a header row and column are drawn tinted and ruled off', () => {
    const plain = layoutTable(table([['a', 'b'], ['c', 'd']]), style);
    const long = layoutTable(table([['a', 'a very long cell that has to wrap onto several lines in a narrow column of the table'], ['c', 'd']]), style);
    expect(long.rowY[1]).toBeGreaterThan(plain.rowY[1]);
    const header = layoutTable({ ...table([['a', 'b'], ['c', 'd']]), headerRow: true, headerCol: true }, style);
    expect(header.items.filter((i) => i.k === 'rect' && i.tone === 'code').length).toBe(3); // 2 + 2 cells, one counted twice
    expect(header.items.filter((i) => i.k === 'line' && i.tone === 'rule').length).toBe(2);
  });

  it('gives the same layout again for the same content, a new one when a cell, the style or the font measurements change', () => {
    const t = table([['a', 'b'], ['c', 'd']]);
    const first = layoutTable(t, style);
    expect(layoutTable({ ...t }, style)).toBe(first); // the cached layout
    const m = tableModel(t);
    const edited = { ...t, ...setCellPatch(t, m.rows[0], m.cols[0], 'changed') } as Record<string, unknown>;
    expect(layoutTable(edited, style)).not.toBe(first);
    const again = layoutTable(edited, style);
    expect(layoutTable({ ...edited }, { ...style, size: 20 })).not.toBe(again);
    const before = layoutTable(edited, style);
    clearMeasureCache(); // fonts finished loading: what was measured before is stale
    expect(layoutTable(edited, style)).not.toBe(before);
  });

  it('finds the cell under a point and none outside the grid', async () => {
    const { cellAt } = await import('../src/table-layout');
    const l = layoutTable(table([['a', 'b'], ['c', 'd']]), style);
    expect(cellAt(l, 10, 10)).toMatchObject({ row: 0, col: 0 });
    expect(cellAt(l, 200, l.rowY[1] + 5)).toMatchObject({ row: 1, col: 1 });
    expect(cellAt(l, -1, 5)).toBeNull();
    expect(cellAt(l, 5, l.h + 1)).toBeNull();
  });
});
