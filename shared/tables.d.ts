// Types for shared/tables.mjs. The browser imports the module without an extension ('../shared/tables') so TypeScript finds this
// file; the server imports 'tables.mjs' directly.

/** A change to the fields of a table object: undefined deletes the key. */
export type TablePatch = Record<string, string | number | undefined>;
type Fields = Record<string, unknown>;

export const MAX_TABLE_ROWS: number;
export const MAX_TABLE_COLS: number;
export const MAX_CELL_CHARS: number;
export const MIN_COL_WIDTH: number;
export const MAX_COL_WIDTH: number;
export const DEFAULT_COL_WIDTH: number;
export const ID_RE: RegExp;
export const ALIGNS: readonly ['left', 'center', 'right'];
export type TableAlign = 'left' | 'center' | 'right';

export function rowKey(rowId: string): string;
export function colKey(colId: string): string;
export function widthKey(colId: string): string;
export function cellKey(rowId: string, colId: string): string;
export function alignKey(colId: string): string;
export function fillKey(rowId: string, colId: string): string;
export function isTableKey(key: unknown): boolean;
export function parseTableKey(key: unknown): { kind: 'r' | 'k' | 'w' | 'a'; id: string } | { kind: 'c' | 'f'; rowId: string; colId: string } | null;

export interface TableModel {
  rows: string[];
  cols: string[];
  rowRanks: Map<string, string>;
  colRanks: Map<string, string>;
  width(colId: string): number;
  cell(rowId: string, colId: string): string;
  align(colId: string): TableAlign;
  fill(rowId: string, colId: string): string | null;
}
export function tableModel(obj: Fields | undefined): TableModel;
export function newTableFields(rows: number, cols: number, newId: () => string): Record<string, string>;
export function insertRowPatch(obj: Fields, at: number, newId: string): TablePatch | null;
export function insertColPatch(obj: Fields, at: number, newId: string): TablePatch | null;
export function deleteRowPatch(obj: Fields, rowId: string): TablePatch | null;
export function deleteColPatch(obj: Fields, colId: string): TablePatch | null;
export function moveRowPatch(obj: Fields, rowId: string, to: number): TablePatch | null;
export function moveColPatch(obj: Fields, colId: string, to: number): TablePatch | null;
export function setCellPatch(obj: Fields, rowId: string, colId: string, text: string): TablePatch | null;
export function setWidthPatch(obj: Fields, colId: string, width: number): TablePatch | null;
export function setAlignPatch(obj: Fields, colId: string, align: string): TablePatch | null;
export function setFillPatch(obj: Fields, rowIds: readonly string[], colIds: readonly string[], color: string | null): TablePatch | null;
export function clearCellsPatch(obj: Fields, rowIds: readonly string[], colIds: readonly string[]): TablePatch | null;
export function parseGrid(text: string): string[][];
export function tableFromGrid(grid: string[][], newId: () => string): Record<string, string> | null;
export function fillFromPatch(obj: Fields, rowId: string, colId: string, grid: string[][], newId: () => string): TablePatch | null;
export function toTsv(obj: Fields): string;
export function toMarkdownTable(obj: Fields): string;
