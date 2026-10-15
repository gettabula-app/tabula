// TAB-375 slice 2: the sections of the Boards home (spec 14, sections 3 and 7): one section per team, Personal and Shared with you, each
// a grid of cards or the list rows, a dashed New board tile at the end of a team grid, and an empty state. The toolbar holds the
// Cards | List switch and the Show previews switch; both are remembered per device (try/catch: blocked storage keeps the default).
import { segmented } from './common';
import { h, icon } from './dom';
import { switchRow } from './controls';
import { boardCard, boardRow, type BoardAction, type BoardCardData, type BoardCardOpts, type MoveTarget } from './board-card';
import type { PreviewStyle } from './board-preview';

export type BoardView = 'cards' | 'list';
export const BOARDS_VIEW_KEY = 'tabula.boards.view';
export const BOARDS_PREVIEWS_KEY = 'tabula.boards.previews';

export function loadView(): BoardView {
  try {
    return localStorage.getItem(BOARDS_VIEW_KEY) === 'list' ? 'list' : 'cards';
  } catch {
    return 'cards';
  }
}

export function saveView(view: BoardView): void {
  try {
    localStorage.setItem(BOARDS_VIEW_KEY, view);
  } catch {
    // storage is blocked: the choice lasts for this visit only
  }
}

/** Previews are on unless the person switched them off on this device. */
export function loadPreviews(): boolean {
  try {
    return localStorage.getItem(BOARDS_PREVIEWS_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function savePreviews(on: boolean): void {
  try {
    localStorage.setItem(BOARDS_PREVIEWS_KEY, on ? 'on' : 'off');
  } catch {
    // storage is blocked: the switch lasts for this visit only
  }
}

export interface BoardsToolbarOpts {
  view: BoardView;
  previews: boolean;
  onView: (view: BoardView) => void;
  onPreviews: (on: boolean) => void;
}

/** The Cards | List switch and the Show previews switch, in one row. Each choice is saved as it is made. */
export function boardsToolbar(opts: BoardsToolbarOpts): HTMLElement {
  return h('div', { class: 'bc-toolbar' },
    segmented<BoardView>([{ value: 'cards', label: 'Cards' }, { value: 'list', label: 'List' }], opts.view, (view) => {
      saveView(view);
      opts.onView(view);
    }, 'View'),
    switchRow('Show previews', opts.previews, (on) => {
      savePreviews(on);
      opts.onPreviews(on);
    }));
}

export interface BoardSection {
  id: string;
  title: string;
  kind: 'team' | 'personal' | 'shared' | 'device';
  /** A team's id, or null for Personal: where a card dropped on this section (or moved to it) goes. Undefined: no drops here. */
  teamId?: string | null;
  /** The person is in this team, so it gets New board (the head button and the dashed tile). Personal always does. */
  canAdd?: boolean;
  /** Text of the head's badge, such as "Admin" or "Member". */
  badge?: string;
  /** The demo's shorthand for badge "Admin". */
  admin?: boolean;
  /** Extra head actions (such as Manage), before New board. */
  actions?: (HTMLElement | null)[];
  boards: BoardCardData[];
}

export interface BoardSectionsOpts {
  view: BoardView;
  tile: PreviewStyle;
  previews: boolean;
  teams?: { id: string; name: string }[];
  /** Offline: every New board button and tile is disabled. */
  down?: boolean;
  /** The menu actions the page offers (see BoardCardOpts.actions). */
  actions?: BoardAction[];
  onNew?: (section: BoardSection) => void;
  onAction?: (action: BoardAction, data: BoardCardData) => void;
  /** Moves a board to a target: from the menu, or by dropping it on a section the board may go to. */
  onMove?: (to: MoveTarget, data: BoardCardData) => void;
  onAdd?: (to: MoveTarget, data: BoardCardData) => void;
}

/** What a drop of `data` on `section` is: the board is already there (nothing happens), allowed, or refused (not allowed). */
export function dropVerdict(section: Pick<BoardSection, 'teamId' | 'boards'>, data: BoardCardData): 'same' | 'allowed' | 'refused' {
  if (section.boards.some((b) => b.id === data.id)) return 'same';
  if (section.teamId === undefined) return 'refused';
  return data.targets?.some((t) => t.id === section.teamId) ? 'allowed' : 'refused';
}

const countText = (n: number) => `${n} ${n === 1 ? 'board' : 'boards'}`;
/** Sections that take New board: Personal, and a team the person is in. */
const addable = (section: BoardSection) => section.kind === 'personal' || (section.kind === 'team' && section.canAdd === true);

function newButton(section: BoardSection, opts: BoardSectionsOpts, primary = false): HTMLButtonElement {
  return h('button', { class: primary ? 'btn sm primary' : 'btn sm', type: 'button', disabled: opts.down === true, onclick: () => opts.onNew?.(section) }, 'New board');
}

function emptyItem(section: BoardSection, opts: BoardSectionsOpts): HTMLLIElement {
  const shared = section.kind === 'shared';
  const text = shared ? 'No boards shared with you yet.' : `No boards in ${section.title} yet.`;
  const lead = section.kind === 'team' && section.canAdd ? ' Boards you make here are shared with the team.' : '';
  return h('li', { class: 'bc-empty' },
    h('span', null, h('b', null, text), lead),
    addable(section) ? newButton(section, opts, true) : null);
}

/** The head's buttons: the section's own (Manage), then New board where the person may add. None: no group-actions element. */
function headActions(section: BoardSection, opts: BoardSectionsOpts): HTMLElement | null {
  const buttons = [...(section.actions ?? []), addable(section) ? newButton(section, opts) : null].filter((b): b is HTMLElement => b !== null);
  return buttons.length ? h('div', { class: 'group-actions' }, ...buttons) : null;
}

function listHead(): HTMLElement {
  return h('div', { class: 'bc-lhead' },
    h('span', null),
    h('span', null, 'Name'),
    h('span', { class: 'bc-col-hide' }, 'Here now'),
    h('span', { class: 'bc-col-hide' }, 'Last edited'),
    h('span', { class: 'bc-col-hide' }, 'Access'),
    h('span', null));
}

/** The board being dragged (set on dragstart, cleared on drop, dragend and on every render, so a stale drag drops nothing). */
let drag: BoardCardData | null = null;
/** The sections of the last render, with their elements: a drag marks them allowed or refused. */
let mounted: [HTMLElement, BoardSection][] = [];

function paintDragState(): void {
  for (const [el, section] of mounted) {
    const v = drag ? dropVerdict(section, drag) : 'same';
    el.classList.toggle('bc-drop-ok', v === 'allowed');
    el.classList.toggle('bc-drop-no', v === 'refused');
  }
}

function endDrag(): void {
  drag = null;
  paintDragState();
}

/** Makes a card a drag source when its board may move somewhere (its targets), and wires the sections as drop zones. */
function dragSource(li: HTMLElement, data: BoardCardData, opts: BoardSectionsOpts): void {
  if (opts.onMove === undefined || !data.targets?.length) return;
  li.setAttribute('draggable', 'true');
  li.addEventListener('dragstart', (event: DragEvent) => {
    drag = data;
    event.dataTransfer?.setData('text/plain', data.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    li.classList.add('bc-dragging');
    paintDragState();
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('bc-dragging');
    endDrag();
  });
}

function dropZone(el: HTMLElement, section: BoardSection, opts: BoardSectionsOpts): void {
  if (opts.onMove === undefined) return;
  el.addEventListener('dragover', (event: DragEvent) => {
    // no preventDefault for a refused drop: the browser shows the not-allowed cursor and the drop does not happen
    if (!drag || dropVerdict(section, drag) !== 'allowed') return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  el.addEventListener('drop', (event: DragEvent) => {
    if (!drag || dropVerdict(section, drag) !== 'allowed') return;
    event.preventDefault();
    const data = drag;
    endDrag();
    opts.onMove?.({ id: section.teamId ?? null, name: section.title }, data);
  });
}

function sectionEl(section: BoardSection, index: number, opts: BoardSectionsOpts): HTMLElement {
  const headId = `bc-sec-${index}`;
  const cardOpts: BoardCardOpts = { tile: opts.tile, previews: opts.previews, teams: opts.teams, onMove: opts.onMove, onAdd: opts.onAdd, onAction: opts.onAction, actions: opts.actions, down: opts.down };
  const badge = section.badge ?? (section.admin ? 'Admin' : null);
  const head = h('div', { class: 'group-head' },
    h('h2', { id: headId }, section.title),
    badge ? h('span', { class: 'badge tag tag-blue' }, badge) : null,
    h('span', { class: 'bc-count' }, countText(section.boards.length)),
    headActions(section, opts));
  let body: HTMLElement;
  if (section.boards.length === 0) {
    body = opts.view === 'list'
      ? h('ul', { class: 'bc-list' }, emptyItem(section, opts))
      : h('ul', { class: 'bc-grid' }, emptyItem(section, opts));
  } else if (opts.view === 'list') {
    body = h('div', null, listHead(), h('ul', { class: 'bc-list' }, ...section.boards.map((b) => {
      const row = boardRow(b, cardOpts);
      dragSource(row, b, opts);
      return row;
    })));
  } else {
    const newTile = section.kind === 'team' && section.canAdd === true
      ? h('li', null, h('button', { class: 'bc-new', type: 'button', disabled: opts.down === true, onclick: () => opts.onNew?.(section) }, icon('plus', 18), 'New board'))
      : null;
    body = h('ul', { class: 'bc-grid' }, ...section.boards.map((b) => {
      const card = boardCard(b, cardOpts);
      dragSource(card, b, opts);
      return card;
    }), newTile);
  }
  const el = h('section', { class: 'bc-group', 'aria-labelledby': headId }, head, body);
  dropZone(el, section, opts);
  return el;
}

/** Replaces the children of host with one section per entry, in order. */
export function renderBoardSections(host: HTMLElement, sections: BoardSection[], opts: BoardSectionsOpts): void {
  drag = null;
  const els = sections.map((section, i) => sectionEl(section, i, opts));
  mounted = els.map((el, i): [HTMLElement, BoardSection] => [el, sections[i]]);
  host.replaceChildren(...els);
}
