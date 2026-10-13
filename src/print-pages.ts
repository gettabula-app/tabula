/**
 * Print / Save as PDF (docs/print.md): which pages a print makes and how big the paper is. Pure: it works on plain boxes, so it
 * is tested without a browser. The page contents are the board's own SVG pictures (src/exporters.ts), drawn by src/ui/print.ts.
 */
import { readingOrder, type NavItem } from './canvas-nav';

export type PrintScope = 'board' | 'selection' | 'frames';
export type PrintPaper = 'a4' | 'letter';
export type PrintOrientation = 'auto' | 'portrait' | 'landscape';

/** A top-level frame as the planner sees it. */
export interface PrintFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PrintPage {
  /** The objects the page shows, with their children; undefined for the whole board. */
  ids: string[] | undefined;
  /** The page heading when titles are on. */
  title: string;
  /** The size of the picture in world units, for choosing the paper orientation. */
  w: number;
  h: number;
}

/** Paper sizes in millimetres, portrait. */
export const PAPER_MM: Record<PrintPaper, { w: number; h: number; label: string; css: string }> = {
  a4: { w: 210, h: 297, label: 'A4', css: 'A4' },
  letter: { w: 215.9, h: 279.4, label: 'Letter', css: 'letter' },
};

export const PAGE_MARGIN_MM = 12;
/** Room for the heading above a picture. */
export const TITLE_MM = 10;

/** The frames in the order they print: rows from top to bottom, left to right in a row (the canvas reading order). */
export function framesInOrder(frames: readonly PrintFrame[]): PrintFrame[] {
  const items: NavItem[] = frames.map((f) => ({ id: f.id, cx: f.x + f.w / 2, cy: f.y + f.h / 2, w: f.w, h: f.h, parent: null }));
  const byId = new Map(frames.map((f) => [f.id, f]));
  return readingOrder(items).map((e) => byId.get(e.id)!).filter(Boolean);
}

export interface PlanInput {
  scope: PrintScope;
  boardTitle: string;
  /** The picture size of the whole board and of the selection. */
  boardSize: { w: number; h: number };
  selection: { ids: string[]; w: number; h: number } | null;
  /** Top-level frames, with the size of the picture each one makes. */
  frames: readonly PrintFrame[];
}

/** The pages for a scope. Frames that are empty or zero-sized are skipped; no frames, or no selection, is no pages. */
export function planPages(input: PlanInput): PrintPage[] {
  if (input.scope === 'board') return [{ ids: undefined, title: input.boardTitle, w: input.boardSize.w, h: input.boardSize.h }];
  if (input.scope === 'selection') {
    const s = input.selection;
    return s && s.ids.length ? [{ ids: s.ids, title: input.boardTitle, w: s.w, h: s.h }] : [];
  }
  return framesInOrder(input.frames)
    .filter((f) => f.w > 0 && f.h > 0)
    .map((f, i) => ({ ids: [f.id], title: f.name.trim() || `Frame ${i + 1}`, w: f.w, h: f.h }));
}

/** Landscape when most pages are wider than tall (a tie goes to landscape, the shape of a board). */
export function autoOrientation(pages: readonly Pick<PrintPage, 'w' | 'h'>[]): 'portrait' | 'landscape' {
  const wide = pages.filter((p) => p.w >= p.h).length;
  return wide * 2 >= pages.length ? 'landscape' : 'portrait';
}

export interface Sheet {
  orientation: 'portrait' | 'landscape';
  /** The paper in millimetres, after the orientation. */
  w: number;
  h: number;
  /** The area inside the margins. */
  innerW: number;
  innerH: number;
}

export function sheetFor(paper: PrintPaper, orientation: PrintOrientation, pages: readonly Pick<PrintPage, 'w' | 'h'>[]): Sheet {
  const o = orientation === 'auto' ? autoOrientation(pages) : orientation;
  const p = PAPER_MM[paper];
  const w = o === 'landscape' ? p.h : p.w;
  const h = o === 'landscape' ? p.w : p.h;
  return { orientation: o, w, h, innerW: w - PAGE_MARGIN_MM * 2, innerH: h - PAGE_MARGIN_MM * 2 };
}

/** The `@page` rule: the paper and its orientation, with the margin the page boxes are laid out inside. */
export function pageRule(paper: PrintPaper, sheet: Sheet): string {
  return `@page { size: ${PAPER_MM[paper].css} ${sheet.orientation}; margin: ${PAGE_MARGIN_MM}mm; }`;
}
