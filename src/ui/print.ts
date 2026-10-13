import './print.css';
import type { BoardApp } from '../app';
import type { Id } from '../types';
import { isBox } from '../types';
import { exportSvg, imageDataUrls } from '../exporters';
import { PAPER_MM, TITLE_MM, pageRule, planPages, sheetFor, type PlanInput, type PrintFrame, type PrintOrientation, type PrintPage, type PrintPaper, type PrintScope } from '../print-pages';
import { h } from './dom';
import { dialog, field, toast } from './common';

const ROOT_ID = 'print-root';
const STYLE_ID = 'print-page-rule';

/** What the board offers to print: the top-level frames, the selection and the whole board, each with its picture size. */
function planInput(app: BoardApp, scope: PrintScope): PlanInput {
  const shown = app.store.shown();
  const size = (ids?: Id[]) => {
    const b = app.r.contentBounds(ids ?? shown.map((o) => o.id));
    return { w: (b?.w ?? 100) + 80, h: (b?.h ?? 100) + 90 };
  };
  const frames: PrintFrame[] = shown
    .filter((o) => o.type === 'frame' && !o.parent)
    .map((o) => {
      const p = app.store.placed(o);
      return { id: o.id, name: isBox(o) ? o.name ?? '' : '', x: p.x ?? 0, y: p.y ?? 0, w: p.w ?? 0, h: p.h ?? 0 };
    });
  const ids = app.selection.filter((id) => app.store.get(id) && app.store.get(id)?.type !== 'connector');
  return {
    scope,
    boardTitle: app.store.getMeta().name || 'Board',
    boardSize: size(),
    selection: ids.length ? { ids, ...size(ids) } : null,
    frames,
  };
}

/**
 * Blurred shadows are the one thing a PDF cannot keep as vector: the browser turns each into a large bitmap. On paper they are
 * left out (the curl shadow, which is only a shadow, entirely), so every page stays vector and small.
 */
export function withoutShadows(svg: string): string {
  return svg
    .replace(/<path\b[^>]*\bfilter="url\(#sticky-curl-shadow\)"[^>]*\/>/g, '')
    .replace(/ filter="url\(#sticky-shadow\)"/g, '');
}

/** Removes a print left over from an earlier action. */
export function clearPrint(): void {
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}

export interface PrintOptions {
  scope: PrintScope;
  paper: PrintPaper;
  orientation: PrintOrientation;
  titles: boolean;
}

/**
 * Draws the pages into a print root and opens the browser's print dialog. The pages are the board's own vector pictures, so the
 * PDF the browser writes keeps text as text; the page fonts are the ones already loaded. The root is removed after printing.
 */
export async function printBoard(app: BoardApp, opts: PrintOptions): Promise<boolean> {
  const pages = planPages(planInput(app, opts.scope));
  if (!pages.length) {
    toast(opts.scope === 'frames' ? 'There are no frames to print.' : 'Select something to print first.');
    return false;
  }
  clearPrint();
  const images = await imageDataUrls(app, app.store.shown());
  const sheet = sheetFor(opts.paper, opts.orientation, pages);
  const root = h('div', { id: ROOT_ID, 'aria-hidden': 'true' });
  const titleH = opts.titles ? TITLE_MM : 0;
  // a hair shorter than the printable area, so rounding never pushes a page onto a second sheet
  const boxH = sheet.innerH - 0.6;
  root.style.setProperty('--print-title-h', `${titleH}mm`);
  for (const p of pages) {
    const { svg } = exportSvg(app, p.ids as Id[] | undefined, { images });
    const picture = h('div', { class: 'print-picture' });
    picture.innerHTML = withoutShadows(svg);
    const page = h('section', { class: 'print-page' }, opts.titles ? h('h2', { class: 'print-title' }, p.title) : null, picture);
    page.style.width = `${sheet.innerW}mm`;
    page.style.height = `${boxH}mm`;
    root.appendChild(page);
  }
  const rule = h('style', { id: STYLE_ID }, pageRule(opts.paper, sheet));
  document.head.appendChild(rule);
  document.body.appendChild(root);
  window.addEventListener('afterprint', clearPrint, { once: true });
  window.print();
  return true;
}

export type { PrintPage };

/** The Print / Save as PDF dialog: what to print, on which paper. */
export function openPrint(app: BoardApp): void {
  const hasSelection = planInput(app, 'selection').selection !== null;
  const frameCount = planInput(app, 'frames').frames.length;
  const scope = h('select', { class: 'input', 'aria-label': 'What to print' },
    h('option', { value: 'board' }, 'The whole board, on one page'),
    hasSelection ? h('option', { value: 'selection' }, 'The selection, on one page') : null,
    frameCount ? h('option', { value: 'frames' }, `Each frame on its own page (${frameCount})`) : null,
  );
  scope.value = hasSelection ? 'selection' : 'board';
  const paper = h('select', { class: 'input', 'aria-label': 'Paper' },
    ...(Object.keys(PAPER_MM) as PrintPaper[]).map((k) => h('option', { value: k }, PAPER_MM[k].label)));
  const orientation = h('select', { class: 'input', 'aria-label': 'Orientation' },
    h('option', { value: 'auto' }, 'Automatic'), h('option', { value: 'landscape' }, 'Landscape'), h('option', { value: 'portrait' }, 'Portrait'));
  const titles = h('input', { type: 'checkbox', checked: true });
  dialog('Print or save as PDF', h('div', { class: 'print-form' },
    field('What to print', scope),
    h('div', { class: 'print-field-row' }, field('Paper', paper), field('Orientation', orientation)),
    h('label', { class: 'check' }, titles, 'Show a title above each page'),
    h('p', { class: 'muted small print-note' }, 'The PDF goes through your browser’s print dialog. To get a file, choose “Save as PDF” as the destination there.'),
  ), [
    { label: 'Cancel' },
    {
      label: 'Continue', primary: true,
      onClick: () => {
        // let the dialog close first, so the print does not include it
        setTimeout(() => { void printBoard(app, { scope: scope.value as PrintScope, paper: paper.value as PrintPaper, orientation: orientation.value as PrintOrientation, titles: titles.checked }); }, 50);
      },
    },
  ]);
}
