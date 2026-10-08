import './admin.css';
import { ApiError, api, type AdminBoard, type AdminMember, type AdminOverview, type AdminSession, type AuditEntry, type AuditPage, type Me, type Team, type UserRole } from '../api';
import { setSignedOut, signOut } from '../auth';
import { canManageBilling, cloudErrorMessage, portalTarget } from '../cloud-logic';
import { ADMIN_TABS, type AdminTab } from '../route';
import { fmtAgo, toast } from './common';
import { h, icon } from './dom';
import {
  activeOwnerCount, auditActor, auditSentence, countLabel, disableVerdict, isKnownAuditAction, matchesQuery, removeVerdict,
  revokeVerdict, roleLock, roleOptions, roleVerdict, type Actor, type Lookup,
} from './admin-logic';

const TAB_LABELS: Record<AdminTab, string> = {
  overview: 'Overview',
  members: 'Members',
  teams: 'Teams',
  boards: 'Boards',
  sessions: 'Sessions',
  audit: 'Audit log',
};

const ROLE_NAMES: Record<UserRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

/** Action filters: a prefix of the audit action, or the exact sign-in action. */
const AUDIT_FILTERS: { label: string; prefix: string }[] = [
  { label: 'All', prefix: '' },
  { label: 'Members', prefix: 'member.' },
  { label: 'Teams', prefix: 'team.' },
  { label: 'Boards', prefix: 'board.' },
  { label: 'Invites', prefix: 'invite.' },
  { label: 'Sign-ins', prefix: 'auth.login' },
];

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const GENERIC = 'Something went wrong. Try again.';

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function describe(e: unknown): string {
  const hosted = cloudErrorMessage(e);
  if (hosted) return hosted;
  if (e instanceof ApiError) {
    if (e.status === 0 || e.code === 'network') return NETWORK;
    if (e.code !== 'unknown' && e.message !== e.code) return e.message;
  }
  return GENERIC;
}

/**
 * A dead session goes to sign-in. A screen that loads and is refused goes home (the role was lost).
 * A refused change stays put: the caller toasts the server's reason. Returns true when the screen was left.
 */
function leaveOnAuthError(e: unknown, loading: boolean): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 401) {
    setSignedOut();
    location.hash = '#/signin';
    return true;
  }
  if (loading && e.status === 403 && e.code === 'forbidden') {
    location.replace('#/');
    return true;
  }
  return false;
}

const stateLine = (text: string) => h('p', { class: 'admin-state muted', role: 'status' }, text);
const emptyLine = (text: string) => h('p', { class: 'admin-state muted' }, text);

function errorLine(e: unknown, retry: () => void): HTMLElement {
  return h('div', { class: 'admin-state admin-error', role: 'alert' },
    h('span', null, describe(e)),
    h('button', { class: 'btn', onclick: retry }, 'Retry'));
}

/** Column headings for a list; hidden on phone widths, where each row labels itself. */
const head = (cells: string[]) => h('div', { class: 'admin-row admin-head' }, cells.map((c) => h('div', null, c)));

/**
 * Fills `box` with `fetchData()`: a loading line, then `show`, or an error with Retry.
 * Only the latest run may paint, so a slow earlier response never overwrites a newer one.
 */
function loadList<T>(box: HTMLElement, fetchData: () => Promise<T>, show: (data: T) => void): () => void {
  let run = 0;
  const reload = (): void => {
    const mine = ++run;
    box.replaceChildren(stateLine('Loading…'));
    void fetchData().then(
      (data) => {
        if (mine === run && box.isConnected) show(data);
      },
      (e: unknown) => {
        if (mine !== run || !box.isConnected || leaveOnAuthError(e, true)) return;
        box.replaceChildren(errorLine(e, reload));
      },
    );
  };
  reload();
  return reload;
}

/** Runs a change and toasts the outcome. Resolves true when it went through. */
async function change(run: () => Promise<unknown>, done: string): Promise<boolean> {
  try {
    await run();
    toast(done);
    return true;
  } catch (e) {
    if (!leaveOnAuthError(e, false)) toast(describe(e));
    return false;
  }
}

/** A destructive control: the first click arms it, the second runs it. Leaving the button disarms it. */
function armable(
  label: string,
  armedLabel: string,
  run: () => Promise<unknown>,
  opts: { disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  let armed = false;
  const button = h('button', { class: 'btn', disabled: opts.disabled, title: opts.title }, label);
  const disarm = () => {
    armed = false;
    button.textContent = label;
    button.classList.remove('armed');
  };
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = armedLabel;
      button.classList.add('armed');
      return;
    }
    button.disabled = true;
    try {
      await run();
    } finally {
      disarm();
      button.disabled = false;
    }
  });
  button.addEventListener('blur', disarm);
  return button;
}

function searchField(label: string, onInput: (query: string) => void): HTMLElement {
  return h('div', { class: 'admin-search' },
    icon('search'),
    h('input', {
      class: 'input', type: 'search', placeholder: label, 'aria-label': label,
      oninput: (e: Event) => onInput((e.currentTarget as HTMLInputElement).value),
    }));
}

function tile(label: string, value: number, sub?: string): HTMLElement {
  return h('div', { class: 'admin-tile' },
    h('div', { class: 'admin-tile-label' }, label),
    h('div', { class: 'admin-tile-value' }, String(value)),
    sub ? h('div', { class: 'admin-tile-sub muted small' }, sub) : null);
}

function overviewView(o: AdminOverview): HTMLElement {
  const r = o.members.byRole;
  const facts: [string, string][] = [
    ['Base URL', o.instance.baseUrl],
    ['Mail', o.instance.mail],
    ['Version', o.instance.version],
    ['Accounts', o.instance.authEnabled ? 'On' : 'Off'],
  ];
  return h('div', null,
    h('div', { class: 'admin-tiles' },
      tile('Active members', o.members.active, [
        countLabel(r.owner, 'owner', 'owners'),
        countLabel(r.admin, 'admin', 'admins'),
        countLabel(r.member, 'member', 'members'),
        countLabel(r.guest, 'guest', 'guests'),
      ].join(' · ')),
      tile('Disabled members', o.members.disabled, `${o.members.total} in total`),
      tile('Teams', o.teams.total, `${o.teams.archived} archived`),
      tile('Boards', o.boards.total, `${o.boards.deleted} deleted`),
      tile('Active sessions', o.sessions.active),
      tile('Sign-ins, last 7 days', o.signIns7d),
      tile('Live connections', o.live.connections, `${countLabel(o.live.rooms, 'room', 'rooms')} open`)),
    h('h3', { class: 'admin-sub' }, 'Instance'),
    h('dl', { class: 'admin-facts' }, facts.map(([k, v]) => h('div', { class: 'admin-fact' }, h('dt', null, k), h('dd', null, v)))));
}

/** Hosted workspaces only (docs/cloud.md): the owner's way into the billing portal. */
function billingBlock(): HTMLElement {
  const button = h('button', { class: 'btn' }, 'Manage billing');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await change(async () => {
        const { url } = await api.billingPortal();
        const target = portalTarget(url);
        if (!target) throw new Error('The billing portal address was not valid');
        location.assign(target);
      }, 'Opening billing…');
    } finally {
      button.disabled = false;
    }
  });
  return h('div', null,
    h('h3', { class: 'admin-sub' }, 'Billing'),
    h('p', { class: 'muted' }, 'Change the plan, add seats and update the payment method in the billing portal.'),
    button);
}

function overviewPanel(me: Me): HTMLElement {
  const body = h('div', null);
  loadList(body, () => api.adminOverview(), (o) => body.replaceChildren(overviewView(o), ...(canManageBilling(me) ? [billingBlock()] : [])));
  return body;
}

function membersPanel(me: Me): HTMLElement {
  const actor: Actor = { id: me.user.id, role: me.user.role };
  let members: AdminMember[] = [];
  let query = '';
  const count = h('p', { class: 'muted small admin-count' });
  const box = h('div', { class: 'admin-box', style: '--cols: minmax(0, 1.5fr) 150px minmax(0, 1.1fr) auto' });

  const paint = () => {
    const owners = activeOwnerCount(members);
    const shown = members.filter((m) => matchesQuery(query, [m.name, m.email]));
    count.textContent = query.trim() ? `${shown.length} of ${members.length}` : countLabel(members.length, 'member', 'members');
    if (!members.length) {
      box.replaceChildren(emptyLine('No members yet.'));
    } else if (!shown.length) {
      box.replaceChildren(emptyLine(`Nothing matches “${query.trim()}”.`));
    } else {
      box.replaceChildren(head(['Member', 'Role', 'Activity', '']), ...shown.map((m) => memberRow(m, owners)));
    }
  };

  const setDisabled = async (m: AdminMember, disabled: boolean) => {
    const name = m.name || m.email;
    if (await change(() => api.updateMember(m.id, { disabled }), `${disabled ? 'Disabled' : 'Enabled'} ${name}`)) {
      m.disabled = disabled;
      if (disabled) m.activeSessions = 0;
      paint();
    }
  };

  const signOutEverywhere = async (m: AdminMember) => {
    if (!(await change(() => api.revokeMemberSessions(m.id), 'Signed out everywhere'))) return;
    if (m.id === actor.id) {
      setSignedOut();
      location.hash = '#/signin';
      return;
    }
    m.activeSessions = 0;
    paint();
  };

  const removeMember = async (m: AdminMember) => {
    if (await change(() => api.removeMember(m.id), `Removed ${m.name || m.email}`)) {
      members = members.filter((x) => x.id !== m.id);
      paint();
    }
  };

  const memberRow = (m: AdminMember, owners: number): HTMLElement => {
    const self = m.id === actor.id;
    const lock = roleLock(actor, m, owners);
    const select = h('select', {
      class: 'input', 'aria-label': `Role of ${m.name || m.email}`, disabled: !lock.allowed, title: lock.reason,
      onchange: async (e: Event) => {
        const el = e.currentTarget as HTMLSelectElement;
        const next = el.value as UserRole;
        const verdict = roleVerdict(actor, m, next, owners);
        if (verdict.allowed && (await change(() => api.updateMember(m.id, { role: next }), 'Role updated'))) {
          m.role = next;
          paint();
          return;
        }
        if (!verdict.allowed) toast(verdict.reason ?? GENERIC);
        el.value = m.role;
      },
    }, ...roleOptions(actor, m).map((r) => h('option', { value: r, selected: r === m.role }, ROLE_NAMES[r])));

    const signOutVerdict = revokeVerdict(actor, m);
    const toggleVerdict = disableVerdict(actor, m, !m.disabled, owners);
    const removal = removeVerdict(actor, m, owners);
    const toggle = m.disabled
      ? h('button', { class: 'btn', disabled: !toggleVerdict.allowed, title: toggleVerdict.reason, onclick: () => setDisabled(m, false) }, 'Enable')
      : armable('Disable', 'Click again to disable', () => setDisabled(m, true), { disabled: !toggleVerdict.allowed, title: toggleVerdict.reason });

    return h('div', { class: 'admin-row' },
      h('div', { class: 'admin-who' },
        h('div', null,
          h('span', { class: 'admin-name' }, m.name || m.email),
          self ? h('span', { class: 'muted' }, ' · You') : null,
          m.disabled ? h('span', { class: 'admin-badge' }, 'Disabled') : null),
        h('div', { class: 'muted small' }, m.email),
        h('div', { class: 'muted small' }, m.teams.length ? m.teams.map((t) => t.name).join(', ') : 'No teams')),
      h('div', { class: 'admin-cell' }, h('div', { class: 'admin-select' }, select, icon('chevron', 16))),
      h('div', { class: 'admin-cell muted small' },
        h('div', null, m.lastSeenAt === null ? 'Never seen' : `Seen ${fmtAgo(m.lastSeenAt)}`),
        h('div', null, countLabel(m.activeSessions, 'active session', 'active sessions')),
        h('div', null, countLabel(m.boardCount, 'board', 'boards'))),
      h('div', { class: 'btn-row admin-actions' },
        armable('Sign out everywhere', 'Click again to sign out', () => signOutEverywhere(m), {
          disabled: !signOutVerdict.allowed, title: signOutVerdict.reason,
        }),
        toggle,
        armable('Remove', 'Click again to remove', () => removeMember(m), {
          disabled: !removal.allowed, title: removal.reason,
        })));
  };

  loadList(box, () => api.adminMembers(), (list) => {
    members = list;
    paint();
  });
  return h('div', null,
    h('div', { class: 'admin-toolbar' }, searchField('Search members', (q) => { query = q; paint(); }), count),
    box);
}

function teamsPanel(): HTMLElement {
  let teams: Team[] = [];
  const box = h('div', { class: 'admin-box', style: '--cols: minmax(0, 1fr) 140px auto' });

  const paint = () => {
    if (!teams.length) {
      box.replaceChildren(emptyLine('No teams yet.'));
      return;
    }
    const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
    box.replaceChildren(head(['Team', 'Members', '']), ...sorted.map(teamRow));
  };

  const setArchived = async (t: Team, archived: boolean) => {
    if (await change(() => api.updateTeam(t.id, { archived }), `${archived ? 'Archived' : 'Unarchived'} ${t.name}`)) {
      t.archived = archived;
      paint();
    }
  };

  const teamRow = (t: Team): HTMLElement => h('div', { class: 'admin-row' },
    h('div', { class: 'admin-who' },
      h('div', null, h('span', { class: 'admin-name' }, t.name), t.archived ? h('span', { class: 'admin-badge' }, 'Archived') : null)),
    h('div', { class: 'admin-cell muted small' }, countLabel(t.memberCount, 'member', 'members')),
    h('div', { class: 'btn-row admin-actions' }, t.archived
      ? h('button', { class: 'btn', onclick: () => setArchived(t, false) }, 'Unarchive')
      : armable('Archive', 'Click again to archive', () => setArchived(t, true))));

  loadList(box, () => api.teams(), (list) => {
    teams = list;
    paint();
  });
  return box;
}

function boardsPanel(): HTMLElement {
  let boards: AdminBoard[] = [];
  let query = '';
  let deleted = false;
  const count = h('p', { class: 'muted small admin-count' });
  const box = h('div', { class: 'admin-box', style: '--cols: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 0.9fr) auto' });

  const paint = () => {
    const shown = boards.filter((b) => matchesQuery(query, [b.title, b.ownerName ?? '', b.teamName ?? '']));
    count.textContent = query.trim() ? `${shown.length} of ${boards.length}` : countLabel(boards.length, 'board', 'boards');
    if (!boards.length) {
      box.replaceChildren(emptyLine('No boards yet.'));
    } else if (!shown.length) {
      box.replaceChildren(emptyLine(`Nothing matches “${query.trim()}”.`));
    } else {
      box.replaceChildren(head(['Board', 'Team', 'Edited', '']), ...shown.map(boardRow));
    }
  };

  const remove = async (b: AdminBoard) => {
    if (!(await change(() => api.deleteBoard(b.id), `Deleted ${b.title || 'board'}`))) return;
    if (deleted) {
      b.deletedAt = Date.now();
    } else {
      boards = boards.filter((x) => x.id !== b.id);
    }
    paint();
  };

  const restore = async (b: AdminBoard) => {
    if (await change(() => api.restoreBoard(b.id), `Restored ${b.title || 'board'}`)) {
      b.deletedAt = null;
      paint();
    }
  };

  const boardRow = (b: AdminBoard): HTMLElement => {
    const gone = b.deletedAt !== null;
    return h('div', { class: 'admin-row' },
      h('div', { class: 'admin-who' },
        h('div', null,
          h('span', { class: 'admin-name' }, b.title || 'Untitled board'),
          gone ? h('span', { class: 'admin-badge' }, 'Deleted') : null),
        h('div', { class: 'muted small' }, `Owner ${b.ownerName ?? 'removed member'}`)),
      h('div', { class: 'admin-cell muted small' },
        h('div', null, b.teamName ?? 'Personal'),
        h('div', null, countLabel(b.shareCount, 'share', 'shares'))),
      h('div', { class: 'admin-cell muted small' }, `Edited ${fmtAgo(b.updatedAt)}`),
      h('div', { class: 'btn-row admin-actions' },
        h('a', { class: 'btn', href: `#/b/${b.id}` }, 'Open'),
        gone
          ? h('button', { class: 'btn', onclick: () => restore(b) }, 'Restore')
          : armable('Delete', 'Click again to delete', () => remove(b))));
  };

  const reload = loadList(box, () => api.adminBoards(deleted), (list) => {
    boards = list;
    paint();
  });
  const showDeleted = h('input', {
    type: 'checkbox',
    onchange: (e: Event) => {
      deleted = (e.currentTarget as HTMLInputElement).checked;
      reload();
    },
  });
  return h('div', null,
    h('div', { class: 'admin-toolbar' },
      searchField('Search boards', (q) => { query = q; paint(); }),
      h('label', { class: 'admin-check' }, showDeleted, 'Show deleted'),
      count),
    box);
}

function sessionsPanel(): HTMLElement {
  let sessions: AdminSession[] = [];
  const box = h('div', { class: 'admin-box', style: '--cols: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto' });

  const paint = () => {
    if (!sessions.length) {
      box.replaceChildren(emptyLine('No active sessions.'));
      return;
    }
    box.replaceChildren(head(['Person', 'Signed in', 'Last seen', 'Expires', '']), ...sessions.map(sessionRow));
  };

  const endSession = async (s: AdminSession) => {
    if (s.current) {
      await signOut().catch(() => undefined);
      location.hash = '#/signin';
      return;
    }
    if (await change(() => api.revokeSession(s.id), `Revoked the session of ${s.userName || s.email}`)) {
      sessions = sessions.filter((x) => x.id !== s.id);
      paint();
    }
  };

  const sessionRow = (s: AdminSession): HTMLElement => h('div', { class: 'admin-row' },
    h('div', { class: 'admin-who' },
      h('div', null,
        h('span', { class: 'admin-name' }, s.userName || s.email),
        s.current ? h('span', { class: 'admin-badge' }, 'This session') : null),
      h('div', { class: 'muted small' }, s.email)),
    h('div', { class: 'admin-cell muted small' }, `Signed in ${fmtDate(s.createdAt)}`),
    h('div', { class: 'admin-cell muted small' }, `Last seen ${fmtAgo(s.lastSeen)}`),
    h('div', { class: 'admin-cell muted small' }, `Expires ${fmtDate(s.expiresAt)}`),
    h('div', { class: 'btn-row admin-actions' }, s.current
      ? armable('Sign out', 'Click again to sign out', () => endSession(s))
      : armable('Revoke', 'Click again to revoke', () => endSession(s))));

  loadList(box, () => api.adminSessions(), (list) => {
    sessions = list;
    paint();
  });
  return box;
}

function auditPanel(): HTMLElement {
  const names: Record<'user' | 'team' | 'board', Map<string, string>> = {
    user: new Map(),
    team: new Map(),
    board: new Map(),
  };
  const lookup: Lookup = (kind, id) => names[kind].get(id);
  let entries: AuditEntry[] = [];
  let cursor: number | null = null;
  let prefix = '';
  let loaded = false;
  let run = 0;
  const box = h('div', { class: 'admin-box' });
  const more = h('div', null);

  const auditRow = (e: AuditEntry): HTMLElement => h('div', { class: 'admin-row audit-row' },
    h('div', { class: 'audit-text', title: e.action }, auditSentence(e, lookup)),
    h('div', { class: 'muted small' },
      isKnownAuditAction(e.action) ? null : h('span', null, `${auditActor(e)} · `),
      h('time', { datetime: new Date(e.ts).toISOString(), title: fmtDateTime(e.ts) }, fmtAgo(e.ts))));

  const paint = () => {
    if (!entries.length) box.replaceChildren(emptyLine('Nothing recorded for this filter yet.'));
    else box.replaceChildren(...entries.map(auditRow));
    const next = cursor;
    more.replaceChildren(...(next === null ? [] : [h('div', { class: 'admin-foot' },
      h('button', { class: 'btn', onclick: () => fetchPage(next) }, 'Load more'))]));
  };

  const fetchPage = (before?: number) => {
    const mine = ++run;
    const appending = before !== undefined;
    if (appending) {
      more.replaceChildren(stateLine('Loading…'));
    } else {
      box.replaceChildren(stateLine('Loading…'));
      more.replaceChildren();
    }
    void api.adminAudit({ limit: 50, before, action: prefix || undefined }).then(
      (page: AuditPage) => {
        if (mine !== run || !box.isConnected) return;
        entries = appending ? [...entries, ...page.entries] : page.entries;
        cursor = page.next;
        loaded = true;
        paint();
      },
      (e: unknown) => {
        if (mine !== run || !box.isConnected || leaveOnAuthError(e, true)) return;
        if (appending) more.replaceChildren(errorLine(e, () => fetchPage(before)));
        else box.replaceChildren(errorLine(e, () => fetchPage()));
      },
    );
  };

  // Names make the sentences read as people and places. Without them, ids fall back to neutral labels.
  void Promise.allSettled([api.adminMembers(), api.teams(), api.adminBoards(true)]).then(([people, teams, boards]) => {
    if (people.status === 'fulfilled') for (const m of people.value) names.user.set(m.id, m.email || m.name);
    if (teams.status === 'fulfilled') for (const t of teams.value) names.team.set(t.id, t.name);
    if (boards.status === 'fulfilled') for (const b of boards.value) names.board.set(b.id, b.title || 'Untitled board');
    if (loaded && box.isConnected) paint();
  });

  const chips = AUDIT_FILTERS.map((f) => h('button', {
    class: 'admin-chip', role: 'radio', onclick: () => pick(f.prefix),
  }, f.label));
  const markChips = () => AUDIT_FILTERS.forEach((f, i) => {
    const on = f.prefix === prefix;
    chips[i].classList.toggle('on', on);
    chips[i].setAttribute('aria-checked', String(on));
  });
  const pick = (p: string) => {
    prefix = p;
    markChips();
    fetchPage();
  };
  markChips();
  fetchPage();
  return h('div', null, h('div', { class: 'admin-chips', role: 'radiogroup', 'aria-label': 'Filter by action' }, chips), box, more);
}

const PANELS: Record<AdminTab, (me: Me) => HTMLElement> = {
  overview: (me) => overviewPanel(me),
  members: membersPanel,
  teams: () => teamsPanel(),
  boards: () => boardsPanel(),
  sessions: () => sessionsPanel(),
  audit: () => auditPanel(),
};

/** The admin dashboard. The caller has checked that `me` is an owner or admin. */
export function renderAdmin(root: HTMLElement, tab: AdminTab, me: Me): void {
  document.title = 'Admin - Tabula';
  root.replaceChildren(h('main', { class: 'admin' },
    h('header', { class: 'admin-top' },
      h('a', { class: 'icon-btn', href: '#/', title: 'Back to boards', 'aria-label': 'Back to boards' }, icon('prev')),
      h('h1', { class: 'admin-title' }, 'Admin'),
      h('span', { class: 'muted small admin-me' }, me.user.name || me.user.email)),
    h('div', { class: 'admin-body' },
      h('nav', { class: 'admin-tabs', 'aria-label': 'Admin sections' },
        ADMIN_TABS.map((t) => h('a', {
          class: t === tab ? 'admin-tab on' : 'admin-tab',
          href: `#/admin/${t}`,
          'aria-current': t === tab ? 'page' : undefined,
        }, TAB_LABELS[t]))),
      h('section', { class: 'admin-panel', 'aria-label': TAB_LABELS[tab] },
        h('h2', { class: 'admin-heading' }, TAB_LABELS[tab]),
        PANELS[tab](me)))));
}
