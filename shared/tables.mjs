// The table model (docs/tables.md): a table object is one flat map whose keys name its parts, so two people editing different
// cells, or adding rows at the same time, merge without conflict (every key is its own last-writer-wins value in the shared
// document). Pure functions with no I/O and no DOM, imported by the browser (src/tables.ts) and by the MCP server
// (server/board-ops.mjs) and the validator (server/sync-validate.mjs), so all give the same answer. The Dockerfile copies this folder.
//
//   r:<rowId>            the row's rank (a fractional-indexing key; rows sort by it)
//   k:<colId>            the column's rank
//   w:<colId>            the column's width in world units (optional; the default applies without it)
//   c:<rowId>:<colId>    the cell's text (inline Markdown), absent when the cell is empty
//   a:<colId>            the column's text alignment: 'left' (the default), 'center' or 'right'
//   f:<rowId>:<colId>    the cell's fill colour (a colour the board can draw), absent for none
//
// Ids are stable and never positions, so inserting a row moves no cell key. A cell whose row or column is gone (a delete that
// raced with an edit) is simply not read. A new column or row is a new key, so a concurrent insert is never lost. TAB-186
// (typed columns, formulas) adds more per-column keys beside w:<colId>.

import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

export const MAX_TABLE_ROWS = 100;
export const MAX_TABLE_COLS = 30;
/** Characters in one cell. */
export const MAX_CELL_CHARS = 1000;
export const MIN_COL_WIDTH = 60;
export const MAX_COL_WIDTH = 800;
export const DEFAULT_COL_WIDTH = 160;

export const ID_RE = /^[a-z0-9]{1,12}$/;
const KEY_RE = /^(?:([rkwa]):([a-z0-9]{1,12})|([cf]):([a-z0-9]{1,12}):([a-z0-9]{1,12}))$/;
export const ALIGNS = Object.freeze(['left', 'center', 'right']);

export const rowKey = (rowId) => `r:${rowId}`;
export const colKey = (colId) => `k:${colId}`;
export const widthKey = (colId) => `w:${colId}`;
export const alignKey = (colId) => `a:${colId}`;
export const fillKey = (rowId, colId) => `f:${rowId}:${colId}`;
export const cellKey = (rowId, colId) => `c:${rowId}:${colId}`;

/** True for the key of a table part (row, column, width or cell). */
export const isTableKey = (key) => typeof key === 'string' && KEY_RE.test(key);

/** The kind of a table key: 'r', 'k', 'w' or 'a' with an id, or 'c' or 'f' with a row and a column id; null for any other key. */
export function parseTableKey(key) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null;
  if (!m) return null;
  return m[1] ? { kind: m[1], id: m[2] } : { kind: m[3], rowId: m[4], colId: m[5] };
}

const byRank = (a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * What a table object holds, in order. `rows` and `cols` are sorted by rank (ties by id, so every client agrees), `width(colId)`
 * is the stored width kept within bounds, and `cell(rowId, colId)` is the text ('' when empty or when the row or column is gone).
 */
export function tableModel(obj) {
  const rows = [];
  const cols = [];
  const widths = new Map();
  const cells = new Map();
  const aligns = new Map();
  const fills = new Map();
  for (const key of Object.keys(obj ?? {})) {
    const p = parseTableKey(key);
    if (!p) continue;
    const value = obj[key];
    if (p.kind === 'r' && typeof value === 'string') rows.push({ id: p.id, rank: value });
    else if (p.kind === 'k' && typeof value === 'string') cols.push({ id: p.id, rank: value });
    else if (p.kind === 'w' && typeof value === 'number' && Number.isFinite(value)) widths.set(p.id, Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, value)));
    else if (p.kind === 'c' && typeof value === 'string') cells.set(key, value);
    else if (p.kind === 'a' && ALIGNS.includes(value)) aligns.set(p.id, value);
    else if (p.kind === 'f' && typeof value === 'string' && value) fills.set(key, value);
  }
  rows.sort(byRank);
  cols.sort(byRank);
  const rowIds = new Set(rows.map((r) => r.id));
  const colIds = new Set(cols.map((c) => c.id));
  return {
    rows: rows.map((r) => r.id),
    cols: cols.map((c) => c.id),
    rowRanks: new Map(rows.map((r) => [r.id, r.rank])),
    colRanks: new Map(cols.map((c) => [c.id, c.rank])),
    width: (colId) => widths.get(colId) ?? DEFAULT_COL_WIDTH,
    cell: (rowId, colId) => (rowIds.has(rowId) && colIds.has(colId) ? cells.get(cellKey(rowId, colId)) ?? '' : ''),
    align: (colId) => aligns.get(colId) ?? 'left',
    fill: (rowId, colId) => (rowIds.has(rowId) && colIds.has(colId) ? fills.get(fillKey(rowId, colId)) ?? null : null),
  };
}

/** The fields of a new rows x cols table (ids from `newId`), cells empty. */
export function newTableFields(rows, cols, newId) {
  const r = Math.min(MAX_TABLE_ROWS, Math.max(1, Math.floor(rows)));
  const c = Math.min(MAX_TABLE_COLS, Math.max(1, Math.floor(cols)));
  const fields = {};
  const used = new Set();
  const fresh = () => { let id = newId(); while (used.has(id)) id = newId(); used.add(id); return id; };
  generateNKeysBetween(null, null, r).forEach((rank) => { fields[rowKey(fresh())] = rank; });
  generateNKeysBetween(null, null, c).forEach((rank) => { fields[colKey(fresh())] = rank; });
  return fields;
}

/** The rank for a new line placed after the one at index `at` (-1 puts it first), among the ranks in order. */
function rankAfter(ranks, at) {
  const before = at >= 0 ? ranks[at] ?? null : null;
  const after = at + 1 < ranks.length ? ranks[at + 1] : null;
  return generateKeyBetween(before, after);
}

const orderedRanks = (map, ids) => ids.map((id) => map.get(id));

/** The patch that adds a row with id `newId` after the row at index `at` (-1: first). Null at the row limit. */
export function insertRowPatch(obj, at, newId) {
  const m = tableModel(obj);
  if (m.rows.length >= MAX_TABLE_ROWS || !ID_RE.test(newId) || m.rowRanks.has(newId)) return null;
  return { [rowKey(newId)]: rankAfter(orderedRanks(m.rowRanks, m.rows), at) };
}

/** The patch that adds a column with id `newId` after the column at index `at` (-1: first). Null at the column limit. */
export function insertColPatch(obj, at, newId) {
  const m = tableModel(obj);
  if (m.cols.length >= MAX_TABLE_COLS || !ID_RE.test(newId) || m.colRanks.has(newId)) return null;
  return { [colKey(newId)]: rankAfter(orderedRanks(m.colRanks, m.cols), at) };
}

/** The patch that removes a row and its cells (undefined deletes a key). The last row is never removed. */
export function deleteRowPatch(obj, rowId) {
  const m = tableModel(obj);
  if (m.rows.length <= 1 || !m.rowRanks.has(rowId)) return null;
  const patch = { [rowKey(rowId)]: undefined };
  for (const key of Object.keys(obj)) {
    const p = parseTableKey(key);
    if ((p?.kind === 'c' || p?.kind === 'f') && p.rowId === rowId) patch[key] = undefined;
  }
  return patch;
}

/** The patch that removes a column, its width and its cells. The last column is never removed. */
export function deleteColPatch(obj, colId) {
  const m = tableModel(obj);
  if (m.cols.length <= 1 || !m.colRanks.has(colId)) return null;
  const patch = { [colKey(colId)]: undefined, [widthKey(colId)]: undefined, [alignKey(colId)]: undefined };
  for (const key of Object.keys(obj)) {
    const p = parseTableKey(key);
    if ((p?.kind === 'c' || p?.kind === 'f') && p.colId === colId) patch[key] = undefined;
  }
  return patch;
}

/** The patch that moves a row so it ends at index `to` of the order without it. */
export function moveRowPatch(obj, rowId, to) {
  const m = tableModel(obj);
  if (!m.rowRanks.has(rowId)) return null;
  const others = m.rows.filter((id) => id !== rowId);
  const at = Math.min(others.length, Math.max(0, to)) - 1;
  return { [rowKey(rowId)]: rankAfter(orderedRanks(m.rowRanks, others), at) };
}

/** The patch that moves a column so it ends at index `to` of the order without it. */
export function moveColPatch(obj, colId, to) {
  const m = tableModel(obj);
  if (!m.colRanks.has(colId)) return null;
  const others = m.cols.filter((id) => id !== colId);
  const at = Math.min(others.length, Math.max(0, to)) - 1;
  return { [colKey(colId)]: rankAfter(orderedRanks(m.colRanks, others), at) };
}

/** The patch that sets one cell; empty text removes the key. Null for a row or column the table does not have, or too long a text. */
export function setCellPatch(obj, rowId, colId, text) {
  const m = tableModel(obj);
  if (!m.rowRanks.has(rowId) || !m.colRanks.has(colId) || typeof text !== 'string') return null;
  const clean = text.replace(/\r\n?/g, '\n');
  if ([...clean].length > MAX_CELL_CHARS) return null;
  return { [cellKey(rowId, colId)]: clean === '' ? undefined : clean };
}

/** The patch that sets a column's width, kept within bounds. */
export function setWidthPatch(obj, colId, width) {
  const m = tableModel(obj);
  if (!m.colRanks.has(colId) || !Number.isFinite(width)) return null;
  return { [widthKey(colId)]: Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, width))) };
}

/** The patch that aligns a column's text: 'left' is the default and removes the key. */
export function setAlignPatch(obj, colId, align) {
  const m = tableModel(obj);
  if (!m.colRanks.has(colId) || !ALIGNS.includes(align)) return null;
  return { [alignKey(colId)]: align === 'left' ? undefined : align };
}

/** The patch that fills the cells `rowIds` x `colIds` with a colour; null or '' clears them. The colour is checked by the caller (the validator and the board's colour grammar). */
export function setFillPatch(obj, rowIds, colIds, color) {
  const m = tableModel(obj);
  const patch = {};
  for (const r of rowIds) {
    for (const c of colIds) {
      if (m.rowRanks.has(r) && m.colRanks.has(c)) patch[fillKey(r, c)] = color || undefined;
    }
  }
  return Object.keys(patch).length ? patch : null;
}

/** The patch that empties the text of the cells `rowIds` x `colIds`. */
export function clearCellsPatch(obj, rowIds, colIds) {
  const m = tableModel(obj);
  const patch = {};
  for (const r of rowIds) {
    for (const c of colIds) {
      if (m.cell(r, c) !== '') patch[cellKey(r, c)] = undefined;
    }
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * Text as a grid of cells: tab separated (a copy from a spreadsheet) or comma separated with quotes (a CSV file). A tab anywhere
 * in the first line decides TSV. Cells are trimmed of surrounding blank space; a trailing empty line is not a row.
 */
export function parseGrid(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];
  const firstLine = src.split('\n', 1)[0];
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows.map((r) => r.map((c) => c.trim()));
}

/** Fields for a table filled from a grid (a paste of a spreadsheet): sizes are capped, short rows are padded. Null for an empty grid. */
export function tableFromGrid(grid, newId) {
  if (!grid.length) return null;
  const rows = Math.min(MAX_TABLE_ROWS, grid.length);
  const cols = Math.min(MAX_TABLE_COLS, Math.max(1, ...grid.map((r) => r.length)));
  const fields = newTableFields(rows, cols, newId);
  const m = tableModel(fields);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const text = [...(grid[r][c] ?? '')].slice(0, MAX_CELL_CHARS).join('');
      if (text) fields[cellKey(m.rows[r], m.cols[c])] = text;
    }
  }
  return fields;
}

/** A pasted grid written into an existing table from the cell (rowId, colId) down and right; rows and columns beyond the table are added. */
export function fillFromPatch(obj, rowId, colId, grid, newId) {
  let model = tableModel(obj);
  let r0 = model.rows.indexOf(rowId);
  let c0 = model.cols.indexOf(colId);
  if (r0 < 0 || c0 < 0 || !grid.length) return null;
  const working = { ...obj };
  const patch = {};
  const apply = (p) => { Object.assign(patch, p); Object.assign(working, p); };
  const needRows = Math.min(MAX_TABLE_ROWS, r0 + grid.length);
  const needCols = Math.min(MAX_TABLE_COLS, c0 + Math.max(...grid.map((r) => r.length)));
  while (model.rows.length < needRows) { const p = insertRowPatch(working, model.rows.length - 1, newId()); if (!p) break; apply(p); model = tableModel(working); }
  while (model.cols.length < needCols) { const p = insertColPatch(working, model.cols.length - 1, newId()); if (!p) break; apply(p); model = tableModel(working); }
  for (let r = 0; r < grid.length && r0 + r < model.rows.length; r++) {
    for (let c = 0; c < grid[r].length && c0 + c < model.cols.length; c++) {
      const p = setCellPatch(working, model.rows[r0 + r], model.cols[c0 + c], grid[r][c]);
      if (p) apply(p);
    }
  }
  return patch;
}

/** The table as tab separated text, for a paste into a spreadsheet. A tab or line break in a cell becomes a space. */
export function toTsv(obj) {
  const m = tableModel(obj);
  return m.rows.map((r) => m.cols.map((c) => m.cell(r, c).replace(/[\t\n]+/g, ' ')).join('\t')).join('\n');
}

/** The table as a Markdown table (first row as the header), with `|` and line breaks in a cell made safe. Empty for no rows. */
export function toMarkdownTable(obj) {
  const m = tableModel(obj);
  if (!m.rows.length || !m.cols.length) return '';
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const line = (r) => `| ${m.cols.map((c) => esc(m.cell(r, c))).join(' | ')} |`;
  const [head, ...rest] = m.rows;
  return [line(head), `| ${m.cols.map(() => '---').join(' | ')} |`, ...rest.map(line)].join('\n');
}
