// TAB-375 slice 2: the board card on the Boards home (spec 14, sections 3 and 7). Built with h(); names and people's text go in as
// text. The preview is drawn by board-preview.ts. The menu's actions are a pure list (menuActionsFor) so the role rules are tested
// without a popover. Data wiring (the directory, presence, roles) is a later slice.
import { fmtAgo, popover } from './common';
import { h, icon } from './dom';
import { drawPreview, quietPreview, sanitizeShapes, type PreviewModel, type PreviewStyle } from './board-preview';
import './board-card.css';

export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer';
export type BoardAction = 'open' | 'rename' | 'move' | 'duplicate' | 'delete';
/** Where a board goes: a team's id, or null for Personal. */
export interface MoveTarget { id: string | null; name: string }
export interface HereUser { initials: string; color: string }

export interface BoardCardData {
  id: string;
  name: string;
  teamLabel?: string;
  editedBy?: { name: string; agent?: boolean };
  updatedAt: number;
  here?: HereUser[];
  hereMore?: number;
  role?: BoardRole;
  preview?: PreviewModel;
  unread?: number;
  onDevice?: boolean;
}

export interface BoardCardOpts {
  tile: PreviewStyle;
  previews: boolean;
  teams?: { id: string; name: string }[];
  onMove?: (to: MoveTarget, data: BoardCardData) => void;
  onAction?: (action: BoardAction, data: BoardCardData) => void;
}

export interface TemplateCardData {
  id: string;
  name: string;
  description: string;
  category: string;
  tone?: 'yellow' | 'blue' | 'green' | 'red';
  preview?: PreviewModel;
  blank?: boolean;
}

const MENU_LABEL: Record<BoardAction, string> = { open: 'Open', rename: 'Rename', move: 'Move to…', duplicate: 'Duplicate', delete: 'Delete' };
const HEX = /^#[0-9a-fA-F]{6}$/u;

/** The actions a role may take from the ⋯ menu. Viewers and commenters only open a board. */
export function menuActionsFor(role: BoardRole | undefined): BoardAction[] {
  return role === 'viewer' || role === 'commenter' ? ['open'] : ['open', 'rename', 'move', 'duplicate', 'delete'];
}

function shortDate(t: number, now: number): string {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
}

/**
 * The line under a board's name. In order: on this device (open mode); No content yet (previews on, and the drawing has no shapes);
 * "Name · 12 min ago" (or "Name (agent) · ..."); otherwise "Edited 3 Oct". `now` decides whether the year is shown.
 * fmtAgo reads the clock itself, so a test fixes it with Date.now.
 */
export function editedLine(data: BoardCardData, now: number, previews = true): string {
  if (data.onDevice) return 'On this device';
  if (previews && data.preview && sanitizeShapes(data.preview).length === 0) return 'No content yet';
  const who = (data.editedBy?.name ?? '').trim();
  if (who !== '') return `${who}${data.editedBy?.agent ? ' (agent)' : ''} · ${fmtAgo(data.updatedAt)}`;
  return `Edited ${shortDate(data.updatedAt, now)}`;
}

function cardLabel(data: BoardCardData): string {
  return `${data.name}${data.teamLabel ? `, team ${data.teamLabel}` : ''}${data.unread ? `, ${data.unread} unread` : ''}`;
}

function thumbBox(name: string, preview: PreviewModel | undefined, tile: PreviewStyle, previews: boolean, unread?: number): HTMLElement {
  const model = previews && preview && sanitizeShapes(preview).length > 0 ? preview : undefined;
  return h('div', { class: 'bc-thumb', 'aria-hidden': 'true' },
    model ? drawPreview(model, tile) : quietPreview(name),
    unread ? h('span', { class: 'bc-unread' }, String(unread)) : null);
}

/** The title is the link: its accessible name is the full text (the CSS clamps it to two lines); no native title (tooltip guard). */
function nameLink(id: string, name: string): HTMLAnchorElement {
  return h('a', { class: 'bc-name', href: `#/b/${encodeURIComponent(id)}` }, name);
}

function hereSquare(p: HereUser): HTMLElement {
  const sq = h('span', { class: 'here-sq' }, p.initials.slice(0, 3));
  if (HEX.test(p.color)) sq.setAttribute('style', `--u: ${p.color}`);
  return sq;
}

/** The people here now: up to three squares and "+N". Initials only, so the label is the initials and the count. */
function hereNode(list: HereUser[], more: number): HTMLElement | null {
  const shown = list.slice(0, 3);
  const extra = more + (list.length - shown.length);
  if (shown.length === 0 && extra <= 0) return null;
  const parts = shown.map((p) => p.initials.slice(0, 3));
  if (extra > 0) parts.push(`${extra} more`);
  return h('span', { class: 'bc-here', role: 'img', 'aria-label': `Here now: ${parts.join(', ')}` },
    ...shown.map(hereSquare),
    extra > 0 ? h('span', { class: 'here-more' }, `+${extra}`) : null);
}

function roleBadge(role: BoardRole | undefined): HTMLElement | null {
  if (role === 'viewer') return h('span', { class: 'badge tag tag-yellow' }, 'Viewer');
  if (role === 'commenter') return h('span', { class: 'badge tag tag-blue' }, 'Commenter');
  return null;
}

function menuItem(label: string, onPick: () => void, opts: { danger?: boolean; hint?: string } = {}): HTMLButtonElement {
  return h('button', { class: `menu-item${opts.danger ? ' danger' : ''}`, type: 'button', role: 'menuitem', onclick: onPick },
    h('span', null, label),
    opts.hint ? h('span', { class: 'menu-hint', 'aria-hidden': 'true' }, opts.hint) : null);
}

/** The ⋯ menu: the actions of the role, then (for Move to…) the list of teams and Personal in the same popover. */
function openMenu(anchor: HTMLElement, data: BoardCardData, opts: BoardCardOpts): void {
  const list = h('div', { class: 'bc-menu-items' });
  const pop = popover(anchor, list, { role: 'menu', className: 'bc-menu menu', label: `Actions for ${data.name}` });
  const pick = (fn: () => void) => () => {
    pop.close();
    fn();
  };
  const focusFirst = () => list.querySelector<HTMLElement>('button')?.focus();
  const items: HTMLElement[] = menuActionsFor(data.role)
    .filter((a) => a !== 'move' || opts.onMove !== undefined)
    .map((a) => (a === 'move'
      ? menuItem(MENU_LABEL.move, () => showTargets(), { hint: '›' })
      : menuItem(MENU_LABEL[a], pick(() => opts.onAction?.(a, data)), { danger: a === 'delete' })));
  // the second level replaces the items inside the same popover (popover() would close this one first)
  function showTargets(): void {
    const targets: MoveTarget[] = [...(opts.teams ?? []).map((t) => ({ id: t.id, name: t.name })), { id: null, name: 'Personal' }];
    const back = menuItem('Back', () => {
      list.replaceChildren(...items);
      pop.place();
      focusFirst();
    });
    list.replaceChildren(back, ...targets.map((to) => menuItem(to.name, pick(() => opts.onMove?.(to, data)))));
    pop.place();
    focusFirst();
  }
  list.replaceChildren(...items);
}

function moreButton(data: BoardCardData, opts: BoardCardOpts): HTMLButtonElement {
  const button = h('button', {
    class: 'bc-more', type: 'button', 'aria-haspopup': 'menu', 'aria-label': `More actions for ${data.name}`,
    onclick: () => openMenu(button, data, opts),
  });
  button.appendChild(icon('dots', 18));
  return button;
}

/** One board as a card: preview, name (the link to the board), edited line, people here, role badge and the ⋯ menu. */
export function boardCard(data: BoardCardData, opts: BoardCardOpts): HTMLLIElement {
  const now = Date.now();
  return h('li', { class: 'bc-li' },
    h('article', { class: 'bc', 'aria-label': cardLabel(data) },
      thumbBox(data.name, data.preview, opts.tile, opts.previews, data.unread),
      h('div', { class: 'bc-body' },
        nameLink(data.id, data.name),
        h('span', { class: 'bc-sub' }, editedLine(data, now, opts.previews))),
      h('div', { class: 'bc-foot' },
        hereNode(data.here ?? [], data.hereMore ?? 0),
        h('span', { class: 'bc-spacer' }),
        roleBadge(data.role),
        moreButton(data, opts))));
}

/** The same board as a row of the list view (columns as in board-card.css). */
export function boardRow(data: BoardCardData, opts: BoardCardOpts): HTMLLIElement {
  const now = Date.now();
  return h('li', { class: 'bc-row' },
    thumbBox(data.name, data.preview, opts.tile, opts.previews, data.unread),
    h('div', { class: 'bc-col' }, nameLink(data.id, data.name)),
    h('div', { class: 'bc-col bc-col-hide' }, hereNode(data.here ?? [], data.hereMore ?? 0) ?? h('span', { class: 'bc-sub' }, 'Nobody')),
    h('span', { class: 'bc-col bc-col-hide bc-sub' }, editedLine(data, now, opts.previews)),
    h('span', { class: 'bc-col bc-col-hide' }, roleBadge(data.role)),
    moreButton(data, opts));
}

/** A template as a card of the first-run welcome: the same card, one link that creates the board, no menu, no people. */
export function templateCard(data: TemplateCardData, opts: { tile: PreviewStyle; previews: boolean; onCreate?: (data: TemplateCardData) => void }): HTMLLIElement {
  const model = !data.blank && opts.previews && data.preview && sanitizeShapes(data.preview).length > 0 ? data.preview : undefined;
  const link = h('a', {
    class: 'bc-name', href: `#/new/${encodeURIComponent(data.id)}`,
    onclick: (event: Event) => {
      if (!opts.onCreate) return;
      event.preventDefault();
      opts.onCreate(data);
    },
  }, data.name);
  return h('li', { class: 'bc-li' },
    h('article', { class: 'bc bc-tpl', 'aria-label': data.name },
      h('div', { class: 'bc-thumb', 'aria-hidden': 'true' },
        model ? drawPreview(model, opts.tile) : quietPreview(data.name, { plus: data.blank })),
      h('div', { class: 'bc-body' }, link, h('span', { class: 'bc-sub' }, data.description)),
      h('div', { class: 'bc-foot' },
        h('span', { class: `badge tag${data.tone ? ` tag-${data.tone}` : ''}` }, data.category))));
}

/** The loading card: the geometry of a board card, with pulsing bars under reduced motion = no-preference only. */
export function boardCardSkeleton(): HTMLLIElement {
  return h('li', { class: 'bc-li' },
    h('article', { class: 'bc bc-skel', 'aria-hidden': 'true' },
      h('div', { class: 'bc-thumb' }),
      h('div', { class: 'bc-body' },
        h('i', { class: 'bc-skel-line', style: 'width: 62%' }),
        h('i', { class: 'bc-skel-line', style: 'width: 44%' })),
      h('div', { class: 'bc-foot' },
        h('i', { class: 'bc-skel-line', style: 'width: 20%; height: 20px' }))));
}
