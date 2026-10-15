import './notifications.css';
import { api } from '../api';
import { chatAvailable } from '../auth';
import { onNotifyFrame } from '../chat';
import { createNotificationsStore, type ListState, type NotificationsStore } from '../notifications';
import { USER_COLORS } from '../palette';
import { navigateAppHash } from '../route';
import { h, icon } from './dom';
import { colourIndex } from './chat-logic';
import { initialOf } from '../../shared/initials';
import { openChatNotifications } from './chat-prefs';
import { popover, toast } from './common';
import {
  badgeText, bellLabel, markLabel, matchesFilter, rowLabel, rowText, safeTarget, shortAgo, type NotificationFilter, type NotificationItem,
} from './notifications-logic';

const FILTER_KEY = 'tabula:notifications-filter';

let shared: NotificationsStore | null = null;

/** One store for the page: the bell on every top bar draws from the same counts and list. */
export function notificationsStore(): NotificationsStore {
  shared ??= createNotificationsStore({
    api: {
      page: (before) => api.notifications(before),
      counts: () => api.notificationCounts(),
      read: (body) => api.notificationsRead(body),
    },
    onReadFailed: () => toast('Could not mark that as read. Check your connection and try again.'),
  });
  (window as unknown as { __notifStore?: NotificationsStore }).__notifStore = shared; // the visual harness reaches the store here, like __board
  return shared;
}

const savedFilter = (): NotificationFilter => {
  try { return localStorage.getItem(FILTER_KEY) === 'mentions' ? 'mentions' : 'all'; } catch { return 'all'; }
};
const saveFilter = (f: NotificationFilter) => { try { localStorage.setItem(FILTER_KEY, f); } catch { /* the filter is a convenience */ } };

/** Goes where a notification points, if it is one of the app's own routes. Returns false when it is not. */
export function followTarget(target: string): boolean {
  const t = safeTarget(target);
  if (!t) return false;
  if (t.kind === 'hash') {
    if (location.pathname === '/' || location.pathname === '') location.hash = t.hash;
    else navigateAppHash(t.hash);
  } else {
    window.history.pushState(null, '', t.path);
    window.dispatchEvent(new Event('popstate'));
  }
  return true;
}

/**
 * The bell on the Boards top bar (proto/designer-preview/notifications/SPEC.md): a button with the count of what is addressed to
 * the person, and a panel with the list under it. Counts come over the chat socket (`notify`) or, without chat, by a 60 s poll.
 */
export function notificationsBell(): HTMLElement {
  const store = notificationsStore();
  const badge = h('span', { class: 'bell-badge', 'aria-hidden': 'true' });
  const button = h('button', { class: 'bell', type: 'button', 'aria-label': 'Notifications', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('bell', 20), badge);
  store.state().filter = savedFilter(); // the remembered chip; nothing is fetched until the panel opens
  let pop: ReturnType<typeof popover> | null = null;

  const paint = () => {
    const { counts } = store.state();
    badge.textContent = badgeText(counts.unread);
    badge.classList.toggle('show', counts.unread > 0);
    badge.classList.toggle('mention', counts.unreadMentions > 0);
    button.setAttribute('aria-label', bellLabel(counts.unread));
  };
  const life = new AbortController();
  const off = store.subscribe(() => {
    if (!button.isConnected) {
      off();
      offFrame();
      life.abort();
      return;
    }
    paint();
  });
  const offFrame = onNotifyFrame((counts) => store.notified(counts));
  store.start({ poll: !chatAvailable() });
  paint();

  button.addEventListener('click', () => {
    if (pop) { pop.close(); return; }
    openPanel(button, store, (p) => { pop = p; }, () => { pop = null; });
  });
  return button;
}

function openPanel(anchor: HTMLElement, store: NotificationsStore, hold: (p: ReturnType<typeof popover>) => void, released: () => void) {
  const body = h('div', { class: 'notif-body' });
  const head = h('div', { class: 'notif-head' });
  const chips = h('div', { class: 'notif-chips', role: 'group', 'aria-label': 'Show' });
  const foot = h('div', { class: 'notif-foot' });
  const root = h('div', { class: 'notif' }, head, chips, body, foot);
  const pop = popover(anchor, root, { side: 'bottom', className: 'notif-pop', label: 'Notifications', trap: false, onClose: () => { off(); store.setOpen(false); released(); } });
  hold(pop);

  const markAll = h('button', { class: 'notif-text-btn', type: 'button', onclick: () => void store.markAllRead() }, 'Mark all as read');
  head.append(h('h2', { class: 'notif-title' }, 'Notifications'), markAll);
  const chip = (filter: NotificationFilter, label: string) => {
    const count = h('span', { class: 'notif-chip-count' });
    const b = h('button', { class: 'notif-chip', type: 'button', 'aria-pressed': 'false', onclick: () => { saveFilter(filter); store.setFilter(filter); } }, label, count);
    return { b, count, filter };
  };
  const chipAll = chip('all', 'All');
  const chipMentions = chip('mentions', 'Mentions');
  chips.append(chipAll.b, chipMentions.b);
  const settings = h('button', { class: 'notif-text-btn', type: 'button', onclick: () => { pop.close(); openChatNotifications(); } }, 'Notification settings');
  foot.append(settings, h('span', { class: 'notif-note' }, 'Last 90 days'));

  const square = (item: NotificationItem) => {
    const actor = item.actor;
    const el = h('span', { class: 'notif-sq', 'aria-hidden': 'true' });
    if (actor) {
      el.textContent = initialOf(actor.name);
      el.setAttribute('style', `--u:${USER_COLORS[colourIndex(actor.id, USER_COLORS.length)]}`);
    } else {
      el.classList.add('neutral');
      el.append(icon('bell', 16));
    }
    return el;
  };

  const rowEl = (item: NotificationItem) => {
    const t = rowText(item);
    const now = Date.now();
    const line = h('span', { class: 'notif-line' }, h('strong', { class: 'notif-who' }, t.who), ` ${t.verb} `, h('strong', { class: 'notif-where' }, t.where), t.after ? ` ${t.after}` : '');
    const text = h('span', { class: 'notif-text' }, line, h('span', { class: 'notif-ctx' }, t.context));
    if (t.excerpt) text.append(h('span', { class: 'notif-excerpt' }, t.excerpt));
    const link = h('a', { class: 'notif-link', href: item.target || '#', 'aria-label': rowLabel(item, now) },
      h('span', { class: 'notif-dot', 'aria-hidden': 'true' }), square(item), text);
    link.addEventListener('click', (e) => {
      if (e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (!item.read) void store.markRead([item.id]);
      pop.close();
      if (!followTarget(item.target)) toast('That item is no longer there.');
    });
    const check = h('button', { class: 'notif-check', type: 'button', 'aria-label': markLabel(item), onclick: () => void store.markRead([item.id]) }, icon('check', 16));
    const side = h('span', { class: 'notif-side' }, h('span', { class: 'notif-time' }, shortAgo(item.at, now)), item.read ? null : check);
    return h('li', { class: `notif-row${item.read ? ' read' : ' unread'}`, 'data-id': item.id }, link, side);
  };

  const skeleton = () => h('ul', { class: 'notif-list notif-skel', 'aria-hidden': 'true' }, ...[0, 1, 2].map(() => h('li', { class: 'notif-row' }, h('span', { class: 'notif-bar wide' }), h('span', { class: 'notif-bar' }))));

  function empty(filter: NotificationFilter) {
    return filter === 'all'
      ? h('div', { class: 'notif-empty' }, h('strong', null, "You're all caught up"), h('span', null, 'Mentions, assignments and shares show up here.'))
      : h('div', { class: 'notif-empty' }, h('strong', null, 'No mentions'), h('span', null, 'Nobody has tagged you recently.'));
  }

  function draw() {
    const s = store.state();
    const list: ListState = s.list;
    for (const c of [chipAll, chipMentions]) {
      c.b.classList.toggle('on', c.filter === s.filter);
      c.b.setAttribute('aria-pressed', String(c.filter === s.filter));
    }
    const shown = (n: number) => (n > 0 ? badgeText(n) : '');
    chipAll.count.textContent = shown(s.counts.unread);
    chipMentions.count.textContent = shown(s.counts.unreadMentions);
    markAll.toggleAttribute('disabled', s.counts.unread === 0);

    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    const parts: Node[] = [];
    if (list.status === 'loading' || list.status === 'idle') parts.push(skeleton());
    else if (list.status === 'error') {
      parts.push(h('div', { class: 'notif-error', role: 'alert' }, h('strong', null, 'Could not load notifications'), h('span', null, 'Check your connection and try again.'),
        h('button', { class: 'notif-outline-btn', type: 'button', onclick: () => store.retry() }, 'Try again')));
    } else {
      if (list.failed) parts.push(h('div', { class: 'notif-slim-error', role: 'alert' }, 'Could not refresh. Showing what was loaded.'));
      const waiting = list.pending.filter((i) => matchesFilter(i, s.filter)).length;
      if (waiting) parts.push(h('button', { class: 'notif-new', type: 'button', onclick: () => store.showNew() }, `Show ${waiting} new`));
      const shownItems = list.items.filter((i) => matchesFilter(i, s.filter));
      const shownPending = list.pending.filter((i) => matchesFilter(i, s.filter));
      if (!shownItems.length && !shownPending.length) parts.push(empty(s.filter));
      else parts.push(h('ul', { class: 'notif-list' }, ...shownItems.map(rowEl)));
      if (list.nextCursor) parts.push(h('button', { class: 'notif-outline-btn notif-older', type: 'button', onclick: () => store.loadMore() }, 'Show older'));
    }
    body.replaceChildren(...parts);
    if (focused) restoreFocus(body, focused);
  }

  const off = store.subscribe(() => {
    if (!root.isConnected) { off(); return; }
    draw();
  });
  store.setOpen(true);
  draw();

  // focus goes into the panel: Mark all as read, or the first chip when there is nothing to mark
  (markAll.hasAttribute('disabled') ? chipAll.b : markAll).focus();

  root.addEventListener('keydown', (e) => {
    const rows = [...root.querySelectorAll<HTMLElement>('.notif-link')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && at >= 0) {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      const tabbable = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')];
      if (tabbable.at(-1) === document.activeElement) {
        // Tab out of the last control closes the panel and goes on to whatever follows the bell
        e.preventDefault();
        pop.close();
        const after = nextFocusable(anchor);
        (after ?? anchor).focus();
      }
    }
  });
}

/** What identifies the focused control across a redraw: the row it is in and which control of the row. */
function focusKey(el: HTMLElement): string | null {
  const row = el.closest<HTMLElement>('[data-id]');
  if (row) return `${row.dataset.id}:${el.classList.contains('notif-check') ? 'check' : 'link'}`;
  if (el.classList.contains('notif-new')) return 'new';
  if (el.classList.contains('notif-older')) return 'older';
  return null;
}

function restoreFocus(body: HTMLElement, key: string) {
  const [id, part] = key.split(':');
  const target = key === 'new' ? body.querySelector<HTMLElement>('.notif-new')
    : key === 'older' ? body.querySelector<HTMLElement>('.notif-older')
      : body.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] .${part === 'check' ? 'notif-check' : 'notif-link'}`) ?? body.querySelector<HTMLElement>('.notif-link');
  target?.focus({ preventScroll: true });
}

function nextFocusable(from: HTMLElement): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((e) => !e.closest('.popover'));
  const i = all.indexOf(from);
  return i >= 0 ? all[i + 1] ?? null : null;
}
