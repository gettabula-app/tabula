import './home-teams.css';
import { h, icon } from './dom';
import { dialog, fmtAgo, popover, toast } from './common';
import { deleteBoard, listBoards, relayUrl, touchBoard, type BoardEntry } from '../sync';
import { newId } from '../store';
import { readBoardFile, type ImportedBoard } from '../exporters';
import { TEMPLATES } from '../templates';
import { ApiError, api, type Me, type ServerBoard, type Team } from '../api';
import { cacheServerBoards, cachedServerBoards, setSignedOut, signOut, type AuthState } from '../auth';
import { openCreateTeam, openTeamManager, openWorkspaceMembers } from './teams';

export interface HomeNav {
  open: (id: string, opts?: { template?: string; imported?: ImportedBoard; teamId?: string }) => void;
}

const LEDE = 'An infinite whiteboard that lives on your device. Sketch, diagram and run workshops offline; sync with your team when you are online.';

/** Board list: everything here lives in this browser; nothing is fetched. Accounts mode adds the workspace view. */
export function renderHome(root: HTMLElement, nav: HomeNav, auth: AuthState = { mode: 'open' }): void {
  const me = accountMe(auth);
  if (me) {
    renderAccountHome(root, nav, me, auth.mode === 'offline');
    return;
  }
  document.title = 'Mira';
  const boards = listBoards();
  const fileInput = boardFileInput(nav);

  const list = boards.length
    ? h('ul', { class: 'board-list', 'aria-label': 'Your boards' }, ...boards.map((b) => h('li', null,
      h('a', { href: `#/b/${b.id}`, class: 'board-link' },
        h('span', { class: 'board-title' }, b.name || 'Untitled board'),
        h('span', { class: 'board-meta' }, `Edited ${fmtAgo(b.updatedAt)}`)),
      h('button', {
        class: 'icon-btn', title: 'Delete board from this device', 'aria-label': `Delete ${b.name}`,
        onclick: () => confirmDeleteLocal(b, () => renderHome(root, nav)),
      }, icon('trash', 18)),
    )))
    : h('div', { class: 'home-empty' }, h('p', null, 'No boards on this device yet. Create one, or open a link someone shared with you.'));

  const relay = relayUrl();
  root.replaceChildren(h('main', { class: 'home' },
    h('header', { class: 'home-head' },
      h('div', { class: 'wordmark', 'aria-label': 'Mira' }, 'Mira'),
      h('p', { class: 'home-lede' }, LEDE),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary big', onclick: () => nav.open(newId()) }, icon('plus', 18), 'New board'),
        h('button', { class: 'btn big', onclick: () => fileInput.click() }, icon('upload', 18), 'Open a board file'),
        fileInput,
      ),
    ),
    h('section', { class: 'home-col' },
      h('h2', null, 'Your boards'),
      list,
    ),
    templatesSection(nav),
    h('footer', { class: 'home-foot muted small' },
      relay ? `Boards are stored in this browser and sync through ${relay.replace(/^ws/, 'http').replace(/\/sync$/, '')} when it is reachable.` : 'Sync is off. Boards are stored in this browser only.',
      ' Fonts by Fontshare. Icons by Iconify.'),
  ));
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
}

/** The signed-in user, when the home screen shows the workspace view. */
function accountMe(auth: AuthState): Me | null {
  return auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
}

function renderAccountHome(root: HTMLElement, nav: HomeNav, me: Me, offline: boolean) {
  document.title = 'Mira';
  let seq = 0;
  let data: AccountData | null = null;
  let page: HTMLElement | null = null;

  const paint = () => {
    page = accountPage({ nav, me, down: offline || data?.unreachable === true, refresh }, data);
    root.replaceChildren(page);
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
  const boards = data?.boards ?? [];

  const sections: HTMLElement[] = [];
  if (data) {
    const teams = data.teams.filter((t) => !t.archived).sort((a, b) => a.name.localeCompare(b.name));
    for (const team of teams) sections.push(teamSection(v, team, boards));
    sections.push(personalSection(v, boards));
    // Boards of teams not listed here (archived, or not a member) would otherwise be invisible.
    const listed = new Set(teams.map((t) => t.id));
    const shared = boards.filter((b) => b.teamId !== null && !listed.has(b.teamId));
    if (shared.length) sections.push(sharedSection(v, shared));
    const serverIds = new Set(boards.map((b) => b.id));
    const local = listBoards().filter((b) => !serverIds.has(b.id));
    if (local.length) sections.push(deviceSection(v, local, data.teams.filter((t) => t.role !== null && !t.archived)));
  } else {
    sections.push(h('section', { class: 'home-col' }, h('p', { class: 'muted' }, 'Loading…')));
  }

  return h('main', { class: 'home' },
    h('header', { class: 'home-head' },
      h('div', { class: 'home-userbar' },
        h('span', { class: 'muted' }, me.user.name || me.user.email),
        me.user.role === 'guest' ? null : h('button', { class: 'btn', disabled: down, onclick: () => openCreateTeam(v.refresh) }, 'New team'),
        admin ? h('button', { class: 'btn', disabled: down, onclick: () => openWorkspaceMembers(me, v.refresh) }, 'Members') : null,
        h('button', { class: 'btn ghost', onclick: signOutAndLeave }, 'Sign out'),
      ),
      h('div', { class: 'wordmark', 'aria-label': 'Mira' }, 'Mira'),
      h('p', { class: 'home-lede' }, LEDE),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary big', disabled: down, onclick: () => nav.open(newId()) }, icon('plus', 18), 'New board'),
        h('button', { class: 'btn big', disabled: down, onclick: () => fileInput.click() }, icon('upload', 18), 'Open a board file'),
        fileInput,
      ),
      down ? h('p', { class: 'muted' }, 'You are offline. Showing the last list from this device.') : null,
    ),
    ...sections,
    templatesSection(nav, down),
    h('footer', { class: 'home-foot muted small' },
      'Boards sync through your workspace server when it is reachable.',
      ' Fonts by Fontshare. Icons by Iconify.'),
  );
}

function teamSection(v: AccountView, team: Team, boards: ServerBoard[]) {
  return h('section', { class: 'home-col' },
    h('div', { class: 'team-head' },
      h('h2', null, team.name),
      team.role ? h('span', { class: 'role-badge' }, team.role === 'admin' ? 'Admin' : 'Member') : null,
      h('button', { class: 'btn', disabled: v.down, onclick: () => openTeamManager(team, v.me, v.refresh) }, 'Manage'),
      team.role ? h('button', { class: 'btn', disabled: v.down, onclick: () => v.nav.open(newId(), { teamId: team.id }) }, 'New board') : null,
    ),
    serverBoardList(v, boards.filter((b) => b.teamId === team.id)),
  );
}

function personalSection(v: AccountView, boards: ServerBoard[]) {
  return h('section', { class: 'home-col' },
    h('div', { class: 'team-head' },
      h('h2', null, 'Personal'),
      h('button', { class: 'btn', disabled: v.down, onclick: () => v.nav.open(newId()) }, 'New board'),
    ),
    serverBoardList(v, boards.filter((b) => b.teamId === null)),
  );
}

function sharedSection(v: AccountView, boards: ServerBoard[]) {
  return h('section', { class: 'home-col' },
    h('h2', null, 'Shared with you'),
    serverBoardList(v, boards),
  );
}

function serverBoardList(v: AccountView, boards: ServerBoard[]) {
  if (!boards.length) return h('div', { class: 'home-empty' }, h('p', null, 'No boards yet. Create the first one.'));
  return h('ul', { class: 'board-list', 'aria-label': 'Boards' }, ...[...boards].sort((a, b) => b.updatedAt - a.updatedAt).map((b) => {
    const title = b.title || 'Untitled board';
    return h('li', null,
      h('a', { href: `#/b/${b.id}`, class: 'board-link' },
        h('span', { class: 'board-title' }, title),
        h('span', { class: 'board-meta' }, `Edited ${fmtAgo(b.updatedAt)}`)),
      b.role === 'viewer' ? h('span', { class: 'role-badge view' }, 'View only') : null,
      b.role === 'owner' ? h('button', {
        class: 'icon-btn', title: 'Delete board', 'aria-label': `Delete ${title}`, disabled: v.down,
        onclick: () => confirmDeleteBoard(v, b.id, title),
      }, icon('trash', 18)) : null,
    );
  }));
}

function deviceSection(v: AccountView, local: BoardEntry[], teams: Team[]) {
  return h('section', { class: 'home-col' },
    h('h2', null, 'On this device'),
    h('ul', { class: 'board-list', 'aria-label': 'Boards on this device' }, ...local.map((b) => h('li', null,
      h('a', { href: `#/b/${b.id}`, class: 'board-link' },
        h('span', { class: 'board-title' }, b.name || 'Untitled board'),
        h('span', { class: 'board-meta' }, `Edited ${fmtAgo(b.updatedAt)}`)),
      h('button', {
        class: 'btn', disabled: v.down,
        onclick: (e: Event) => addToWorkspace(e.currentTarget as HTMLElement, b, v, teams),
      }, 'Add to workspace'),
      h('button', {
        class: 'icon-btn', title: 'Delete board from this device', 'aria-label': `Delete ${b.name}`,
        onclick: () => confirmDeleteLocal(b, v.refresh),
      }, icon('trash', 18)),
    ))),
  );
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

async function signOutAndLeave() {
  // The local session is cleared even when the server cannot be reached.
  await signOut().catch(() => undefined);
  location.hash = '#/signin';
}

function templatesSection(nav: HomeNav, disabled = false) {
  return h('section', { class: 'home-col' },
    h('h2', null, 'Run a team exercise'),
    h('ul', { class: 'template-grid' }, ...TEMPLATES.map((t) => h('li', null,
      h('button', { class: 'template-card', disabled, onclick: () => nav.open(newId(), { template: t.id }) },
        h('span', { class: 'tpl-cat' }, t.category),
        h('span', { class: 'tpl-name' }, t.name),
        h('span', { class: 'tpl-desc' }, t.description)),
    ))),
  );
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
