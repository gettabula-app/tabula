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

export function rowKey(rowId: string): string;
export function colKey(colId: string): string;
export function widthKey(colId: string): string;
export function cellKey(rowId: string, colId: string): string;
export function isTableKey(key: unknown): boolean;
export function parseTableKey(key: unknown): { kind: 'r' | 'k' | 'w'; id: string } | { kind: 'c'; rowId: string; colId: string } | null;

export interface TableModel {
  rows: string[];
  cols: string[];
  rowRanks: Map<string, string>;
  colRanks: Map<string, string>;
  width(colId: string): number;
  cell(rowId: string, colId: string): string;
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
export function parseGrid(text: string): string[][];
export function tableFromGrid(grid: string[][], newId: () => string): Record<string, string> | null;
export function fillFromPatch(obj: Fields, rowId: string, colId: string, grid: string[][], newId: () => string): TablePatch | null;
export function toTsv(obj: Fields): string;
export function toMarkdownTable(obj: Fields): string;
