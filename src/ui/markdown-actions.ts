import { toast } from './common';
import { toMarkdownTable, toTsv } from '../../shared/tables';

/** "Copy as Markdown": the source of a Markdown block goes to the clipboard exactly as it is written (docs/markdown-blocks.md). */
export function copyMarkdownSource(source: string): void {
  navigator.clipboard.writeText(source).then(() => toast('Markdown copied to the clipboard'), () => toast('Clipboard is not available'));
}

/** "Copy as spreadsheet text" and "Copy as Markdown" for a table (docs/tables.md): tab-separated for Excel, Sheets and Numbers, or a Markdown table. */
export function copyTable(table: Record<string, unknown>, as: 'tsv' | 'markdown'): void {
  const text = as === 'tsv' ? toTsv(table) : toMarkdownTable(table);
  navigator.clipboard.writeText(text).then(() => toast(as === 'tsv' ? 'Table copied for a spreadsheet' : 'Table copied as Markdown'), () => toast('Clipboard is not available'));
}
