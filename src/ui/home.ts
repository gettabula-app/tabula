import './home.css';
import './home-teams.css';
import { boardsPresence } from '../presence';
import { createPresenceFeed } from '../presence-feed';
import { presenceCell } from './presence-cell';
import { h, icon } from './dom';
import { dialog, fmtAgo, popover, toast } from './common';
import { deleteBoard, listBoards, relayUrl, touchBoard, type BoardEntry } from '../sync';
import { newId } from '../store';
import { importedBoardName, readBoardFile, type ImportedBoard } from '../exporters';
import { storedWhere } from '../desktop-env';
import { ApiError, api, type BoardRole, type Me, type ServerBoard, type Team } from '../api';
import { cacheServerBoards, cachedServerBoards, chatAvailable, setSignedOut, type AuthState } from '../auth';
import { boardUnread, onChatBadge, onPresenceFrame, setPresenceWatch, watchChat } from '../chat';
import { openCreateTeam, openTeamManager, openWorkspaceMembers } from './teams';
import { createWorkspaceBanner } from './workspace';
import { accountMe, createTopbar, pageFooter, searchField } from './topbar';
import { customRef, customThumbnail, featuredTemplates, templateTagTone, useTemplate } from './templates-page';
import { builtinThumbnail } from '../template-thumb';
import { listTemplates, onTemplatesChange } from '../template-store';
import type { CustomTemplate } from '../custom-templates';
import type { TemplateDef } from '../templates';
import { templateCard, type BoardAction, type BoardCardData, type MoveTarget, type TemplateCardData } from './board-card';
import { boardsToolbar, loadPreviews, loadView, renderBoardSections, type BoardSection, type BoardView } from './boards-cards-view';
import { UNTITLED, deviceCard, deviceTargets, isMine, moveTargetsFor, toBoardCard, type LiveBoard } from './boards-home-data';
import { boardPicture } from './board-picture';
import { PREVIEW_STORED_EVENT } from './board-preview-sync';

export interface HomeNav {
  open: (id: string, opts?: { template?: string; imported?: ImportedBoard; teamId?: string }) => void;
}

const LEDE = 'An infinite whiteboard that lives on your device and works offline.';
// Only limited access is worth a badge; owning or editing a board is the norm.
const ACCESS: Partial<Record<BoardRole, string>> = { commenter: 'Can comment', viewer: 'View only' };

const emptyLine = (text: string) => h('p', { class: 'home-empty' }, text);
/** `top`: the page's own heading is hidden while there are no boards, so this title is the page's h1. */
function emptyBoardState(newBoard: HTMLElement, top = false): HTMLElement {
  // the template strip sits right below this and carries the templates, so the only action here is New board
  return h('section', { class: 'home-empty-state' },
    h(top ? 'h1' : 'h2', null, 'No boards yet'),
    h('p', null, 'Create a board, or start from a template.'),
    h('div', { class: 'home-empty-actions' }, newBoard));
}

type ActionItem = { label: string; run: () => void };

/** A menu of actions under its button (popover in common.ts): the first item takes focus, and Esc or a click outside closes it. */
function actionMenu(anchor: HTMLElement, className: string, items: ActionItem[], disabled: boolean) {
  const menu = h('div', { class: `menu ${className}` }, ...items.map(({ label, run }) => h('button', {
    class: 'menu-item', type: 'button', role: 'menuitem', disabled,
    onclick: () => {
      pop.close();
      run();
    },
  }, h('span', null, label))));
  const pop = popover(anchor, menu, { role: 'menu', side: 'bottom' });
}

function newBoardMenu(anchor: HTMLElement, onBlank: () => void, onImport: () => void, disabled: boolean) {
  actionMenu(anchor, 'home-new-board-menu', [
    { label: 'Blank board', run: onBlank },
    { label: 'From a template…', run: () => { location.hash = '#/templates'; } },
    { label: 'Import a file…', run: onImport },
  ], disabled);
}

/** Under 480 px the team actions sit behind this one button; home.css shows it instead of the buttons there. */
function moreActionsButton(items: ActionItem[], disabled: boolean): HTMLElement {
  const button: HTMLElement = h('button', {
    class: 'btn home-more', type: 'button', disabled, 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => actionMenu(button, 'home-more-menu', items, disabled),
  }, '…');
  return button;
}

function newBoardButton(fileInput: HTMLElement, onBlank: () => void, disabled: boolean): HTMLElement {
  const button = h('button', {
    class: 'btn primary', type: 'button', disabled, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => newBoardMenu(button, onBlank, () => fileInput.click(), disabled),
  }, 'New board');
  return button;
}
const normalise = (query: string) => query.trim().toLowerCase();
const matches = (title: string, query: string) => !query || title.toLowerCase().includes(query);
const noMatch = (query: string) => emptyLine(`No boards match “${query.trim()}”.`);

/** Board list: everything here lives in this browser; nothing is fetched. Accounts mode adds the workspace view. */
export function renderHome(root: HTMLElement, nav: HomeNav, auth: AuthState = { mode: 'open' }): void {
  const me = accountMe(auth);
  if (me) {
    renderAccountHome(root, nav, me, auth.mode === 'offline');
    return;
  }
  document.title = 'Boards - Tabula';
  const fileInput = boardFileInput(nav);
  const groups = h('div', { class: 'home-groups' });
  let query = '';
  const toolbar = h('div', { class: 'home-toolbar' },
    searchField('Search boards', query, (value) => {
      query = value;
      paint();
    }),
    h('div', { class: 'home-actions' },
      newBoardButton(fileInput, () => nav.open(newId()), false)));

  let relay: string | null = null;
  try { relay = relayUrl(); } catch { /* local storage may be blocked */ }
  const templates = templateStrip(nav, false, null);
  const footer = pageFooter(relay
    ? `Boards are stored ${storedWhere()} and sync through ${relay.replace(/^ws/, 'http').replace(/\/sync$/, '')} when it is reachable.`
    : `Sync is off. Boards are stored ${storedWhere()} only.`);
  const main = h('main', { class: 'home' },
    h('header', { class: 'home-head' },
      h('h1', { class: 'home-title' }, 'Boards'),
      h('p', { class: 'home-lede' }, LEDE),
      toolbar),
    groups, templates.el, footer, fileInput);
  const paint = () => {
    const q = normalise(query);
    const all = listBoards();
    const shown = all.filter((b) => matches(b.name || UNTITLED, q));
    const empty = all.length === 0;
    toolbar.hidden = empty;
    main.classList.toggle('empty', empty);
    templates.update(!empty);
    footer.hidden = empty;
    groups.replaceChildren(
      empty ? emptyBoardState(newBoardButton(fileInput, () => nav.open(newId()), false), true)
        : !shown.length ? noMatch(query)
          : boardTable('Your boards', shown.map((b) => localRow(b, paint)), 'plain'));
  };

  root.replaceChildren(h('div', { class: 'home-page' },
    createTopbar('boards', null),
    main));
  paint();
}

interface AccountData {
  teams: Team[];
  boards: ServerBoard[];
  /** The server could not be reached: teams and boards come from the last known state. */
  unreachable: boolean;
}

interface AccountView {
  nav: HomeNav;
  me: Me;
  /** Creation and sharing actions that need the server are disabled. */
  down: boolean;
  refresh: () => void;
  /** The search text outlives repaints, so a refresh does not clear it. */
  query: { value: string };
  /** The Cards | List choice and the Show previews switch: the page is rebuilt on each repaint, so they live here. */
  display?: { view: BoardView; previews: boolean };
}

function renderAccountHome(root: HTMLElement, nav: HomeNav, me: Me, offline: boolean) {
  document.title = 'Boards - Tabula';
  let seq = 0;
  let data: AccountData | null = null;
  let page: HTMLElement | null = null;
  const query = { value: '' };
  const display = { view: loadView(), previews: loadPreviews() };
  const banner = createWorkspaceBanner();

  const paint = () => {
    const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'search' && root.contains(document.activeElement);
    page = accountPage({ nav, me, down: offline || data?.unreachable === true, refresh, query, display }, data);
    root.replaceChildren(banner.el, page);
    const input = typing ? page.querySelector<HTMLInputElement>('.home-search .input') : null;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  };
  const refresh = () => {
    const mine = ++seq;
    void fetchAccount(me).then((next) => {
      // A newer refresh, or a navigation that replaced the page, makes this result stale.
      if (!next || mine !== seq || page?.parentNode !== root) return;
      data = next;
      paint();
    });
  };
  paint();
  refresh();
  startPresence(() => page?.parentNode === root);
}

let stopPresence: (() => void) | null = null;

/** "Here now" on the rows: live while this list is on the page, over the chat socket or by polling. */
function startPresence(alive: () => boolean) {
  stopPresence?.();
  boardsPresence.reset();
  stopPresence = boardsPresence.connect(createPresenceFeed({
    store: boardsPresence,
    alive,
    chatOn: chatAvailable(),
    onFrame: onPresenceFrame,
    keepSocket: watchChat,
    watch: setPresenceWatch,
    fetchList: async () => (await api.presenceList()).presence,
  }));
}

/** Resolves to null when the session has ended: the user is sent to sign-in. */
async function fetchAccount(me: Me): Promise<AccountData | null> {
  try {
    const [teams, boards] = await Promise.all([api.teams(), api.boards()]);
    cacheServerBoards(boards);
    return { teams, boards: applyDevMoves(boards), unreachable: false };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setSignedOut();
      location.hash = '#/signin';
      return null;
    }
    return {
      teams: me.teams.map((t) => ({ id: t.id, name: t.name, role: t.role, memberCount: 0, archived: false })),
      boards: applyDevMoves(cachedServerBoards()),
      unreachable: true,
    };
  }
}

/** The first-run welcome for an account with no boards: the built-in templates as cards, and a blank board. Hide is remembered. */
const WELCOME_SIZE = 5;
const BLANK_CARD: TemplateCardData = { id: 'blank', name: 'Blank board', description: 'Start from an empty canvas.', category: 'Blank', blank: true };
const welcomeCard = (def: TemplateDef): TemplateCardData => ({
  id: def.id, name: def.name, description: def.description, category: def.category, tone: templateTagTone(def.category),
  // the picture the template strip has always shown (built in, from our own code)
  image: { kind: 'svg', markup: builtinThumbnail(def) },
});

function welcomeSection(v: AccountView, display: { previews: boolean }, onHide: () => void): HTMLElement {
  const cards = [...featuredTemplates(WELCOME_SIZE).map(welcomeCard), BLANK_CARD];
  const create = (d: TemplateCardData) => (d.blank ? v.nav.open(newId()) : useTemplate(v.nav, d.id));
  return h('section', { class: 'bc-group bc-welcome', 'aria-labelledby': 'bc-welcome-title' },
    h('div', { class: 'bc-welcome-head' },
      h('h2', { class: 'home-title', id: 'bc-welcome-title' }, 'Start your first board'),
      h('button', { class: 'link-more', type: 'button', 'aria-label': 'Hide the template suggestions', onclick: onHide }, 'Hide')),
    h('p', { class: 'bc-welcome-lede' }, 'Pick a starting point, or begin with a blank board.'),
    h('ul', { class: 'bc-grid' }, ...cards.map((t) => templateCard(t, { tile: 'tint', previews: display.previews, onCreate: create }))),
    h('div', { class: 'bc-skip' }, h('button', { class: 'link-more', type: 'button', onclick: () => v.nav.open(newId()) }, 'Skip, start with a blank board')));
}

/** What the page knows about a board beside the server's record: who is here, its unread messages (when chat is on), a dev picture. */
function liveFor(b: Pick<ServerBoard, 'id' | 'updatedAt' | 'lastEditedAt'>): LiveBoard {
  const id = b.id;
  const unread = chatAvailable() ? boardUnread(id) : { unread: 0, mentions: 0 };
  return { presence: boardsPresence.get(id), unread: unread.unread, mention: unread.mentions > 0, image: boardPicture(id, b.lastEditedAt ?? b.updatedAt) };
}

const controlKey = (el: Element) => el.getAttribute('href') ?? el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '';
/**
 * Runs repaint and puts the focus back on the control it was on: the same link, label or text, and which one of those it was (the
 * first New board may be the second after a repaint). Focus on nothing in the groups: repaint alone.
 */
export function keepFocus(host: HTMLElement, repaint: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !host.contains(active)) {
    repaint();
    return;
  }
  const key = controlKey(active);
  const sameKey = () => [...host.querySelectorAll<HTMLElement>('a, button')].filter((el) => controlKey(el) === key);
  const nth = sameKey().indexOf(active);
  repaint();
  const after = sameKey();
  (after[nth] ?? after[0])?.focus();
}

/**
 * Repaints the groups when a listed board's people here or unread count changes: the cards hold a snapshot, and the rows they
 * replaced updated themselves. One subscription at a time (the last paint's); it stops once its groups have left the page.
 * The focused control is found again after the repaint, so keyboard use is not lost.
 */
let stopLive: (() => void) | null = null;
function liveRepaint(host: HTMLElement, ids: string[], repaint: () => void): void {
  stopLive?.();
  let queued = false;
  const offs = ids.map((id) => boardsPresence.watch(id, schedule));
  const offChat = onChatBadge(schedule);
  const stop = () => {
    for (const off of offs) off();
    offChat();
    if (stopLive === stop) stopLive = null;
  };
  stopLive = stop;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!host.isConnected) {
        stop();
        return;
      }
      // a menu is open: its anchor may be redrawn under it, so the repaint waits until it closes
      if (document.querySelector('.popover')) {
        setTimeout(schedule, 400);
        return;
      }
      keepFocus(host, repaint);
    });
  }
}

/** DEV STUB, not shipped: the server has no route to move a board yet. The move is kept in this tab (a reload forgets it). */
const devMoves = new Map<string, string | null>();
/** Moves a board to a team (or Personal, for null) in this tab only. Does nothing in a production build. */
export function moveBoardStub(boardId: string, teamId: string | null): void {
  if (!import.meta.env.DEV) return;
  devMoves.set(boardId, teamId);
}
/** The boards the page loads, with the dev moves applied. The list as the server sent it, in production. */
export function applyDevMoves(boards: ServerBoard[]): ServerBoard[] {
  if (!import.meta.env.DEV || devMoves.size === 0) return boards;
  return boards.map((b) => (devMoves.has(b.id) ? { ...b, teamId: devMoves.get(b.id) ?? null } : b));
}

/** The card menu's Open, and Delete (owner only: the menu offers it to owners and device boards alone). */
function cardAction(v: AccountView, action: BoardAction, card: BoardCardData): void {
  if (action === 'open') location.hash = `#/b/${encodeURIComponent(card.id)}`;
  else if (action === 'delete') {
    if (card.onDevice) confirmDeleteLocal(card, v.refresh);
    else confirmDeleteBoard(v, card.id, card.name);
  }
}

/** DEV STUB: Move to… from the menu or a drop. Moves the board in this tab, says so, and Undo puts it back where it was. */
function moveFromMenu(v: AccountView, data: AccountData, to: MoveTarget, card: BoardCardData): void {
  const from = data.boards.find((b) => b.id === card.id)?.teamId ?? null;
  moveBoardStub(card.id, to.id);
  v.refresh();
  toast('Moved (dev stub: not saved on the server yet)', 2600, {
    label: 'Undo',
    onClick: () => {
      moveBoardStub(card.id, from);
      v.refresh();
    },
  });
}

/** The sections of the Boards page for an account: one per team, Personal, Other boards or Shared with you, and this device. */
function accountSections(v: AccountView, data: AccountData, admin: boolean): BoardSection[] {
  const me = { id: v.me.user.id, admin };
  const q = normalise(v.query.value);
  const boards = data.boards.filter((b) => matches(b.title || UNTITLED, q));
  const teams = data.teams.filter((t) => !t.archived).sort((a, b) => a.name.localeCompare(b.name));
  const cardsOf = (list: ServerBoard[]) => list
    .map((b) => ({ ...toBoardCard(b, liveFor(b)), targets: moveTargetsFor(b, me, teams) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const sections: BoardSection[] = [];

  for (const team of teams) {
    const own = boards.filter((b) => b.teamId === team.id);
    if (!q || own.length) {
      sections.push({
        id: `team-${team.id}`, title: team.name, kind: 'team', teamId: team.id, canAdd: team.role !== null,
        badge: team.role ? (team.role === 'admin' ? 'Admin' : 'Member') : undefined,
        actions: [h('button', { class: 'btn sm', disabled: v.down, onclick: () => openTeamManager(team, v.me, v.refresh) }, 'Manage')],
        boards: cardsOf(own),
      });
    }
  }
  const personal = boards.filter((b) => b.teamId === null && isMine(b, me.id));
  if (!q || personal.length) sections.push({ id: 'personal', title: 'Personal', kind: 'personal', teamId: null, canAdd: true, boards: cardsOf(personal) });
  // Boards of teams not listed here (archived, or not a member) and personal boards of others would otherwise be invisible.
  const listed = new Set(teams.map((t) => t.id));
  const others = boards.filter((b) => (b.teamId === null ? !isMine(b, me.id) : !listed.has(b.teamId)));
  if (others.length) sections.push({ id: 'shared', title: admin ? 'Other boards' : 'Shared with you', kind: 'shared', boards: cardsOf(others) });
  const serverIds = new Set(data.boards.map((b) => b.id));
  const local = listBoards().filter((b) => !serverIds.has(b.id) && matches(b.name || UNTITLED, q));
  if (local.length) sections.push({ id: 'device', title: 'On this device', kind: 'device', boards: local.map((b) => deviceCard(b, deviceTargets(teams))) });
  return sections;
}

export function accountPage(v: AccountView, data: AccountData | null): HTMLElement {
  const { nav, me, down } = v;
  const admin = me.user.role === 'owner' || me.user.role === 'admin';
  const canNewTeam = me.user.role !== 'guest';
  const fileInput = boardFileInput(nav);
  const groups = h('div', { class: 'home-groups' });
  const welcomeHost = h('div');
  const display = v.display ?? { view: loadView(), previews: loadPreviews() };
  const welcomeKey = `${TEMPLATE_SUGGESTIONS_KEY}${me.user.id}`;
  const newTeam = () => openCreateTeam(v.refresh);
  const members = () => openWorkspaceMembers(me, v.refresh);
  // the same two actions, as a menu for narrow screens; a guest who may neither create a team nor see members gets no menu
  const overflow: ActionItem[] = [
    ...(canNewTeam ? [{ label: 'New team', run: newTeam }] : []),
    ...(admin ? [{ label: 'Members', run: members }] : []),
  ];
  const boardsBar = boardsToolbar({
    view: display.view,
    previews: display.previews,
    onView: (next) => {
      display.view = next;
      paintGroups();
    },
    onPreviews: (on) => {
      display.previews = on;
      paintGroups();
    },
  });
  const toolbar = h('div', { class: 'home-toolbar' },
    searchField('Search boards', v.query.value, (value) => {
      v.query.value = value;
      paintGroups();
    }),
    h('div', { class: 'home-actions' },
      newBoardButton(fileInput, () => nav.open(newId()), down),
      canNewTeam ? h('button', { class: 'btn home-action', disabled: down, onclick: newTeam }, 'New team') : null,
      admin ? h('button', { class: 'btn home-action', disabled: down, onclick: members }, 'Members') : null,
      overflow.length ? moreActionsButton(overflow, down) : null));
  const footer = pageFooter('Boards sync through your workspace server when it is reachable.');
  const main = h('main', { class: 'home' },
    h('header', { class: 'home-head' },
      h('h1', { class: 'home-title' }, 'Boards'),
      down ? h('p', { class: 'home-note', role: 'status' }, 'You are offline. Showing the last list from this device.') : null,
      toolbar,
      boardsBar),
    groups, welcomeHost, footer, fileInput);
  const paintGroups = () => {
    // With no boards the page keeps its title and toolbar; the empty state sits under them.
    const empty = data?.boards.length === 0;
    footer.hidden = empty;
    boardsBar.hidden = !data || empty;
    // The first-run templates: an account with no boards that has not hidden them (not offline: a board needs the server).
    // Once the person has had a board, they are not shown again (as the old template strip).
    if (data && data.boards.length > 0 && !templateSuggestionsDismissed(welcomeKey)) rememberTemplateSuggestionsDismissed(welcomeKey, 'board-exists');
    const showWelcome = !!data && !down && empty && !templateSuggestionsDismissed(welcomeKey);
    welcomeHost.replaceChildren(...(showWelcome ? [welcomeSection(v, display, () => {
      rememberTemplateSuggestionsDismissed(welcomeKey, 'hidden');
      paintGroups();
    })] : []));
    // hidden, not empty: an empty grid item would still take a row gap
    welcomeHost.hidden = !showWelcome;
    const ids = data?.boards.map((b) => b.id) ?? [];
    if (!data) {
      groups.replaceChildren(h('p', { class: 'home-empty', role: 'status' }, 'Loading…'));
    } else if (empty) {
      groups.replaceChildren(emptyBoardState(newBoardButton(fileInput, () => nav.open(newId()), down)));
    } else {
      const sections = accountSections(v, data, admin);
      if (sections.length === 0) {
        groups.replaceChildren(noMatch(v.query.value));
      } else {
        renderBoardSections(groups, sections, {
          view: display.view,
          tile: 'tint',
          previews: display.previews,
          down,
          actions: ['open', 'move', 'add', 'delete'],
          onNew: (section) => (section.teamId ? nav.open(newId(), { teamId: section.teamId }) : nav.open(newId())),
          onAction: (action, card) => cardAction(v, action, card),
          // the move is a stub until the server has the route: dev only, so production has no Move to… and no drag between sections
          onMove: import.meta.env.DEV ? (to, card) => moveFromMenu(v, data, to, card) : undefined,
          onAdd: (to, card) => void addDeviceBoard(card, to, v),
        });
      }
    }
    liveRepaint(groups, ids, paintGroups);
  };
  paintGroups();
  // a picture stored from this page (the board just left) draws the cards again, at its new address (ui/board-preview-sync.ts)
  const onStored = () => {
    if (!groups.isConnected) {
      window.removeEventListener(PREVIEW_STORED_EVENT, onStored);
      return;
    }
    keepFocus(groups, paintGroups);
  };
  window.addEventListener(PREVIEW_STORED_EVENT, onStored);

  return h('div', { class: 'home-page' },
    createTopbar('boards', me),
    main);
}

export interface BoardRow {
  id: string;
  title: string;
  updatedAt: number;
  role?: BoardRole;
  /** A board on the server: its chat's unread count shows beside the title (when chat is on). */
  chat?: boolean;
  /** Draws the "Here now" cell (boards on the server). */
  here?: boolean;
  actions: (HTMLElement | null)[];
}

/** A board stored in this browser: delete, and in accounts mode also Add to workspace. */
function localRow(b: BoardEntry, done: () => void, add?: (anchor: HTMLElement) => void, down = false): BoardRow {
  return {
    id: b.id, title: b.name || UNTITLED, updatedAt: b.updatedAt,
    actions: [
      add ? h('button', { class: 'btn sm', disabled: down, onclick: (e: Event) => add(e.currentTarget as HTMLElement) }, 'Add to workspace') : null,
      deleteButton(`Delete ${b.name || UNTITLED}`, 'Delete board from this device', false, () => confirmDeleteLocal(b, done)),
    ],
  };
}

function deleteButton(label: string, tip: string, disabled: boolean, onclick: () => void) {
  return h('button', { class: 'icon-btn', 'data-tip': tip, 'aria-label': label, disabled, onclick }, icon('trash', 18));
}

/**
 * The unread count of a board's chat, beside its title (inside the row's link, which opens the board and its chat): outlined
 * in red when someone mentioned you. Empty (and hidden) when nothing is unread or chat is off; it follows the live counts while on screen.
 */
function boardChatBadge(boardId: string): HTMLElement | null {
  if (!chatAvailable()) return null;
  const a = h('span', { class: 'board-chat', hidden: true });
  const paint = () => {
    const c = boardUnread(boardId);
    a.hidden = c.unread === 0;
    a.textContent = c.unread > 99 ? '99+' : String(c.unread);
    a.classList.toggle('mention', c.mentions > 0);
    a.setAttribute('aria-label', `${c.unread} unread in board chat${c.mentions ? `, ${c.mentions} mentioning you` : ''}`);
  };
  paint();
  const off = onChatBadge(() => {
    if (!a.isConnected) off();
    else paint();
  });
  return a;
}

/** Rows on hairlines under a labelled 2px rule. `access` adds the role column, `device` makes room for Add to workspace. */
export function boardTable(label: string, rows: BoardRow[], kind: 'plain' | 'access' | 'device') {
  return h('div', { class: `board-table ${kind}` },
    h('div', { class: 'board-head', 'aria-hidden': 'true' },
      h('span', null, 'Name'),
      kind === 'access' ? h('span', null, 'Here now') : null,
      h('span', null, 'Edited'),
      kind === 'access' ? h('span', null, 'Access') : null,
      h('span')),
    h('ul', { class: 'board-list', 'aria-label': label }, ...rows.map((r) => {
      const link = h('a', { href: `#/b/${encodeURIComponent(r.id)}`, class: 'board-link' }, h('span', { class: 'board-title' }, r.title), r.chat ? boardChatBadge(r.id) : null);
      return h('li', { class: 'board-row' },
      link,
      h('span', { class: 'board-sub' },
        r.here ? presenceCell(boardsPresence, r.id, () => link) : null,
        h('span', { class: 'board-edited' }, h('span', { class: 'board-lbl' }, 'Edited '), fmtAgo(r.updatedAt)),
        r.role ? h('span', { class: 'board-access' }, ACCESS[r.role] ? h('span', { class: `badge tag ${r.role === 'viewer' ? 'tag-yellow' : 'tag-blue'}` }, ACCESS[r.role]) : null) : null),
      h('span', { class: 'board-actions' }, ...r.actions));
    })));
}

/** Adds a board on this device to the workspace (the card menu's Add to workspace…): Personal, or the team picked. */
async function addDeviceBoard(card: BoardCardData, to: MoveTarget, v: AccountView): Promise<void> {
  try {
    await api.createBoard({ id: card.id, title: card.name, teamId: to.id ?? undefined });
    toast('Added to workspace');
    v.refresh();
  } catch (e) {
    toast(e instanceof ApiError && e.code === 'needs_admin' ? 'Ask a workspace admin to add this board.' : (e as Error).message);
  }
}

function confirmDeleteBoard(v: AccountView, id: string, title: string) {
  dialog('Delete this board?', h('p', null, `“${title}” will be deleted for everyone who has access to it.`), [
    { label: 'Cancel' },
    {
      label: 'Delete board', primary: true,
      onClick: async () => {
        try {
          await api.deleteBoard(id);
        } catch (e) {
          toast((e as Error).message);
          return false;
        }
        v.refresh();
      },
    },
  ]);
}

function confirmDeleteLocal(b: Pick<BoardEntry, 'id' | 'name'>, done: () => void) {
  dialog('Delete this board?', h('p', null, `“${b.name}” will be removed from this device. Copies on a relay or on collaborators’ devices are not affected.`), [
    { label: 'Cancel' },
    { label: 'Delete board', primary: true, onClick: async () => { await deleteBoard(b.id); done(); } },
  ]);
}

const STRIP_SIZE = 4;
const TEMPLATE_SUGGESTIONS_KEY = 'driftboard:home-template-suggestions:';

function templateSuggestionsDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function rememberTemplateSuggestionsDismissed(key: string, reason: 'hidden' | 'board-exists'): boolean {
  try {
    localStorage.setItem(key, reason);
    return true;
  } catch {
    return false;
  }
}

/** A short list of templates under the boards: saved ones first, then built-in ones; the templates page has the rest. */
function templateStrip(nav: HomeNav, down: boolean, userId: string | null) {
  const key = `${TEMPLATE_SUGGESTIONS_KEY}${userId ?? 'open'}`;
  let dismissed = templateSuggestionsDismissed(key);
  const tile = (key: string, label: string, title: string, description: string, thumb: string) => h('li', null,
    h('button', { class: 'tpl-tile', disabled: down, onclick: () => useTemplate(nav, key) },
      h('span', { class: 'tpl-thumb', html: thumb }),
      h('span', { class: `tpl-label tag tag-${templateTagTone(label)}` }, label),
      h('span', { class: 'tpl-title' }, title),
      h('span', { class: 'tpl-text' }, description)));
  const list = h('ul', { class: 'tpl-strip' });
  const paint = (mine: CustomTemplate[]) => {
    const own = mine.slice(0, STRIP_SIZE);
    list.replaceChildren(
      ...own.map((t) => tile(customRef(t), t.category, t.name, t.description, customThumbnail(t))),
      ...featuredTemplates(STRIP_SIZE - own.length).map((t) => tile(t.id, t.category, t.name, t.description, builtinThumbnail(t))));
  };
  const load = () => {
    void listTemplates().then((mine) => {
      if (list.isConnected) paint(mine);
    });
  };
  paint([]);
  load();
  // The page repaints with a new strip now and then; an old one stops listening when it leaves the document.
  const off = onTemplatesChange(() => {
    if (!list.isConnected) off();
    else load();
  });
  const section = h('section', { class: 'home-templates', hidden: true },
    h('div', { class: 'group-head' },
      h('h2', null, 'Start from a template'),
      h('div', { class: 'group-actions' },
        h('a', { class: 'link-more', href: '#/templates' }, 'All templates', h('span', { 'aria-hidden': 'true' }, '→')),
        h('button', {
          class: 'link-more', type: 'button', 'aria-label': 'Hide the template suggestions',
          onclick: () => {
            // blocked storage cannot remember it, but the person asked: hide it for as long as this page is open
            rememberTemplateSuggestionsDismissed(key, 'hidden');
            dismissed = true;
            section.hidden = true;
          },
        }, 'Hide'))),
    list);
  const update = (hasBoards: boolean | null) => {
    if (hasBoards === null) {
      section.hidden = true;
      return;
    }
    if (hasBoards && !dismissed) dismissed = rememberTemplateSuggestionsDismissed(key, 'board-exists');
    section.hidden = hasBoards || dismissed;
  };
  return { el: section, update };
}

/** Imports a board file as a new board on this device and opens it. Throws if the file is not a board. */
export async function importBoardFile(file: File, nav: HomeNav): Promise<void> {
  const imported = await readBoardFile(file);
  const id = newId();
  touchBoard(id, { name: importedBoardName(imported, file.name) });
  nav.open(id, { imported });
}

function boardFileInput(nav: HomeNav) {
  const fileInput = h('input', { type: 'file', accept: '.drift,.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      await importBoardFile(f, nav);
    } catch (e) {
      toast((e as Error).message);
    }
  });
  return fileInput;
}
