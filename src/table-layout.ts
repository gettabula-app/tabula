// The table's layout (TAB-121, docs/tables.md): column widths from the model, row heights from the text in the cells, and every cell's drawing
// items (src/markdown-layout.ts, inline Markdown only), in the table's own coordinates with the top left at 0,0. Nothing here touches the DOM
// except the text measurer, so the canvas, the SVG, PNG and print exports and the height the app fits the object to all agree.

import { INLINE_LINE_HEIGHT, layoutInlineText, type MdItem, type MdStyle } from './markdown-layout';
import { MAX_CELL_CHARS, tableModel, type TableModel } from '../shared/tables';

export const TABLE_PAD_X = 10;
export const TABLE_PAD_Y = 7;

export interface TableCell {
  row: number;
  col: number;
  rowId: string;
  colId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TableLayout {
  model: TableModel;
  /** The width and height of the whole table. */
  w: number;
  h: number;
  /** Left edge of each column and top edge of each row, with the far edge as the last entry. */
  colX: number[];
  rowY: number[];
  cells: TableCell[];
  /** The drawing items: header tint, cell text, grid lines. */
  items: MdItem[];
  /** Cell fills (a colour as stored: the caller checks it before it is drawn), under everything else. */
  fills: { x: number; y: number; w: number; h: number; color: string; /** The cell's text, drawn in whichever ink reads on that colour. */ items: MdItem[] }[];
}

export interface TableFlags {
  headerRow?: boolean;
  headerCol?: boolean;
}

/** The smallest a row can be: one line of text and the padding. */
export const minRowHeight = (size: number) => Math.ceil(size * INLINE_LINE_HEIGHT + TABLE_PAD_Y * 2);

export function layoutTable(obj: Record<string, unknown> & TableFlags, style: MdStyle): TableLayout {
  const model = tableModel(obj);
  const colX = [0];
  for (const c of model.cols) colX.push(colX[colX.length - 1] + model.width(c));
  const header = (r: number, c: number) => (obj.headerRow === true && r === 0) || (obj.headerCol === true && c === 0);
  const laid = model.rows.map((rowId, r) => model.cols.map((colId, c) => {
    const text = [...model.cell(rowId, colId)].slice(0, MAX_CELL_CHARS).join('');
    return layoutInlineText(text, model.width(colId) - TABLE_PAD_X * 2, style, { weight: header(r, c) ? 700 : style.weight, align: model.align(colId) });
  }));
  const rowY = [0];
  laid.forEach((row) => rowY.push(rowY[rowY.length - 1] + Math.max(minRowHeight(style.size), Math.ceil(Math.max(...row.map((l) => l.height)) + TABLE_PAD_Y * 2))));
  const w = colX[colX.length - 1];
  const h = rowY[rowY.length - 1];
  const items: MdItem[] = [];
  const fills: TableLayout['fills'] = [];
  const cells: TableCell[] = [];
  model.rows.forEach((rowId, r) => model.cols.forEach((colId, c) => {
    const x = colX[c];
    const y = rowY[r];
    cells.push({ row: r, col: c, rowId, colId, x, y, w: colX[c + 1] - x, h: rowY[r + 1] - y });
    const fill = model.fill(rowId, colId);
    if (fill) fills.push({ x, y, w: colX[c + 1] - x, h: rowY[r + 1] - y, color: fill, items: [] });
    // a header cell is tinted in the text colour at low opacity, so every theme gets a matching quiet tone
    if (header(r, c)) items.push({ k: 'rect', x, y, w: colX[c + 1] - x, h: rowY[r + 1] - y, tone: 'code' });
  }));
  model.rows.forEach((rowId, r) => model.cols.forEach((colId, c) => {
    const filled = model.fill(rowId, colId) ? fills.find((f) => f.x === colX[c] && f.y === rowY[r]) : undefined;
    for (const it of laid[r][c].items) (filled ? filled.items : items).push(shift(it, colX[c] + TABLE_PAD_X, rowY[r] + TABLE_PAD_Y));
  }));
  for (let r = 0; r <= model.rows.length; r++) items.push({ k: 'line', x1: 0, y1: rowY[r], x2: w, y2: rowY[r], tone: r === 1 && obj.headerRow === true ? 'rule' : 'table' });
  for (let c = 0; c <= model.cols.length; c++) items.push({ k: 'line', x1: colX[c], y1: 0, x2: colX[c], y2: h, tone: c === 1 && obj.headerCol === true ? 'rule' : 'table' });
  return { model, w, h, colX, rowY, cells, items, fills };
}

function shift(it: MdItem, dx: number, dy: number): MdItem {
  if (it.k === 'line') return { ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy };
  return { ...it, x: it.x + dx, y: it.y + dy };
}

/** The cell under a point in the table's own coordinates (top left at 0,0); null outside the grid. */
export function cellAt(layout: TableLayout, x: number, y: number): TableCell | null {
  if (x < 0 || y < 0 || x >= layout.w || y >= layout.h) return null;
  return layout.cells.find((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) ?? null;
}
