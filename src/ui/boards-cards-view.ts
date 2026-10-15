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
  kind: 'team' | 'personal' | 'shared';
  admin?: boolean;
  boards: BoardCardData[];
}

export interface BoardSectionsOpts {
  view: BoardView;
  tile: PreviewStyle;
  previews: boolean;
  teams?: { id: string; name: string }[];
  onNew?: (section: BoardSection) => void;
  onAction?: (action: BoardAction, data: BoardCardData) => void;
  onMove?: (to: MoveTarget, data: BoardCardData) => void;
}

const countText = (n: number) => `${n} ${n === 1 ? 'board' : 'boards'}`;

function newButton(section: BoardSection, opts: BoardSectionsOpts, primary = false): HTMLButtonElement {
  return h('button', { class: primary ? 'btn sm primary' : 'btn sm', type: 'button', onclick: () => opts.onNew?.(section) }, 'New board');
}

function emptyItem(section: BoardSection, opts: BoardSectionsOpts): HTMLLIElement {
  const shared = section.kind === 'shared';
  const text = shared ? 'No boards shared with you yet.' : `No boards in ${section.title} yet.`;
  const lead = section.kind === 'team' ? ' Boards you make here are shared with the team.' : '';
  return h('li', { class: 'bc-empty' },
    h('span', null, h('b', null, text), lead),
    shared ? null : newButton(section, opts, true));
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

function sectionEl(section: BoardSection, index: number, opts: BoardSectionsOpts): HTMLElement {
  const headId = `bc-sec-${index}`;
  const cardOpts: BoardCardOpts = { tile: opts.tile, previews: opts.previews, teams: opts.teams, onMove: opts.onMove, onAction: opts.onAction };
  const head = h('div', { class: 'group-head' },
    h('h2', { id: headId }, section.title),
    section.admin ? h('span', { class: 'badge tag tag-blue' }, 'Admin') : null,
    h('span', { class: 'bc-count' }, countText(section.boards.length)),
    section.kind === 'shared' ? null : h('div', { class: 'group-actions' }, newButton(section, opts)));
  let body: HTMLElement;
  if (section.boards.length === 0) {
    body = opts.view === 'list'
      ? h('ul', { class: 'bc-list' }, emptyItem(section, opts))
      : h('ul', { class: 'bc-grid' }, emptyItem(section, opts));
  } else if (opts.view === 'list') {
    body = h('div', null, listHead(), h('ul', { class: 'bc-list' }, ...section.boards.map((b) => boardRow(b, cardOpts))));
  } else {
    const newTile = section.kind === 'team'
      ? h('li', null, h('button', { class: 'bc-new', type: 'button', onclick: () => opts.onNew?.(section) }, icon('plus', 18), 'New board'))
      : null;
    body = h('ul', { class: 'bc-grid' }, ...section.boards.map((b) => boardCard(b, cardOpts)), newTile);
  }
  return h('section', { class: 'bc-group', 'aria-labelledby': headId }, head, body);
}

/** Replaces the children of host with one section per entry, in order. */
export function renderBoardSections(host: HTMLElement, sections: BoardSection[], opts: BoardSectionsOpts): void {
  host.replaceChildren(...sections.map((section, i) => sectionEl(section, i, opts)));
}
