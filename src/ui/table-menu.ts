// The table entries of the right-click menu (TAB-121, docs/tables.md): what applies to the selected cells, above the object's own entries.
import type { BoardApp } from '../app';
import { h, icon } from './dom';
import { STICKY_COLORS } from '../palette';
import { copyTable } from './markdown-actions';
import { ALIGNS } from '../../shared/tables';

type Run = () => void;

/** Menu children for a table with cells selected; empty when none are. `close` shuts the menu before an entry runs. */
export function tableMenuChildren(app: BoardApp, close: () => void): (HTMLElement | null)[] {
  const t = app.tables;
  const table = t.table;
  if (!table) return [];
  const item = (label: string, run: Run, extra: { danger?: boolean } = {}) =>
    h('button', { class: `menu-item${extra.danger ? ' danger' : ''}`, role: 'menuitem', onclick: () => { close(); run(); } }, h('span', null, label));
  const swatch = (name: string, color: string | null) => h('button', {
    class: 'table-swatch', role: 'menuitem', 'aria-label': color ? `Fill ${name}` : 'No fill', 'data-tip': color ? name : 'No fill',
    style: color ? `background:${color}` : '', onclick: () => { close(); t.fill(color); },
  }, color ? null : icon('close', 14));
  const header = (which: 'headerRow' | 'headerCol', label: string) => item(`${table[which] === true ? 'Turn off' : 'Turn on'} ${label}`, () => t.toggleHeader(which));
  const alignLabel = { left: 'Align left', center: 'Align centre', right: 'Align right' } as const;
  return [
    h('div', { class: 'list-label' }, 'Table'),
    item('Insert row above', () => t.insertRow(true)),
    item('Insert row below', () => t.insertRow(false)),
    item('Insert column left', () => t.insertCol(true)),
    item('Insert column right', () => t.insertCol(false)),
    item('Move row up', () => t.moveRow(-1)),
    item('Move row down', () => t.moveRow(1)),
    item('Move column left', () => t.moveCol(-1)),
    item('Move column right', () => t.moveCol(1)),
    item('Delete row', () => t.deleteRows(), { danger: true }),
    item('Delete column', () => t.deleteCols(), { danger: true }),
    h('hr', { class: 'menu-sep', role: 'separator' }),
    header('headerRow', 'header row'),
    header('headerCol', 'header column'),
    ...ALIGNS.map((a) => item(alignLabel[a], () => t.align(a))),
    h('div', { class: 'table-swatches', role: 'group', 'aria-label': 'Cell fill' }, swatch('No fill', null), ...STICKY_COLORS.map((c) => swatch(c.name, c.fill))),
    item('Clear cells', () => t.clearCells()),
    item('Copy for a spreadsheet', () => copyTable(table as unknown as Record<string, unknown>, 'tsv')),
    item('Copy as Markdown', () => copyTable(table as unknown as Record<string, unknown>, 'markdown')),
    h('hr', { class: 'menu-sep', role: 'separator' }),
  ];
}
