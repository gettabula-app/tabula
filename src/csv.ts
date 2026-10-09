// Cards as CSV (docs/kanban.md, Export and import): one row per card, RFC 4180, UTF-8 with a byte order mark so Excel
// reads it as UTF-8, `\r\n` line ends. Every cell is formula-safe: one that a spreadsheet would run as a formula gets a
// leading apostrophe, which spreadsheets show as plain text. Pure: the board comes in through a small reader.

import type { BaseObj, Id, Label } from './types';
import type { ContainerLayout } from '../shared/containers';

export const CSV_COLUMNS = [
  'container', 'lane', 'stage', 'position', 'title', 'description', 'owner', 'due', 'labels', 'comments', 'created_by', 'updated_at', 'id',
] as const;

/** The byte order mark the file starts with (docs/kanban.md: one format, for Excel). */
export const BOM = '﻿';

/** What a spreadsheet would read as a formula: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return. */
const FORMULA = /^[=+\-@\t\r]/;

/** One cell: the formula guard first (so quoting cannot undo it), then quoted when it holds a comma, a quote or a line break. */
export function csvCell(value: string | number | null | undefined): string {
  let v = value === null || value === undefined ? '' : String(value);
  if (FORMULA.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The whole file: the byte order mark, the header and the rows, each line ending in `\r\n`. */
export function csvText(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return BOM + [CSV_COLUMNS, ...rows].map((r) => `${r.map(csvCell).join(',')}\r\n`).join('');
}

/** What the CSV reads from a board. */
export interface CsvSource {
  get(id: Id): BaseObj | undefined;
  containerLayout(id: Id): ContainerLayout | null;
  labels: readonly Label[];
  commentCount(id: Id): number;
}

/** The rows of these kanbans' cards, kanban by kanban, lane by lane, top to bottom; `position` counts from 1 in its lane. */
export function cardRows(src: CsvSource, containers: readonly Id[]): (string | number)[][] {
  const names = new Map(src.labels.map((l) => [l.id, l.name]));
  const rows: (string | number)[][] = [];
  for (const cid of containers) {
    const c = src.get(cid);
    const layout = src.containerLayout(cid);
    if (c?.type !== 'container' || !layout) continue;
    for (const laneId of layout.lanes) {
      const lane = src.get(laneId);
      (layout.cards.get(laneId) ?? []).forEach((id, i) => {
        const card = src.get(id);
        if (card?.type !== 'card') return;
        const labels = (card.labels ?? []).map((l) => names.get(l)).filter((n): n is string => !!n);
        rows.push([
          c.name ?? '', lane?.name ?? '', lane?.stage ?? '', i + 1, card.text ?? '', card.desc ?? '', card.ownerName ?? '', card.due ?? '',
          labels.join('; '), src.commentCount(id), card.createdBy ?? '',
          Number.isFinite(card.updatedAt) ? new Date(card.updatedAt!).toISOString() : '', card.id,
        ]);
      });
    }
  }
  return rows;
}

/**
 * The file name: `<board>-<kanban>-cards.csv` for one kanban, `<board>-cards.csv` for several, with what is not safe in a
 * file name taken out (`safe`, the exporters' safeName).
 */
export function cardsCsvName(board: string, kanban: string | null, safe: (s: string) => string): string {
  return kanban === null ? `${safe(board)}-cards.csv` : `${safe(board)}-${safe(kanban || 'kanban')}-cards.csv`;
}
