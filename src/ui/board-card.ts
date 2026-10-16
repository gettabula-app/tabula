// TAB-375 slice 2: the board card on the Boards home (spec 14, sections 3 and 7). Built with h(); names and people's text go in as
// text. The preview is drawn by board-preview.ts. The menu's actions are a pure list (menuActionsFor) so the role rules are tested
// without a popover. Data wiring (the directory, presence, roles) is a later slice.
import { fmtAgo, popover } from './common';
import { h, icon } from './dom';
import { drawPreview, imageTile, quietPreview, sanitizeShapes, type PreviewImage, type PreviewModel, type PreviewStyle } from './board-preview';
import './board-card.css';

export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer';
export type BoardAction = 'open' | 'rename' | 'move' | 'duplicate' | 'delete' | 'add';
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
  /** The drawn shapes: the fallback picture, and what shows when `image` is missing or cannot be drawn. */
  preview?: PreviewModel;
  /** A real picture of the board, shown instead of the shapes while previews are on (see PreviewImage). */
  image?: PreviewImage;
  unread?: number;
  /** The unread messages include one that mentions the viewer. */
  mention?: boolean;
  onDevice?: boolean;
  /**
   * Where the menu's Move to… (or Add to workspace…, for a device board) may send this board. Undefined: every team and Personal
   * (the demo). Empty: no move at all, and the menu has no Move to… item.
   */
  targets?: MoveTarget[];
}

export interface BoardCardOpts {
  tile: PreviewStyle;
  previews: boolean;
  teams?: { id: string; name: string }[];
  onMove?: (to: MoveTarget, data: BoardCardData) => void;
  /** Adds a device board to the workspace (the menu's Add to workspace…). */
  onAdd?: (to: MoveTarget, data: BoardCardData) => void;
  onAction?: (action: BoardAction, data: BoardCardData) => void;
  /** The actions this page offers; undefined: all of them the role allows. */
  actions?: BoardAction[];
  /** Offline: the menu's actions other than Open are disabled. */
  down?: boolean;
}

export interface TemplateCardData {
  id: string;
  name: string;
  description: string;
  category: string;
  tone?: 'yellow' | 'blue' | 'green' | 'red';
  preview?: PreviewModel;
  image?: PreviewImage;
  blank?: boolean;
}

const MENU_LABEL: Record<BoardAction, string> = { open: 'Open', rename: 'Rename', move: 'Move to…', duplicate: 'Duplicate', delete: 'Delete', add: 'Add to workspace…' };
const HEX = /^#[0-9a-fA-F]{6}$/u;

/**
 * The actions a role may take from the ⋯ menu. Viewers and commenters only open a board; an editor may not delete one (only the
 * owner does, as the table did). A device board (onDevice) is not on the server: it can be opened, added to the workspace or deleted.
 */
export function menuActionsFor(role: BoardRole | undefined, onDevice = false): BoardAction[] {
  if (onDevice) return ['open', 'add', 'delete'];
  if (role === 'viewer' || role === 'commenter') return ['open'];
  if (role === 'editor') return ['open', 'rename', 'move', 'duplicate'];
  return ['open', 'rename', 'move', 'duplicate', 'delete'];
}

function shortDate(t: number, now: number): string {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
}

/**
 * The line under a board's name. In order: on this device (open mode); Empty board (previews on, and the drawing has no shapes and
 * no real picture: a picture means the board has content, whatever its shapes say); "Name · 12 min ago" (or "Name (agent) · ...");
 * otherwise "Edited 3 Oct". `now` decides whether the year is shown. fmtAgo reads the clock itself, so a test fixes it with Date.now.
 */
export function editedLine(data: BoardCardData, now: number, previews = true): string {
  if (data.onDevice) return 'On this device';
  if (previews && !data.image && data.preview && sanitizeShapes(data.preview).length === 0) return 'Empty board';
  const who = (data.editedBy?.name ?? '').trim();
  if (who !== '') return `${who}${data.editedBy?.agent ? ' (agent)' : ''} · ${fmtAgo(data.updatedAt)}`;
  return `Edited ${shortDate(data.updatedAt, now)}`;
}

function cardLabel(data: BoardCardData): string {
  return `${data.name}${data.teamLabel ? `, team ${data.teamLabel}` : ''}${data.unread ? `, ${data.unread} unread${data.mention ? ', mentioning you' : ''}` : ''}`;
}

/**
 * The picture of a card's tile: the real image while previews are on (the drawn shapes when it cannot be drawn), else the drawn
 * shapes, else the quiet tile. The tile keeps its size and its aria-hidden: the card's name is the label.
 */
function tileContent(name: string, preview: PreviewModel | undefined, image: PreviewImage | undefined, tile: PreviewStyle, previews: boolean): Node {
  const shapes = (): Node => {
    const model = previews && preview && sanitizeShapes(preview).length > 0 ? preview : undefined;
    return model ? drawPreview(model, tile) : quietPreview(name);
  };
  const real = previews && image ? imageTile(image, shapes) : null;
  return real ?? shapes();
}

function thumbBox(data: BoardCardData, tile: PreviewStyle, previews: boolean): HTMLElement {
  return h('div', { class: 'bc-thumb', 'aria-hidden': 'true' },
    tileContent(data.name, data.preview, data.image, tile, previews),
    data.unread ? h('span', { class: data.mention ? 'bc-unread mention' : 'bc-unread' }, data.unread > 99 ? '99+' : String(data.unread)) : null);
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
  if (extra > 0) parts.push(`and ${extra} more`);
  return h('span', { class: 'bc-here', role: 'img', 'aria-label': `Here now: ${parts.join(', ')}` },
    ...shown.map(hereSquare),
    extra > 0 ? h('span', { class: 'here-more' }, `+${extra}`) : null);
}

function roleBadge(role: BoardRole | undefined): HTMLElement | null {
  if (role === 'viewer') return h('span', { class: 'badge tag tag-yellow' }, 'View only');
  if (role === 'commenter') return h('span', { class: 'badge tag tag-blue' }, 'Can comment');
  return null;
}

function menuItem(label: string, onPick: () => void, opts: { danger?: boolean; hint?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', { class: `menu-item${opts.danger ? ' danger' : ''}`, type: 'button', role: 'menuitem', disabled: opts.disabled, onclick: onPick },
    h('span', null, label),
    opts.hint ? h('span', { class: 'menu-hint', 'aria-hidden': 'true' }, opts.hint) : null);
}

/** The ⋯ menu: the actions of the role the page offers, then the list of targets (Move to…, Add to workspace…) in the same popover. */
function openMenu(anchor: HTMLElement, data: BoardCardData, opts: BoardCardOpts): void {
  const list = h('div', { class: 'bc-menu-items' });
  const pop = popover(anchor, list, { role: 'menu', className: 'bc-menu menu', label: `Actions for ${data.name}` });
  const pick = (fn: () => void) => () => {
    pop.close();
    fn();
  };
  const focusFirst = () => list.querySelector<HTMLElement>('button')?.focus();
  const offered = (a: BoardAction) => opts.actions === undefined || opts.actions.includes(a);
  // Move to…: the board's own list when the page gave one, else every team and Personal (the demo)
  const moveTargets: MoveTarget[] = data.targets ?? [...(opts.teams ?? []).map((t) => ({ id: t.id, name: t.name })), { id: null, name: 'Personal' }];
  const addTargets: MoveTarget[] = data.targets ?? [];
  // a workspace admin may move a board they can only view: the targets the page gave say so (no targets, no Move to…)
  const role = menuActionsFor(data.role, data.onDevice);
  const actions = !data.onDevice && data.targets?.length && !role.includes('move') ? ['open', 'move', ...role.slice(1)] as BoardAction[] : role;
  const items: HTMLElement[] = [];
  for (const a of actions) {
    if (!offered(a)) continue;
    if (a === 'move' && (opts.onMove === undefined || moveTargets.length === 0)) continue;
    if (a === 'add' && (opts.onAdd === undefined || addTargets.length === 0)) continue;
    if (a === 'move') items.push(menuItem(MENU_LABEL.move, () => showTargets(moveTargets, (to) => opts.onMove?.(to, data)), { hint: '›', disabled: opts.down }));
    else if (a === 'add') items.push(menuItem(MENU_LABEL.add, () => showTargets(addTargets, (to) => opts.onAdd?.(to, data)), { hint: '›', disabled: opts.down }));
    else items.push(menuItem(MENU_LABEL[a], pick(() => opts.onAction?.(a, data)), { danger: a === 'delete', disabled: opts.down && a !== 'open' }));
  }
  // the second level replaces the items inside the same popover (popover() would close this one first)
  function showTargets(targets: MoveTarget[], onTarget: (to: MoveTarget) => void): void {
    const back = menuItem('Back', () => {
      list.replaceChildren(...items);
      pop.place();
      focusFirst();
    });
    list.replaceChildren(back, ...targets.map((to) => menuItem(to.name, pick(() => onTarget(to)), { disabled: opts.down })));
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
      thumbBox(data, opts.tile, opts.previews),
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
    thumbBox(data, opts.tile, opts.previews),
    h('div', { class: 'bc-col' }, nameLink(data.id, data.name)),
    h('div', { class: 'bc-col bc-col-hide' }, hereNode(data.here ?? [], data.hereMore ?? 0) ?? h('span', { class: 'bc-sub' }, 'Nobody')),
    h('span', { class: 'bc-col bc-col-hide bc-sub' }, editedLine(data, now, opts.previews)),
    h('span', { class: 'bc-col bc-col-hide' }, roleBadge(data.role)),
    moreButton(data, opts));
}

/** A template as a card of the first-run welcome: the same card, one link that creates the board, no menu, no people. */
export function templateCard(data: TemplateCardData, opts: { tile: PreviewStyle; previews: boolean; onCreate?: (data: TemplateCardData) => void }): HTMLLIElement {
  const real = !data.blank && opts.previews && data.image ? imageTile(data.image, () => quietPreview(data.name, { plus: data.blank })) : null;
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
        real ?? (model ? drawPreview(model, opts.tile) : quietPreview(data.name, { plus: data.blank }))),
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
