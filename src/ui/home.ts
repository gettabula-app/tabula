import './home.css';
import './home-teams.css';
import { h, icon } from './dom';
import { dialog, fmtAgo, popover, toast } from './common';
import { deleteBoard, listBoards, relayUrl, touchBoard, type BoardEntry } from '../sync';
import { newId } from '../store';
import { readBoardFile, type ImportedBoard } from '../exporters';
import { ApiError, api, type BoardRole, type Me, type ServerBoard, type Team } from '../api';
import { cacheServerBoards, cachedServerBoards, setSignedOut, type AuthState } from '../auth';
import { openCreateTeam, openTeamManager, openWorkspaceMembers } from './teams';
import { createWorkspaceBanner } from './workspace';
import { accountMe, createTopbar, pageFooter, searchField } from './topbar';
import { customRef, customThumbnail, featuredTemplates, useTemplate } from './templates-page';
import { builtinThumbnail } from '../template-thumb';
import { listTemplates, onTemplatesChange } from '../template-store';
import type { CustomTemplate } from '../custom-templates';

// Board lists cached before the API reported owners have no ownerId: there, own boards are the ones with the owner role.
const isMine = (b: { ownerId?: string | null; role: string }, userId: string) =>
  b.ownerId === undefined ? b.role === 'owner' : b.ownerId === userId;

export interface HomeNav {
  open: (id: string, opts?: { template?: string; imported?: ImportedBoard; teamId?: string }) => void;
}

const LEDE = 'An infinite whiteboard that lives on your device and works offline.';
const UNTITLED = 'Untitled board';
// Only limited access is worth a badge; owning or editing a board is the norm.
const ACCESS: Partial<Record<BoardRole, string>> = { commenter: 'Can comment', viewer: 'View only' };

const emptyLine = (text: string) => h('p', { class: 'home-empty' }, text);
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
  document.title = 'Tabula';
  const fileInput = boardFileInput(nav);
  const groups = h('div', { class: 'home-groups' });
  let query = '';

  const paint = () => {
    const q = normalise(query);
    const all = listBoards();
    const shown = all.filter((b) => matches(b.name || UNTITLED, q));
    groups.replaceChildren(
      !all.length ? emptyLine('No boards on this device yet. Create one, or open a link someone shared with you.')
        : !shown.length ? noMatch(query)
          : boardTable('Your boards', shown.map((b) => localRow(b, paint)), 'plain'));
  };

  const relay = relayUrl();
  root.replaceChildren(h('div', { class: 'home-page' },
    createTopbar('boards', null),
    h('main', { class: 'home' },
      h('header', { class: 'home-head' },
        h('div', { class: 'home-titlerow' },
          h('h1', { class: 'home-title' }, 'Boards'),
          h('div', { class: 'home-actions' },
            h('button', { class: 'btn primary', onclick: () => nav.open(newId()) }, 'New board'),
            h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import file'),
            fileInput)),
        h('p', { class: 'home-lede' }, LEDE),
        searchField('Search boards', query, (value) => {
          query = value;
          paint();
        })),
      groups,
      templateStrip(nav, false),
      pageFooter(relay
        ? `Boards are stored in this browser and sync through ${relay.replace(/^ws/, 'http').replace(/\/sync$/, '')} when it is reachable.`
        : 'Sync is off. Boards are stored in this browser only.'))));
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
}

function renderAccountHome(root: HTMLElement, nav: HomeNav, me: Me, offline: boolean) {
  document.title = 'Tabula';
  let seq = 0;
  let data: AccountData | null = null;
  let page: HTMLElement | null = null;
  const query = { value: '' };
  const banner = createWorkspaceBanner();

  const paint = () => {
    const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'search' && root.contains(document.activeElement);
    page = accountPage({ nav, me, down: offline || data?.unreachable === true, refresh, query }, data);
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
}

/** Resolves to null when the session has ended: the user is sent to sign-in. */
async function fetchAccount(me: Me): Promise<AccountData | null> {
  try {
    const [teams, boards] = await Promise.all([api.teams(), api.boards()]);
    cacheServerBoards(boards);
    return { teams, boards, unreachable: false };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setSignedOut();
      location.hash = '#/signin';
      return null;
    }
    return {
      teams: me.teams.map((t) => ({ id: t.id, name: t.name, role: t.role, memberCount: 0, archived: false })),
      boards: cachedServerBoards(),
      unreachable: true,
    };
  }
}

function accountPage(v: AccountView, data: AccountData | null): HTMLElement {
  const { nav, me, down } = v;
  const admin = me.user.role === 'owner' || me.user.role === 'admin';
  const fileInput = boardFileInput(nav);
  const groups = h('div', { class: 'home-groups' });
  const paintGroups = () => groups.replaceChildren(...accountGroups(v, data));
  paintGroups();

  return h('div', { class: 'home-page' },
    createTopbar('boards', me),
    h('main', { class: 'home' },
      h('header', { class: 'home-head' },
        h('div', { class: 'home-titlerow' },
          h('h1', { class: 'home-title' }, 'Boards'),
          h('div', { class: 'home-actions' },
            h('button', { class: 'btn primary', disabled: down, onclick: () => nav.open(newId()) }, 'New board'),
            h('button', { class: 'btn', disabled: down, onclick: () => fileInput.click() }, 'Import file'),
            me.user.role === 'guest' ? null : h('button', { class: 'btn', disabled: down, onclick: () => openCreateTeam(v.refresh) }, 'New team'),
            admin ? h('button', { class: 'btn', disabled: down, onclick: () => openWorkspaceMembers(me, v.refresh) }, 'Members') : null,
            fileInput)),
        down ? h('p', { class: 'home-note', role: 'status' }, 'You are offline. Showing the last list from this device.') : null,
        searchField('Search boards', v.query.value, (value) => {
          v.query.value = value;
          paintGroups();
        })),
      groups,
      templateStrip(nav, down),
      pageFooter('Boards sync through your workspace server when it is reachable.')));
}

function accountGroups(v: AccountView, data: AccountData | null): HTMLElement[] {
  if (!data) return [h('p', { class: 'home-empty', role: 'status' }, 'Loading…')];
  const q = normalise(v.query.value);
  const boards = data.boards.filter((b) => matches(b.title || UNTITLED, q));
  const groups: HTMLElement[] = [];

  const teams = data.teams.filter((t) => !t.archived).sort((a, b) => a.name.localeCompare(b.name));
  for (const team of teams) {
    const own = boards.filter((b) => b.teamId === team.id);
    if (!q || own.length) groups.push(teamSection(v, team, own));
  }
  const personal = boards.filter((b) => b.teamId === null && isMine(b, v.me.user.id));
  if (!q || personal.length) groups.push(personalSection(v, personal));
  // Boards of teams not listed here (archived, or not a member) and personal boards of others would otherwise be invisible.
  const listed = new Set(teams.map((t) => t.id));
  const others = boards.filter((b) => (b.teamId === null ? !isMine(b, v.me.user.id) : !listed.has(b.teamId)));
  if (others.length) groups.push(sharedSection(v, others, v.me.user.role === 'owner' || v.me.user.role === 'admin' ? 'Other boards' : 'Shared with you'));
  const serverIds = new Set(data.boards.map((b) => b.id));
  const local = listBoards().filter((b) => !serverIds.has(b.id) && matches(b.name || UNTITLED, q));
  if (local.length) groups.push(deviceSection(v, local, data.teams.filter((t) => t.role !== null && !t.archived)));
  return groups.length ? groups : [noMatch(v.query.value)];
}

function group(heading: string, badge: string | null, actions: (HTMLElement | null)[], body: HTMLElement) {
  return h('section', { class: 'board-group', 'aria-label': heading },
    h('div', { class: 'group-head' },
      h('h2', null, heading),
      badge ? h('span', { class: 'badge' }, badge) : null,
      actions.some(Boolean) ? h('div', { class: 'group-actions' }, ...actions) : null),
    body);
}

function teamSection(v: AccountView, team: Team, boards: ServerBoard[]) {
  return group(team.name, team.role ? (team.role === 'admin' ? 'Admin' : 'Member') : null, [
    h('button', { class: 'btn sm', disabled: v.down, onclick: () => openTeamManager(team, v.me, v.refresh) }, 'Manage'),
    team.role ? h('button', { class: 'btn sm', disabled: v.down, onclick: () => v.nav.open(newId(), { teamId: team.id }) }, 'New board') : null,
  ], serverBoardList(v, boards, team.name));
}

function personalSection(v: AccountView, boards: ServerBoard[]) {
  return group('Personal', null, [
    h('button', { class: 'btn sm', disabled: v.down, onclick: () => v.nav.open(newId()) }, 'New board'),
  ], serverBoardList(v, boards, 'Personal'));
}

function sharedSection(v: AccountView, boards: ServerBoard[], heading: string) {
  return group(heading, null, [], serverBoardList(v, boards, heading));
}

function serverBoardList(v: AccountView, boards: ServerBoard[], label: string) {
  if (!boards.length) return emptyLine('No boards yet. Create the first one.');
  return boardTable(label, [...boards].sort((a, b) => b.updatedAt - a.updatedAt).map((b) => {
    const title = b.title || UNTITLED;
    return {
      id: b.id, title, updatedAt: b.updatedAt, role: b.role,
      actions: [b.role === 'owner' ? deleteButton(`Delete ${title}`, 'Delete board', v.down, () => confirmDeleteBoard(v, b.id, title)) : null],
    };
  }), 'access');
}

function deviceSection(v: AccountView, local: BoardEntry[], teams: Team[]) {
  return group('On this device', null, [], boardTable('On this device', local.map((b) => localRow(b, v.refresh, (anchor) => addToWorkspace(anchor, b, v, teams), v.down)), 'device'));
}

interface BoardRow {
  id: string;
  title: string;
  updatedAt: number;
  role?: BoardRole;
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

function deleteButton(label: string, title: string, disabled: boolean, onclick: () => void) {
  return h('button', { class: 'icon-btn', title, 'aria-label': label, disabled, onclick }, icon('trash', 18));
}

/** Rows on hairlines under a labelled 2px rule. `access` adds the role column, `device` makes room for Add to workspace. */
function boardTable(label: string, rows: BoardRow[], kind: 'plain' | 'access' | 'device') {
  return h('div', { class: `board-table ${kind}` },
    h('div', { class: 'board-head', 'aria-hidden': 'true' },
      h('span', null, 'Name'),
      h('span', null, 'Edited'),
      kind === 'access' ? h('span', null, 'Access') : null,
      h('span')),
    h('ul', { class: 'board-list', 'aria-label': label }, ...rows.map((r) => h('li', { class: 'board-row' },
      h('a', { href: `#/b/${r.id}`, class: 'board-link' }, h('span', { class: 'board-title' }, r.title)),
      h('span', { class: 'board-sub' },
        h('span', { class: 'board-edited' }, h('span', { class: 'board-lbl' }, 'Edited '), fmtAgo(r.updatedAt)),
        r.role ? h('span', { class: 'board-access' }, ACCESS[r.role] ? h('span', { class: 'badge' }, ACCESS[r.role]) : null) : null),
      h('span', { class: 'board-actions' }, ...r.actions)))));
}

function addToWorkspace(anchor: HTMLElement, b: BoardEntry, v: AccountView, teams: Team[]) {
  const pick = async (teamId?: string) => {
    pop.close();
    try {
      await api.createBoard({ id: b.id, title: b.name, teamId });
      toast('Added to workspace');
      v.refresh();
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'needs_admin' ? 'Ask a workspace admin to add this board.' : (e as Error).message);
    }
  };
  const menu = h('div', { class: 'menu' },
    h('button', { class: 'menu-item', onclick: () => pick() }, 'Personal'),
    ...teams.map((t) => h('button', { class: 'menu-item', onclick: () => pick(t.id) }, t.name)),
  );
  const pop = popover(anchor, menu);
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

function confirmDeleteLocal(b: BoardEntry, done: () => void) {
  dialog('Delete this board?', h('p', null, `“${b.name}” will be removed from this device. Copies on a relay or on collaborators’ devices are not affected.`), [
    { label: 'Cancel' },
    { label: 'Delete board', primary: true, onClick: async () => { await deleteBoard(b.id); done(); } },
  ]);
}

const STRIP_SIZE = 4;

/** A short list of templates under the boards: saved ones first, then built-in ones; the templates page has the rest. */
function templateStrip(nav: HomeNav, down: boolean) {
  const tile = (key: string, label: string, title: string, thumb: string) => h('li', null,
    h('button', { class: 'tpl-tile', disabled: down, onclick: () => useTemplate(nav, key) },
      h('span', { class: 'tpl-thumb', html: thumb }),
      h('span', { class: 'tpl-label' }, label),
      h('span', { class: 'tpl-title' }, title)));
  const list = h('ul', { class: 'tpl-strip' });
  const paint = (mine: CustomTemplate[]) => {
    const own = mine.slice(0, STRIP_SIZE);
    list.replaceChildren(
      ...own.map((t) => tile(customRef(t), t.category, t.name, customThumbnail(t))),
      ...featuredTemplates(STRIP_SIZE - own.length).map((t) => tile(t.id, t.category, t.name, builtinThumbnail(t))));
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
  return h('section', { class: 'home-templates' },
    h('div', { class: 'group-head' },
      h('h2', null, 'Start from a template'),
      h('div', { class: 'group-actions' },
        h('a', { class: 'link-more', href: '#/templates' }, 'All templates', h('span', { 'aria-hidden': 'true' }, '→')))),
    list);
}

function boardFileInput(nav: HomeNav) {
  const fileInput = h('input', { type: 'file', accept: '.drift,.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const imported = await readBoardFile(f);
      const id = newId();
      touchBoard(id, { name: imported.json.meta?.name || f.name.replace(/\.\w+$/, '') });
      nav.open(id, { imported });
    } catch (e) {
      toast((e as Error).message);
    }
  });
  return fileInput;
}
