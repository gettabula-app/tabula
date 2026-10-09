import './admin.css';
import { rovingRadios } from './focus-scope';
import { ApiError, api, type AdminBoard, type AdminMember, type AdminOverview, type AdminSession, type AuditEntry, type AuditPage, type Me, type Team, type UserRole } from '../api';
import { setSignedOut, signOut } from '../auth';
import { canManageBilling, cloudErrorMessage, portalTarget } from '../cloud-logic';
import { ADMIN_TABS, type AdminTab } from '../route';
import { aiAdminPanel } from './ai';
import { chatAdminPanel } from './chat-admin';
import { download } from '../exporters';
import { backupsAdminPanel } from './backups';
import { fmtAgo } from './common';
import { h, icon } from './dom';
import { tokensAdminPanel } from './tokens';
import {
  activeOwnerCount, auditActor, auditSentence, countLabel, deviceLabel, disableVerdict, focusTarget, isKnownAuditAction, matchesQuery, overviewTiles, removeVerdict,
  revokeVerdict, roleLock, roleOptions, roleVerdict, visibleAdminTabs, type Actor, type Lookup,
} from './admin-logic';

const TAB_LABELS: Record<AdminTab, string> = {
  overview: 'Overview',
  members: 'Members',
  teams: 'Teams',
  boards: 'Boards',
  sessions: 'Sessions',
  tokens: 'Access tokens',
  ai: 'AI',
  chat: 'Chat',
  backups: 'Backups',
  audit: 'Audit log',
};

const ROLE_NAMES: Record<UserRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

/** Action filters: a prefix of the audit action, or the exact sign-in action. */
const AUDIT_FILTERS: { label: string; prefix: string }[] = [
  { label: 'All', prefix: '' },
  { label: 'Members', prefix: 'member.' },
  { label: 'Teams', prefix: 'team.' },
  { label: 'Boards', prefix: 'board.' },
  { label: 'Templates', prefix: 'template.' },
  { label: 'Invites', prefix: 'invite.' },
  { label: 'Sign-ins', prefix: 'auth.login' },
  { label: 'Sessions', prefix: 'admin.session' },
  { label: 'AI', prefix: 'ai.' },
  { label: 'Images', prefix: 'asset.' },
  { label: 'Chat', prefix: 'chat.' },
  // The audit filter is one literal prefix, so backups and restores each get a chip.
  { label: 'Backups', prefix: 'backup.' },
  { label: 'Restores', prefix: 'restore.' },
];

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const GENERIC = 'Something went wrong. Try again.';

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * A cell's own label ("Signed in", "Edited"). On desktop the column heading already says it, so it is hidden there;
 * on phone widths the headings are hidden and each row labels itself.
 */
const cellLabel = (label: string) => h('span', { class: 'admin-cell-label' }, `${label} `);

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
 * A refused change stays put: the caller reports the server's reason. Returns true when the screen was left.
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

/** The status line in the top bar; a new one comes with every render, so a tab switch clears it. */
let statusLine: HTMLElement | null = null;
let statusTimer = 0;

/**
 * Shows a short outcome in the top bar, where it never covers a row. It replaces the signed-in name until
 * it clears; errors stay a little longer so they can be read.
 */
function notify(msg: string, kind: 'done' | 'error' = 'done'): void {
  if (!statusLine) return;
  const line = statusLine;
  line.textContent = msg;
  line.dataset.kind = kind;
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => (line.textContent = ''), kind === 'error' ? 5000 : 2600);
}

/** Runs a change and reports the outcome. Resolves true when it went through. */
async function change(run: () => Promise<unknown>, done: string): Promise<boolean> {
  try {
    await run();
    notify(done);
    return true;
  } catch (e) {
    if (!leaveOnAuthError(e, false)) notify(describe(e), 'error');
    return false;
  }
}

/**
 * Re-renders `box` and, when one of its controls had focus, puts focus back on the same control (by its
 * `data-focus` key) or on the same control of the row that replaced it.
 */
function repaint(box: HTMLElement, render: () => void): void {
  const keys = () => [...box.querySelectorAll<HTMLElement>('[data-focus]')].filter((e) => !(e as HTMLButtonElement).disabled);
  const active = document.activeElement;
  const key = active instanceof HTMLElement && box.contains(active) ? active.dataset.focus : undefined;
  const before = key ? keys().map((e) => e.dataset.focus!) : [];
  render();
  if (!key) return;
  const after = keys();
  const target = focusTarget(before, key, after.map((e) => e.dataset.focus!));
  after.find((e) => e.dataset.focus === target)?.focus();
}

/** What an armed button shows; its accessible name and tooltip say what the second click does. */
const ARMED = 'Click again';

/**
 * Makes `button` as wide as the widest of `labels`: they all share one grid cell, and only the first
 * child is visible. Changing the label then never moves a neighbouring button. Returns the visible label.
 */
function slotted(button: HTMLButtonElement, labels: string[]): HTMLSpanElement {
  const shown = h('span', null, button.textContent);
  button.classList.add('btn-slot');
  button.replaceChildren(shown, ...labels.map((l) => h('span', { class: 'btn-reserve', 'aria-hidden': 'true' }, l)));
  return shown;
}

/** A plain button that shares a slot with an armable one, so swapping one for the other moves nothing. */
function slotButton(
  label: string,
  onclick: () => void,
  opts: { disabled?: boolean; title?: string; focus?: string; reserve?: string[] } = {},
): HTMLButtonElement {
  const button = h('button', { class: 'btn', disabled: opts.disabled, title: opts.title, 'data-focus': opts.focus, onclick }, label);
  slotted(button, [label, ARMED, ...(opts.reserve ?? [])]);
  return button;
}

/**
 * A destructive control: the first click arms it, the second runs it. Leaving the button disarms it.
 * It keeps the width of its longest label, so arming never moves it or its neighbours. While the change
 * runs it is marked busy rather than disabled, so it keeps focus.
 */
function armable(
  label: string,
  armedLabel: string,
  run: () => Promise<unknown>,
  opts: { disabled?: boolean; title?: string; focus?: string; reserve?: string[] } = {},
): HTMLButtonElement {
  let armed = false;
  let busy = false;
  const button = h('button', { class: 'btn', disabled: opts.disabled, title: opts.title, 'data-focus': opts.focus }, label);
  const text = slotted(button, [label, ARMED, ...(opts.reserve ?? [])]);
  const disarm = () => {
    armed = false;
    text.textContent = label;
    button.classList.remove('armed');
    button.removeAttribute('aria-label');
    if (opts.title) button.title = opts.title;
    else button.removeAttribute('title');
  };
  button.addEventListener('click', async () => {
    if (busy) return;
    if (!armed) {
      armed = true;
      text.textContent = ARMED;
      button.classList.add('armed');
      button.setAttribute('aria-label', armedLabel);
      button.title = armedLabel;
      return;
    }
    busy = true;
    button.setAttribute('aria-disabled', 'true');
    try {
      await run();
    } finally {
      busy = false;
      button.removeAttribute('aria-disabled');
      disarm();
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
  const facts: [string, string][] = [
    ['Base URL', o.instance.baseUrl],
    ['Mail', o.instance.mail],
    ['Version', o.instance.version],
    ['Accounts', o.instance.authEnabled ? 'On' : 'Off'],
  ];
  return h('div', null,
    h('div', { class: 'admin-tiles' }, overviewTiles(o).map((t) => tile(t.label, t.value, t.sub))),
    h('h3', { class: 'admin-sub' }, 'Instance'),
    h('dl', { class: 'admin-facts' }, facts.map(([k, v]) => h('div', { class: 'admin-fact' }, h('dt', null, k), h('dd', null, v)))));
}

/** Hosted workspaces only (docs/cloud.md): the owner's way into the billing portal. */
function billingBlock(): HTMLElement {
  const button = h('button', { class: 'btn primary' }, 'Manage billing');
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
    repaint(box, () => {
      if (!members.length) {
        box.replaceChildren(emptyLine('No members yet.'));
      } else if (!shown.length) {
        box.replaceChildren(emptyLine(`Nothing matches “${query.trim()}”.`));
      } else {
        box.replaceChildren(head(['Member', 'Role', 'Activity', '']), ...shown.map((m) => memberRow(m, owners)));
      }
    });
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

  // docs/chat.md, Removing and erasing people: the two requests an administrator gets about a person's chat messages
  const eraseChat = async (m: AdminMember) => {
    let removed = 0;
    if (await change(async () => { removed = (await api.eraseMemberChat(m.id)).removed; }, 'Erased chat messages')) {
      notify(`Erased ${countLabel(removed, 'chat message', 'chat messages')} by ${m.name || m.email}`);
    }
  };

  const exportChat = async (m: AdminMember) => {
    await change(async () => {
      const data = await api.memberChatExport(m.id);
      const who = (m.name || m.email).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'member';
      download(JSON.stringify(data, null, 2), `chat-${who}.json`, 'application/json');
    }, 'Chat messages exported');
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
      class: 'input', 'aria-label': `Role of ${m.name || m.email}`, disabled: !lock.allowed, title: lock.reason, 'data-focus': `${m.id}:role`,
      onchange: async (e: Event) => {
        const el = e.currentTarget as HTMLSelectElement;
        const next = el.value as UserRole;
        const verdict = roleVerdict(actor, m, next, owners);
        if (verdict.allowed && (await change(() => api.updateMember(m.id, { role: next }), 'Role updated'))) {
          m.role = next;
          paint();
          return;
        }
        if (!verdict.allowed) notify(verdict.reason ?? GENERIC, 'error');
        el.value = m.role;
      },
    }, ...roleOptions(actor, m).map((r) => h('option', { value: r, selected: r === m.role }, ROLE_NAMES[r])));

    const signOutVerdict = revokeVerdict(actor, m);
    const toggleVerdict = disableVerdict(actor, m, !m.disabled, owners);
    const removal = removeVerdict(actor, m, owners);
    const teamNames = m.teams.map((t) => t.name).join(', ');
    // Enable and Disable share one slot, so toggling moves nothing either
    const toggleLabels = ['Enable', 'Disable'];
    const toggleOpts = { disabled: !toggleVerdict.allowed, title: toggleVerdict.reason, focus: `${m.id}:toggle`, reserve: toggleLabels };
    const toggle = m.disabled
      ? slotButton('Enable', () => setDisabled(m, false), toggleOpts)
      : armable('Disable', 'Click again to disable', () => setDisabled(m, true), toggleOpts);

    return h('div', { class: 'admin-row' },
      h('div', { class: 'admin-who' },
        h('div', { title: m.name || m.email },
          h('span', { class: 'admin-name' }, m.name || m.email),
          self ? h('span', { class: 'muted' }, ' · You') : null,
          m.disabled ? h('span', { class: 'admin-badge' }, 'Disabled') : null),
        h('div', { class: 'muted small', title: m.email }, m.email),
        h('div', { class: 'muted small', title: teamNames || undefined }, teamNames || 'No teams')),
      h('div', { class: 'admin-cell' }, h('div', { class: 'admin-select' }, select, icon('chevron', 16))),
      h('div', { class: 'admin-cell muted small' },
        h('div', null, m.lastSeenAt === null ? 'Never seen' : `Seen ${fmtAgo(m.lastSeenAt)}`),
        h('div', null, countLabel(m.activeSessions, 'active session', 'active sessions')),
        h('div', null, countLabel(m.boardCount, 'board', 'boards'))),
      h('div', { class: 'admin-actions-col' },
        h('div', { class: 'btn-row admin-actions' },
          armable('Sign out everywhere', 'Click again to sign out', () => signOutEverywhere(m), {
            disabled: !signOutVerdict.allowed, title: signOutVerdict.reason, focus: `${m.id}:signout`,
          }),
          toggle,
          armable('Remove', 'Click again to remove', () => removeMember(m), {
            disabled: !removal.allowed, title: removal.reason, focus: `${m.id}:remove`,
          })),
        me.chat ? h('div', { class: 'btn-row admin-actions' },
          slotButton('Export chat', () => exportChat(m), { focus: `${m.id}:chatexport` }),
          armable('Erase chat messages', 'Click again to erase', () => eraseChat(m), {
            disabled: m.role === 'owner' && actor.role !== 'owner', title: m.role === 'owner' && actor.role !== 'owner' ? 'Only an owner can erase an owner’s messages' : undefined, focus: `${m.id}:chaterase`,
          })) : null));
  };

  loadList(box, () => api.adminMembers(), (list) => {
    members = list;
    paint();
  });
  return h('div', null,
    h('div', { class: 'admin-toolbar' }, searchField('Search members', (q) => { query = q; paint(); }), count),
    me.chat ? h('p', { class: 'muted small admin-note' }, 'Erase chat messages deletes everything a person wrote in chat, in every channel, now: it answers a request to be forgotten. Backups keep earlier copies until they expire. Export chat downloads a copy of what they wrote.') : null,
    box);
}

const ARCHIVE_LABELS = ['Archive', 'Unarchive'];

function teamsPanel(): HTMLElement {
  let teams: Team[] = [];
  const box = h('div', { class: 'admin-box', style: '--cols: minmax(0, 1fr) 140px auto' });

  const paint = () => {
    if (!teams.length) {
      box.replaceChildren(emptyLine('No teams yet.'));
      return;
    }
    const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
    repaint(box, () => box.replaceChildren(head(['Team', 'Members', '']), ...sorted.map(teamRow)));
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
      ? slotButton('Unarchive', () => setArchived(t, false), { focus: `${t.id}:archive`, reserve: ARCHIVE_LABELS })
      : armable('Archive', 'Click again to archive', () => setArchived(t, true), { focus: `${t.id}:archive`, reserve: ARCHIVE_LABELS })));

  loadList(box, () => api.teams(), (list) => {
    teams = list;
    paint();
  });
  return box;
}

const DELETE_LABELS = ['Delete', 'Restore'];

function boardsPanel(): HTMLElement {
  let boards: AdminBoard[] = [];
  let query = '';
  let deleted = false;
  const count = h('p', { class: 'muted small admin-count' });
  const box = h('div', { class: 'admin-box', style: '--cols: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 0.9fr) auto' });

  const paint = () => {
    const shown = boards.filter((b) => matchesQuery(query, [b.title, b.ownerName ?? '', b.teamName ?? '']));
    count.textContent = query.trim() ? `${shown.length} of ${boards.length}` : countLabel(boards.length, 'board', 'boards');
    repaint(box, () => {
      if (!boards.length) {
        box.replaceChildren(emptyLine('No boards yet.'));
      } else if (!shown.length) {
        box.replaceChildren(emptyLine(`Nothing matches “${query.trim()}”.`));
      } else {
        box.replaceChildren(head(['Board', 'Team', 'Edited', '']), ...shown.map(boardRow));
      }
    });
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
        h('div', { title: b.title || 'Untitled board' },
          h('span', { class: 'admin-name' }, b.title || 'Untitled board'),
          gone ? h('span', { class: 'admin-badge' }, 'Deleted') : null),
        h('div', { class: 'muted small', title: `Owner ${b.ownerName ?? 'removed member'}` }, `Owner ${b.ownerName ?? 'removed member'}`)),
      h('div', { class: 'admin-cell muted small' },
        h('div', null, b.teamName ?? 'Personal'),
        h('div', null, countLabel(b.shareCount, 'share', 'shares'))),
      h('div', { class: 'admin-cell muted small' }, cellLabel('Edited'), fmtAgo(b.updatedAt)),
      h('div', { class: 'btn-row admin-actions' },
        h('a', { class: 'btn', href: `#/b/${b.id}`, 'data-focus': `${b.id}:open` }, 'Open'),
        gone
          ? slotButton('Restore', () => restore(b), { focus: `${b.id}:delete`, reserve: DELETE_LABELS })
          : armable('Delete', 'Click again to delete', () => remove(b), { focus: `${b.id}:delete`, reserve: DELETE_LABELS })));
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
    repaint(box, () => box.replaceChildren(head(['Person', 'Signed in', 'Last seen', 'Expires', '']), ...sessions.map(sessionRow)));
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
      h('div', { title: s.userName || s.email },
        h('span', { class: 'admin-name' }, s.userName || s.email),
        s.current ? h('span', { class: 'admin-badge' }, 'This session') : null),
      h('div', { class: 'muted small', title: s.email }, s.email),
      h('div', { class: 'muted small', title: s.userAgent ?? undefined }, deviceLabel(s.userAgent))),
    h('div', { class: 'admin-cell muted small' }, cellLabel('Signed in'), fmtDateTime(s.createdAt)),
    h('div', { class: 'admin-cell muted small' }, cellLabel('Last seen'), fmtAgo(s.lastSeen)),
    h('div', { class: 'admin-cell muted small' }, cellLabel('Expires'), fmtDate(s.expiresAt)),
    h('div', { class: 'btn-row admin-actions' }, s.current
      ? armable('Sign out', 'Click again to sign out', () => endSession(s), { focus: `${s.id}:end` })
      : armable('Revoke', 'Click again to revoke', () => endSession(s), { focus: `${s.id}:end` })));

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
  const chipRow = h('div', { class: 'admin-chips', role: 'radiogroup', 'aria-label': 'Filter by action' }, chips);
  rovingRadios(chipRow);
  return h('div', null, chipRow, box, more);
}

const PANELS: Record<AdminTab, (me: Me) => HTMLElement> = {
  overview: (me) => overviewPanel(me),
  members: membersPanel,
  teams: () => teamsPanel(),
  boards: () => boardsPanel(),
  sessions: () => sessionsPanel(),
  tokens: (me) => tokensAdminPanel(me, { head, loadList, change, armable, emptyLine }),
  ai: () => aiAdminPanel({ head, loadList, change, armable, emptyLine }),
  chat: () => chatAdminPanel({ head, loadList, change, armable, emptyLine }),
  backups: (me) => backupsAdminPanel(me, { head, loadList, change, armable, emptyLine }),
  audit: () => auditPanel(),
};

/** The admin dashboard. The caller has checked that `me` is an owner or admin. */
export function renderAdmin(root: HTMLElement, requested: AdminTab, me: Me): void {
  document.title = 'Admin - Tabula';
  const tabs = visibleAdminTabs(ADMIN_TABS, me.mcp, me.user.role, me.chat);
  const tab = tabs.includes(requested) ? requested : 'overview';
  clearTimeout(statusTimer);
  statusLine = h('p', { class: 'admin-status', role: 'status', 'aria-live': 'polite' });
  root.replaceChildren(h('main', { class: 'admin' },
    h('header', { class: 'admin-top' },
      h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to boards' }, icon('prev')),
      h('h1', { class: 'admin-title' }, 'Admin'),
      statusLine,
      h('span', { class: 'muted small admin-me' }, me.user.name || me.user.email)),
    h('div', { class: 'admin-body' },
      h('nav', { class: 'admin-tabs', 'aria-label': 'Admin sections' },
        tabs.map((t, i) => h('a', {
          class: t === tab ? 'admin-tab on' : 'admin-tab',
          href: `#/admin/${t}`,
          'aria-current': t === tab ? 'page' : undefined,
        }, h('span', { class: 'admin-tab-num', 'aria-hidden': 'true' }, pad2(i + 1)), TAB_LABELS[t]))),
      h('section', { class: 'admin-panel', 'aria-label': TAB_LABELS[tab] },
        h('p', { class: 'admin-kicker', 'aria-hidden': 'true' }, `${pad2(tabs.indexOf(tab) + 1)} / ${pad2(tabs.length)}`),
        h('h2', { class: 'admin-heading' }, TAB_LABELS[tab]),
        PANELS[tab](me)))));
}
