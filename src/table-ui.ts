// What a person does to a table beyond typing in a cell (TAB-121, docs/tables.md): selecting cells (a click on a selected table, Shift to extend, the arrow
// keys and Tab to move), the row and column operations, headers, alignment and fills, clearing, copy and paste, and dragging a column border to resize it.
// The model (shared/tables.mjs) turns each into a patch of the table object's keys; this writes it as one undo step and fits the table to its new size.

import type { BoardApp } from './app';
import type { Id, Obj } from './types';
import type { TableSelection } from './markup';
import { tableStyle } from './markup';
import type { BaseObj } from './types';
import { cellAt, layoutTable, type TableLayout } from './table-layout';
import {
  MAX_TABLE_CHARS, clearCellsPatch, deleteColPatch, deleteRowPatch, fillFromPatch, insertColPatch, insertRowPatch, moveColPatch, moveRowPatch,
  setAlignPatch, setFillPatch, setWidthPatch, toMarkdownTable, toTsv, parseGrid, type TableAlign, type TablePatch,
} from '../shared/tables';

/** A fresh row or column id: six characters of a-z and 0-9, the shape the model accepts. */
export const newTableId = (): string => Math.random().toString(36).slice(2, 8).padEnd(6, '0');

/** How close to a column border (screen px) a press grabs it. */
const GRAB = 6;

type Fields = Record<string, unknown>;
const fieldsOf = (o: Obj) => o as unknown as Fields;

export interface CellRange { id: Id; r0: number; c0: number; r1: number; c1: number; /** The anchor cell, where Shift and the arrows start from. */ ar: number; ac: number }

export class TableController {
  sel: CellRange | null = null;

  constructor(private app: BoardApp) {}

  /** The selected table, when one cell range is selected on the one selected table. */
  get table(): BaseObj | null {
    const s = this.sel;
    if (!s || this.app.selection.length !== 1 || this.app.selection[0] !== s.id) return null;
    const o = this.app.store.getPlaced(s.id);
    return o?.type === 'table' ? (o as BaseObj) : null;
  }

  get active(): boolean {
    return this.table !== null;
  }

  private layoutOf(o: BaseObj): TableLayout {
    return layoutTable(fieldsOf(o), tableStyle(o));
  }

  /** The range, with indexes clamped to the table as it is now (rows and columns can go while it is selected). */
  private range(): { o: BaseObj; layout: TableLayout; r0: number; r1: number; c0: number; c1: number } | null {
    const o = this.table;
    if (!o || !this.sel) return null;
    const layout = this.layoutOf(o);
    const lastR = layout.model.rows.length - 1, lastC = layout.model.cols.length - 1;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const { r0, r1, c0, c1 } = this.sel;
    return { o, layout, r0: clamp(Math.min(r0, r1), lastR), r1: clamp(Math.max(r0, r1), lastR), c0: clamp(Math.min(c0, c1), lastC), c1: clamp(Math.max(c0, c1), lastC) };
  }

  private show() {
    const s = this.sel;
    this.app.r.setTableSelection(s ? ({ id: s.id, r0: s.r0, c0: s.c0, r1: s.r1, c1: s.c1 } satisfies TableSelection) : null);
    this.app.emit('selection');
  }

  clear() {
    if (!this.sel) return;
    this.sel = null;
    this.show();
  }

  /** The selection of objects changed: the cell selection stays only while its table is the one selected object. */
  selectionChanged() {
    if (this.sel && !(this.app.selection.length === 1 && this.app.selection[0] === this.sel.id)) this.clear();
  }

  /** Selects the cell at (row, col); with `extend` the range runs from the anchor to it. */
  select(id: Id, row: number, col: number, extend = false) {
    const keep = extend && this.sel?.id === id;
    const ar = keep ? this.sel!.ar : row;
    const ac = keep ? this.sel!.ac : col;
    this.sel = { id, ar, ac, r0: Math.min(ar, row), r1: Math.max(ar, row), c0: Math.min(ac, col), c1: Math.max(ac, col) };
    this.show();
  }

  /** A right click at the pointer: selects the cell under it unless it is inside the range already selected. */
  selectUnderPointer(hit: Obj, e: { clientX: number; clientY: number }) {
    const o = this.app.store.getPlaced(hit.id) as BaseObj | undefined;
    if (!o || this.app.selection.length !== 1 || this.app.selection[0] !== o.id) return;
    const p = this.app.r.clientToWorld(e.clientX, e.clientY);
    const cell = cellAt(this.layoutOf(o), p.x - o.x, p.y - o.y);
    if (!cell) return;
    const s = this.sel;
    const inside = s?.id === o.id && cell.row >= Math.min(s.r0, s.r1) && cell.row <= Math.max(s.r0, s.r1) && cell.col >= Math.min(s.c0, s.c1) && cell.col <= Math.max(s.c0, s.c1);
    if (!inside) this.select(o.id, cell.row, cell.col);
  }

  /** A press on a table (docs/tables.md): on a column border of the selected table it starts resizing the column and returns true; otherwise it selects the cell under it (Shift extends). */
  pointerDown(e: PointerEvent, hit: Obj | null): boolean {
    if (!hit || hit.type !== 'table' || hit.locked || this.app.selection.length !== 1 || this.app.selection[0] !== hit.id) return false;
    const o = this.app.store.getPlaced(hit.id) as BaseObj | undefined;
    if (!o) return false;
    const p = this.app.r.clientToWorld(e.clientX, e.clientY);
    const layout = this.layoutOf(o);
    const edge = this.borderAt(layout, o, p.x - o.x, p.y - o.y);
    if (edge !== null) {
      this.startResize(e, o, edge);
      return true;
    }
    const cell = cellAt(layout, p.x - o.x, p.y - o.y);
    if (!cell) return false;
    this.select(o.id, cell.row, cell.col, e.shiftKey);
    return e.shiftKey; // a Shift press extends the range and nothing else; a plain press may still start moving the table
  }

  /** The index of the column whose right border is at x (table coordinates), within a few screen pixels; null elsewhere. */
  private borderAt(layout: TableLayout, o: BaseObj, x: number, y: number): number | null {
    const tolerance = GRAB / this.app.zoom;
    if (y < 0 || y > layout.h || (o.rotation ?? 0) !== 0) return null;
    for (let c = 0; c < layout.model.cols.length; c++) if (Math.abs(x - layout.colX[c + 1]) <= tolerance) return c;
    return null;
  }

  /** Whether a world point is on a column border of the selected table, where a press starts resizing the column (the pointer shows it). */
  overBorder(p: { x: number; y: number }, hit: Obj): boolean {
    if (this.app.selection.length !== 1 || this.app.selection[0] !== hit.id || hit.locked) return false;
    const o = this.app.store.getPlaced(hit.id) as BaseObj | undefined;
    if (!o || o.type !== 'table') return false;
    return this.borderAt(this.layoutOf(o), o, p.x - o.x, p.y - o.y) !== null;
  }

  private startResize(e: PointerEvent, o: BaseObj, col: number) {
    const svg = this.app.r.svg;
    const id = o.id;
    const colId = this.layoutOf(o).model.cols[col];
    const startX = this.app.r.clientToWorld(e.clientX, e.clientY).x;
    const startW = this.layoutOf(o).model.width(colId);
    svg.setPointerCapture(e.pointerId);
    this.app.store.undo.stopCapturing();
    const move = (m: PointerEvent) => {
      const now = this.app.store.get(id);
      if (!now) return;
      const w = this.app.r.clientToWorld(m.clientX, m.clientY).x - startX + startW;
      const patch = setWidthPatch(fieldsOf(now), colId, w);
      if (patch) this.write(id, patch, false);
    };
    const done = () => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', done);
      svg.removeEventListener('pointercancel', done);
      this.app.store.undo.stopCapturing();
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', done);
    svg.addEventListener('pointercancel', done);
  }

  /** Writes a patch to the table as one step, then fits the table to its new size. */
  /** A patch from the model, or null when it throws (a rank the model cannot place between): the table is then left as it was. */
  private patchOf(make: () => TablePatch | null): TablePatch | null {
    try {
      return make();
    } catch {
      return null;
    }
  }

  private write(id: Id, patch: TablePatch | null, step = true): boolean {
    if (!patch || this.app.readOnly) return false;
    const s = this.app.store;
    if (step) s.undo.stopCapturing();
    s.transact(() => s.update(id, patch as never));
    this.app.fitTable(id);
    if (step) s.undo.stopCapturing();
    return true;
  }

  // ---------------------------------------------------------------- keys

  /** A key on a table with cells selected; true when it was used. */
  key(e: KeyboardEvent, k: string): boolean {
    const r = this.range();
    if (!r || e.altKey || e.ctrlKey || e.metaKey) return false;
    const { rows, cols } = r.layout.model;
    const s = this.sel!;
    if (k === 'escape') { this.clear(); return true; }
    if (k === 'enter' && !this.app.readOnly) {
      this.app.editor.startCell(r.o.id, rows[s.ar] ?? rows[r.r0], cols[s.ac] ?? cols[r.c0]);
      return true;
    }
    if ((k === 'delete' || k === 'backspace') && !this.app.readOnly) return this.clearCells();
    const dr = k === 'arrowdown' ? 1 : k === 'arrowup' ? -1 : 0;
    const dc = k === 'arrowright' ? 1 : k === 'arrowleft' ? -1 : 0;
    if (dr || dc || k === 'tab') {
      // Tab and Shift+Tab walk the cells in reading order; the arrows move one cell, with Shift growing the range from the anchor
      let row = s.ar, col = s.ac;
      if (k === 'tab') {
        const at = Math.max(0, Math.min(rows.length * cols.length - 1, row * cols.length + col + (e.shiftKey ? -1 : 1)));
        row = Math.floor(at / cols.length);
        col = at % cols.length;
        this.select(r.o.id, row, col);
        return true;
      }
      const edge = e.shiftKey ? { row: s.r1 === s.ar ? s.r0 : s.r1, col: s.c1 === s.ac ? s.c0 : s.c1 } : { row: s.ar, col: s.ac };
      const row2 = Math.max(0, Math.min(rows.length - 1, edge.row + dr));
      const col2 = Math.max(0, Math.min(cols.length - 1, edge.col + dc));
      if (e.shiftKey) this.select(r.o.id, row2, col2, true);
      else this.select(r.o.id, row2, col2);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- operations on the selected cells

  private ids(r: NonNullable<ReturnType<TableController['range']>>) {
    const { rows, cols } = r.layout.model;
    return { rows: rows.slice(r.r0, r.r1 + 1), cols: cols.slice(r.c0, r.c1 + 1) };
  }

  /** Adds a row above or below the selected cells and selects its first cell. */
  insertRow(above: boolean) {
    const r = this.range();
    if (!r) return;
    const id = newTableId();
    const at = above ? r.r0 - 1 : r.r1;
    if (this.write(r.o.id, this.patchOf(() => insertRowPatch(fieldsOf(r.o), at, id)))) {
      const now = this.layoutOf(this.app.store.getPlaced(r.o.id) as BaseObj);
      this.select(r.o.id, now.model.rows.indexOf(id), r.c0);
    } else this.app.notify('A table has up to 100 rows.');
  }

  insertCol(left: boolean) {
    const r = this.range();
    if (!r) return;
    const id = newTableId();
    const at = left ? r.c0 - 1 : r.c1;
    if (this.write(r.o.id, this.patchOf(() => insertColPatch(fieldsOf(r.o), at, id)))) {
      const now = this.layoutOf(this.app.store.getPlaced(r.o.id) as BaseObj);
      this.select(r.o.id, r.r0, now.model.cols.indexOf(id));
    } else this.app.notify('A table has up to 30 columns.');
  }

  /** Removes the selected rows (never all of them). */
  deleteRows() {
    const r = this.range();
    if (!r) return;
    const patch: TablePatch = {};
    let work: Fields = { ...fieldsOf(r.o) };
    for (const id of this.ids(r).rows) {
      const p = deleteRowPatch(work, id);
      if (!p) break;
      Object.assign(patch, p);
      work = { ...work };
      for (const [k, v] of Object.entries(p)) if (v === undefined) delete work[k];
    }
    if (!this.write(r.o.id, Object.keys(patch).length ? patch : null)) return;
    const rows = this.layoutOf(this.app.store.getPlaced(r.o.id) as BaseObj).model.rows.length;
    this.select(r.o.id, Math.min(r.r0, rows - 1), r.c0);
  }

  deleteCols() {
    const r = this.range();
    if (!r) return;
    const patch: TablePatch = {};
    let work: Fields = { ...fieldsOf(r.o) };
    for (const id of this.ids(r).cols) {
      const p = deleteColPatch(work, id);
      if (!p) break;
      Object.assign(patch, p);
      work = { ...work };
      for (const [k, v] of Object.entries(p)) if (v === undefined) delete work[k];
    }
    if (!this.write(r.o.id, Object.keys(patch).length ? patch : null)) return;
    const cols = this.layoutOf(this.app.store.getPlaced(r.o.id) as BaseObj).model.cols.length;
    this.select(r.o.id, r.r0, Math.min(r.c0, cols - 1));
  }

  /** Moves the row of the anchor cell one place up or down. */
  moveRow(step: -1 | 1) {
    const r = this.range();
    if (!r || !this.sel) return;
    const index = this.sel.ar;
    const to = index + step;
    if (to < 0 || to >= r.layout.model.rows.length) return;
    if (this.write(r.o.id, this.patchOf(() => moveRowPatch(fieldsOf(r.o), r.layout.model.rows[index], to)))) this.select(r.o.id, to, this.sel.ac);
  }

  moveCol(step: -1 | 1) {
    const r = this.range();
    if (!r || !this.sel) return;
    const index = this.sel.ac;
    const to = index + step;
    if (to < 0 || to >= r.layout.model.cols.length) return;
    if (this.write(r.o.id, this.patchOf(() => moveColPatch(fieldsOf(r.o), r.layout.model.cols[index], to)))) this.select(r.o.id, this.sel.ar, to);
  }

  /** Turns the first row or the first column into a header (bold, tinted, ruled off). */
  toggleHeader(which: 'headerRow' | 'headerCol') {
    const r = this.range();
    if (!r) return;
    this.write(r.o.id, { [which]: r.o[which] === true ? undefined : true } as unknown as TablePatch);
  }

  /** Aligns the text of every selected column. */
  align(to: TableAlign) {
    const r = this.range();
    if (!r) return;
    const patch: TablePatch = {};
    for (const col of this.ids(r).cols) Object.assign(patch, setAlignPatch(fieldsOf(r.o), col, to) ?? {});
    this.write(r.o.id, Object.keys(patch).length ? patch : null);
  }

  /** Fills the selected cells with a colour, or clears the fill with null. */
  fill(color: string | null) {
    const r = this.range();
    if (!r) return;
    const { rows, cols } = this.ids(r);
    this.write(r.o.id, setFillPatch(fieldsOf(r.o), rows, cols, color));
  }

  /** Empties the selected cells; false when they are all empty already. */
  clearCells(): boolean {
    const r = this.range();
    if (!r) return false;
    const { rows, cols } = this.ids(r);
    return this.write(r.o.id, clearCellsPatch(fieldsOf(r.o), rows, cols));
  }

  // ---------------------------------------------------------------- clipboard

  private rangeObject(): Fields | null {
    const r = this.range();
    if (!r) return null;
    // a table holding only the selected cells, so the table text writers (TSV, Markdown) serve a range as they serve a table
    const { rows, cols } = r.layout.model;
    const out: Fields = {};
    const keep = new Set<string>();
    rows.slice(r.r0, r.r1 + 1).forEach((id) => keep.add(id));
    const colsKept = new Set(cols.slice(r.c0, r.c1 + 1));
    for (const [k, v] of Object.entries(fieldsOf(r.o))) {
      const m = /^(?:([rkwa]):([a-z0-9]+)|([cf]):([a-z0-9]+):([a-z0-9]+))$/.exec(k);
      if (!m) continue;
      if (m[1] === 'r' ? keep.has(m[2]) : m[1] === 'k' || m[1] === 'w' || m[1] === 'a' ? colsKept.has(m[2]) : keep.has(m[4]) && colsKept.has(m[5])) out[k] = v;
    }
    return out;
  }

  /** Cmd/Ctrl+C with cells selected: the cells as tab separated text, for a spreadsheet; false when no cells are selected. */
  copy(): boolean {
    const part = this.rangeObject();
    if (!part) return false;
    void navigator.clipboard?.writeText(toTsv(part)).catch(() => undefined);
    this.app.announce('Cells copied');
    return true;
  }

  copyMarkdown() {
    const part = this.rangeObject();
    if (part) void navigator.clipboard?.writeText(toMarkdownTable(part)).catch(() => undefined);
  }

  /** A paste of tab separated text with cells selected: written from the anchor cell down and right, adding the rows and columns it needs. */
  paste(text: string): boolean {
    const r = this.range();
    if (!r || !this.sel || this.app.readOnly) return false;
    const grid = parseGrid(text);
    if (!grid.length || !text.includes('\t')) return false;
    const { rows, cols } = r.layout.model;
    const row = rows[this.sel.ar] ?? rows[r.r0];
    const col = cols[this.sel.ac] ?? cols[r.c0];
    const patch = fillFromPatch(fieldsOf(r.o), row, col, grid, newTableId);
    if (!patch) this.app.notify(`That is too much text for one table (up to ${MAX_TABLE_CHARS.toLocaleString('en-US')} characters).`);
    else this.write(r.o.id, patch);
    return true;
  }
}

