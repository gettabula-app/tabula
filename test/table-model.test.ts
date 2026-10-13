import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import {
  MAX_CELL_CHARS, MAX_TABLE_COLS, MAX_TABLE_ROWS, cellKey, deleteColPatch, deleteRowPatch, fillFromPatch, insertColPatch, insertRowPatch,
  MAX_TABLE_CHARS, gridChars, isValidRank, tableChars, clearCellsPatch, moveColPatch, moveRowPatch, newTableFields, parseGrid, setAlignPatch, setCellPatch, setFillPatch, setWidthPatch, tableFromGrid, tableModel, toMarkdownTable, toTsv,
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

describe('a damaged rank does not stop the table (review of TAB-121)', () => {
  it('knows which ranks fractional indexing accepts', () => {
    expect(['a0', 'a1', 'Zz', 'b00', 'a0V'].map(isValidRank)).toEqual([true, true, true, true, true]);
    expect(['', 'a', '!!', '0', 'x'.repeat(65), 5, null].map(isValidRank)).toEqual([false, false, false, false, false, false, false]);
  });

  it('still inserts, moves and deletes rows and columns when stored ranks are invalid, and keeps the cells of such a line', () => {
    const t = fresh(2, 2) as Record<string, unknown>;
    const m0 = tableModel(t);
    t['r:bad1'] = 'a'; // not a key fractional-indexing accepts: generateKeyBetween would throw on it
    t['k:bad2'] = '!!';
    t['c:bad1:bad2'] = 'kept';
    const m = tableModel(t);
    expect(m.rows).toEqual([...m0.rows, 'bad1']); // a damaged line sorts last
    expect(m.cols).toEqual([...m0.cols, 'bad2']);
    expect(m.cell('bad1', 'bad2')).toBe('kept');
    apply(t, insertRowPatch(t, 0, 'newrow'));
    apply(t, insertColPatch(t, -1, 'newcol'));
    apply(t, insertRowPatch(t, 99, 'last'));
    apply(t, moveRowPatch(t, 'bad1', 0));
    apply(t, moveColPatch(t, 'bad2', 1));
    expect(tableModel(t).rows[0]).toBe('bad1');
    expect(isValidRank(t['r:bad1'] as string)).toBe(true); // moving it healed its rank
    apply(t, deleteRowPatch(t, m0.rows[0]));
    apply(t, deleteColPatch(t, m0.cols[0]));
    expect(tableModel(t).rows.includes('newrow')).toBe(true);
  });
});

describe('the table text cap', () => {
  it('refuses a cell that would take the whole table past MAX_TABLE_CHARS, and always lets a cell shrink', () => {
    const t = fresh(100, 3) as Record<string, unknown>;
    const { rows, cols } = tableModel(t);
    const big = 'x'.repeat(1000);
    // fill most of the budget through the raw keys (as an import would)
    for (const r of rows) t[`c:${r}:${cols[0]}`] = big;
    for (let i = 1; i < 50; i++) t[`c:${rows[i]}:${cols[1]}`] = big;
    expect(tableChars(t)).toBe(149 * 1000);
    t[`c:ghost:${cols[1]}`] = big; // a cell outside the grid is not shown and does not count
    t[`c:${rows[0]}:ghost`] = big;
    expect(tableChars(t)).toBe(149 * 1000);
    expect(setCellPatch(t, rows[0], cols[1], big)).not.toBeNull(); // 150,000 exactly
    apply(t, setCellPatch(t, rows[0], cols[1], big));
    expect(setCellPatch(t, rows[0], cols[2], 'x')).toBeNull(); // one more character is over
    expect(setCellPatch(t, rows[0], cols[0], 'short')).not.toBeNull();
    expect(MAX_TABLE_CHARS).toBe(150_000);
  });

  it('a paste that would pass the cap is refused by fillFromPatch, and gridChars counts what a grid would keep', () => {
    const t = fresh(1, 1) as Record<string, unknown>;
    const { rows, cols } = tableModel(t);
    expect(gridChars([['a'.repeat(5000), 'bc']])).toBe(1002);
    const grid = Array.from({ length: 100 }, () => Array.from({ length: 2 }, () => 'y'.repeat(1000)));
    expect(fillFromPatch(t, rows[0], cols[0], grid, ids)).toBeNull(); // 200,000
  });

  it('parseGrid reads no more than 1 MB', () => {
    const grid = parseGrid(`a\tb\n${'z'.repeat(2_000_000)}`);
    expect(grid[1][0].length).toBeLessThan(1_000_000);
  });
});

describe('table styling', () => {
  it('aligns a column and fills cells; both go with their column or row when it is removed', () => {
    const t = fresh(2, 2);
    const { rows, cols } = tableModel(t);
    apply(t, setAlignPatch(t, cols[1], 'right'));
    apply(t, setFillPatch(t, [rows[0], rows[1]], [cols[0]], '#FFE16B'));
    const m = tableModel(t);
    expect([m.align(cols[0]), m.align(cols[1]), m.fill(rows[1], cols[0]), m.fill(rows[0], cols[1])]).toEqual(['left', 'right', '#FFE16B', null]);
    apply(t, setAlignPatch(t, cols[1], 'left'));
    expect(`a:${cols[1]}` in t).toBe(false); // left is the default: no key
    apply(t, setFillPatch(t, [rows[0]], [cols[0]], null));
    expect(tableModel(t).fill(rows[0], cols[0])).toBeNull();
    apply(t, deleteRowPatch(t, rows[1]));
    expect(Object.keys(t).filter((k) => k.startsWith('f:'))).toEqual([]);
    expect(setAlignPatch(t, cols[0], 'justify')).toBeNull();
    expect(setAlignPatch(t, 'gone', 'right')).toBeNull();
    expect(setFillPatch(t, ['gone'], [cols[0]], '#fff')).toBeNull();
  });

  it('empties the cells of a range and leaves the others', () => {
    const t = tableFromGrid([['a', 'b'], ['c', 'd']], ids)!;
    const { rows, cols } = tableModel(t);
    apply(t, clearCellsPatch(t, [rows[0]], [cols[0], cols[1]]));
    expect(toTsv(t)).toBe('\t\nc\td');
    expect(clearCellsPatch(t, [rows[0]], [cols[0]])).toBeNull(); // nothing left to clear
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

describe('equal and odd ranks (concurrent inserts, hostile writes)', () => {
  const twins = () => {
    const t = fresh(3, 2) as Record<string, unknown>;
    const { rows, cols } = tableModel(t);
    t[`r:dup`] = t[`r:${rows[0]}`]; // two clients inserted after the same row
    t[`k:dup`] = t[`k:${cols[0]}`];
    return { t, rows, cols };
  };

  it('inserts and moves next to an equal-rank pair without throwing, and the new line lands in a sane place', () => {
    const { t, rows, cols } = twins();
    const order = tableModel(t).rows;
    expect(order).toHaveLength(4);
    for (let at = -1; at < order.length; at++) {
      const p = insertRowPatch(t, at, `n${at + 1}`);
      expect(p).not.toBeNull();
      const next = { ...t, ...p };
      expect(tableModel(next).rows).toHaveLength(5);
    }
    for (const id of order) for (let at = -1; at < 3; at++) expect(() => moveRowPatch(t, id, at)).not.toThrow();
    expect(() => insertColPatch(t, 0, 'ncol')).not.toThrow();
    for (const id of tableModel(t).cols) expect(() => moveColPatch(t, id, 0)).not.toThrow();
    expect(rows.length + cols.length).toBe(5);
  });

  it('accepts only base62 characters as a rank, and inserting next to a refused rank does not produce garbage', () => {
    for (const bad of ['a\0', 'a b', 'a:b', 'a‮', 'a￿', '', 'a-b']) expect(isValidRank(bad)).toBe(false);
    expect(isValidRank('a0')).toBe(true);
    const t = fresh(2, 1) as Record<string, unknown>;
    const { rows } = tableModel(t);
    t[`r:${rows[0]}`] = 'a￿';
    const p = insertRowPatch(t, 0, 'nx');
    expect(String(Object.values(p ?? {})[0])).toMatch(/^[0-9A-Za-z]+$/);
    expect(String(Object.values(p ?? {})[0])).not.toContain('undefined');
  });

  it('fillFromPatch is linear: a 500,000-row paste does not overflow the stack and is cut at the table limits', () => {
    const t = fresh(1, 1) as Record<string, unknown>;
    const { rows, cols } = tableModel(t);
    let n = 0;
    const grid = Array.from({ length: 500_000 }, () => ['']);
    const p = fillFromPatch(t, rows[0], cols[0], grid, () => `i${n++}`);
    expect(p).not.toBeNull();
    expect(n).toBeLessThanOrEqual(MAX_TABLE_ROWS);
  });
});
