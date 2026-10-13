import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import {
  MAX_CELL_CHARS, MAX_TABLE_COLS, MAX_TABLE_ROWS, cellKey, deleteColPatch, deleteRowPatch, fillFromPatch, insertColPatch, insertRowPatch,
  moveColPatch, moveRowPatch, newTableFields, parseGrid, setCellPatch, setWidthPatch, tableFromGrid, tableModel, toMarkdownTable, toTsv,
} from '../shared/tables';

// The table model (TAB-121, docs/tables.md): one flat map whose keys are its parts, so different cells and concurrent row or
// column inserts merge without conflict. Pure model operations, then the property itself on two real documents.

let n = 0;
const ids = () => `i${(++n).toString(36)}`;
const fresh = (rows = 3, cols = 3) => newTableFields(rows, cols, ids) as Record<string, unknown>;
const apply = (obj: Record<string, unknown>, patch: Record<string, unknown> | null) => {
  expect(patch).not.toBeNull();
  for (const [k, v] of Object.entries(patch!)) { if (v === undefined) delete obj[k]; else obj[k] = v; }
  return obj;
};

describe('table model', () => {
  it('a new table has the rows and columns asked for, in order, within the limits', () => {
    const t = tableModel(fresh(3, 4));
    expect([t.rows.length, t.cols.length]).toEqual([3, 4]);
    expect(tableModel(newTableFields(500, 500, ids)).rows.length).toBe(MAX_TABLE_ROWS);
    expect(tableModel(newTableFields(500, 500, ids)).cols.length).toBe(MAX_TABLE_COLS);
    expect(tableModel(newTableFields(0, 0, ids)).rows.length).toBe(1);
  });

  it('inserts a row anywhere without touching the others, and refuses past the limit', () => {
    const t = fresh(2, 2);
    const [a, b] = tableModel(t).rows;
    apply(t, setCellPatch(t, a, tableModel(t).cols[0], 'first'));
    apply(t, insertRowPatch(t, 0, 'mid'));
    apply(t, insertRowPatch(t, -1, 'top'));
    apply(t, insertRowPatch(t, 3, 'end'));
    expect(tableModel(t).rows).toEqual(['top', a, 'mid', b, 'end']);
    expect(tableModel(t).cell(a, tableModel(t).cols[0])).toBe('first'); // a cell key never moves
    expect(insertRowPatch(t, 0, 'mid')).toBeNull(); // the id is taken
    expect(insertRowPatch(t, 0, 'bad id!')).toBeNull();
    const full = newTableFields(MAX_TABLE_ROWS, 1, ids);
    expect(insertRowPatch(full, 0, 'more')).toBeNull();
  });

  it('removes a row or column with its cells, never the last one', () => {
    const t = fresh(2, 2);
    const m = tableModel(t);
    apply(t, setCellPatch(t, m.rows[0], m.cols[0], 'a'));
    apply(t, setCellPatch(t, m.rows[1], m.cols[0], 'b'));
    apply(t, setWidthPatch(t, m.cols[0], 220));
    apply(t, deleteColPatch(t, m.cols[0]));
    expect(Object.keys(t).filter((k) => k.startsWith('c:') || k === `w:${m.cols[0]}`)).toEqual([]);
    expect(deleteColPatch(t, m.cols[1])).toBeNull();
    apply(t, deleteRowPatch(t, m.rows[0]));
    expect(deleteRowPatch(t, m.rows[1])).toBeNull();
    expect(tableModel(t).rows).toEqual([m.rows[1]]);
  });

  it('moves a row or column to an index of the order without it', () => {
    const t = fresh(4, 3);
    const { rows, cols } = tableModel(t);
    apply(t, moveRowPatch(t, rows[0], 2));
    expect(tableModel(t).rows).toEqual([rows[1], rows[2], rows[0], rows[3]]);
    apply(t, moveRowPatch(t, rows[3], 0));
    expect(tableModel(t).rows).toEqual([rows[3], rows[1], rows[2], rows[0]]);
    apply(t, moveColPatch(t, cols[2], 0));
    expect(tableModel(t).cols).toEqual([cols[2], cols[0], cols[1]]);
    expect(moveRowPatch(t, 'nope', 0)).toBeNull();
  });

  it('sets a cell: line breaks are normalised, empty removes the key, a long or unknown cell is refused', () => {
    const t = fresh(2, 2);
    const { rows, cols } = tableModel(t);
    apply(t, setCellPatch(t, rows[0], cols[0], 'a\r\nb'));
    expect(t[cellKey(rows[0], cols[0])]).toBe('a\nb');
    apply(t, setCellPatch(t, rows[0], cols[0], ''));
    expect(cellKey(rows[0], cols[0]) in t).toBe(false);
    expect(setCellPatch(t, rows[0], cols[0], 'x'.repeat(MAX_CELL_CHARS + 1))).toBeNull();
    expect(setCellPatch(t, 'gone', cols[0], 'x')).toBeNull();
  });

  it('reads no cell of a row or column that is gone, and ignores keys that are not table parts', () => {
    const t = { ...fresh(1, 1), title: 'x', 'c:zz:yy': 'orphan', 'r:Bad Id': 'a0' } as Record<string, unknown>;
    const m = tableModel(t);
    expect(m.rows.length).toBe(1);
    expect(m.cell('zz', 'yy')).toBe('');
  });

  it('column widths are kept within bounds', () => {
    const t = fresh(1, 1);
    const c = tableModel(t).cols[0];
    expect(tableModel(t).width(c)).toBe(160);
    apply(t, setWidthPatch(t, c, 5));
    expect(tableModel(t).width(c)).toBe(60);
    apply(t, setWidthPatch(t, c, 9999));
    expect(tableModel(t).width(c)).toBe(800);
    expect(setWidthPatch(t, c, Number.NaN)).toBeNull();
  });
});

describe('table text', () => {
  it('parses a spreadsheet copy (tabs) and a CSV file (commas, quotes), and ignores a trailing empty line', () => {
    expect(parseGrid('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseGrid('name,note\n"Smith, J","said ""hi"""\n')).toEqual([['name', 'note'], ['Smith, J', 'said "hi"']]);
    expect(parseGrid('"line\nbreak",x')).toEqual([['line\nbreak', 'x']]);
    expect(parseGrid('a\r\nb')).toEqual([['a'], ['b']]);
    expect(parseGrid('   \n')).toEqual([]);
    expect(parseGrid('')).toEqual([]);
  });

  it('makes a table from a grid, padding short rows and capping the size', () => {
    const t = tableFromGrid([['a', 'b', 'c'], ['1']], ids)!;
    const m = tableModel(t);
    expect([m.rows.length, m.cols.length]).toEqual([2, 3]);
    expect([m.cell(m.rows[0], m.cols[2]), m.cell(m.rows[1], m.cols[0]), m.cell(m.rows[1], m.cols[1])]).toEqual(['c', '1', '']);
    expect(tableFromGrid([], ids)).toBeNull();
    const big = tableFromGrid(Array.from({ length: 150 }, () => Array.from({ length: 50 }, () => 'x')), ids)!;
    expect([tableModel(big).rows.length, tableModel(big).cols.length]).toEqual([MAX_TABLE_ROWS, MAX_TABLE_COLS]);
  });

  it('fills an existing table from a cell, adding the rows and columns it needs', () => {
    const t = fresh(1, 2);
    const m0 = tableModel(t);
    apply(t, fillFromPatch(t, m0.rows[0], m0.cols[1], [['a', 'b'], ['c', 'd']], ids));
    const m = tableModel(t);
    expect([m.rows.length, m.cols.length]).toEqual([2, 3]);
    expect(m.cell(m.rows[0], m.cols[1])).toBe('a');
    expect(m.cell(m.rows[1], m.cols[2])).toBe('d');
    expect(fillFromPatch(t, 'gone', m.cols[0], [['x']], ids)).toBeNull();
  });

  it('writes TSV and a Markdown table, with pipes and line breaks made safe', () => {
    const t = tableFromGrid([['h1', 'h2'], ['a|b', 'x\ny']], ids)!;
    expect(toTsv(t)).toBe('h1\th2\na|b\tx y');
    expect(toMarkdownTable(t)).toBe('| h1 | h2 |\n| --- | --- |\n| a\\|b | x y |');
    expect(toMarkdownTable({})).toBe('');
  });
});

describe('table merging', () => {
  const twoClients = () => {
    const a = new Store(new Y.Doc());
    const b = new Store(new Y.Doc());
    const sync = () => {
      const ua = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
      const ub = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
      Y.applyUpdate(b.doc, ua);
      Y.applyUpdate(a.doc, ub);
    };
    a.create({ id: 't1', type: 'table', x: 0, y: 0, w: 480, h: 120, rotation: 0, z: 'a0', ...newTableFields(2, 2, ids) } as never);
    sync();
    return { a, b, sync };
  };
  const obj = (s: Store) => s.get('t1') as unknown as Record<string, unknown>;
  const write = (s: Store, patch: Record<string, unknown> | null) => s.update('t1', patch as never);

  it('two people editing different cells at the same time both keep their cell', () => {
    const { a, b, sync } = twoClients();
    const m = tableModel(obj(a));
    write(a, setCellPatch(obj(a), m.rows[0], m.cols[0], 'from A'));
    write(b, setCellPatch(obj(b), m.rows[1], m.cols[1], 'from B'));
    sync();
    for (const s of [a, b]) {
      const t = tableModel(obj(s));
      expect([t.cell(m.rows[0], m.cols[0]), t.cell(m.rows[1], m.cols[1])]).toEqual(['from A', 'from B']);
    }
  });

  it('two row inserts at the same place both survive, in the same order on both sides', () => {
    const { a, b, sync } = twoClients();
    write(a, insertRowPatch(obj(a), 0, 'rowa'));
    write(b, insertRowPatch(obj(b), 0, 'rowb'));
    sync();
    const ra = tableModel(obj(a)).rows;
    expect(ra).toEqual(tableModel(obj(b)).rows);
    expect(ra).toHaveLength(4);
    expect(ra).toEqual(expect.arrayContaining(['rowa', 'rowb']));
  });

  it('a column insert and a row insert, and a cell edit in the new row, merge', () => {
    const { a, b, sync } = twoClients();
    write(a, insertColPatch(obj(a), 1, 'cola'));
    write(b, insertRowPatch(obj(b), 1, 'rowb'));
    sync();
    write(b, setCellPatch(obj(b), 'rowb', tableModel(obj(b)).cols[2], 'new'));
    sync();
    const t = tableModel(obj(a));
    expect([t.rows.length, t.cols.length, t.cell('rowb', 'cola')]).toEqual([3, 3, 'new']);
  });

  it('a delete that races with an edit of the same row leaves a table that reads cleanly', () => {
    const { a, b, sync } = twoClients();
    const m = tableModel(obj(a));
    write(a, deleteRowPatch(obj(a), m.rows[0]));
    write(b, setCellPatch(obj(b), m.rows[0], m.cols[0], 'late'));
    sync();
    const t = tableModel(obj(a));
    expect(t.rows).toEqual([m.rows[1]]);
    expect(t.cell(m.rows[0], m.cols[0])).toBe('');
    expect(tableModel(obj(b)).rows).toEqual(t.rows);
  });
});
