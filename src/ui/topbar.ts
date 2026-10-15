import { h, icon } from './dom';
import { authState, chatAvailable, signOut, type AuthState } from '../auth';
import { onChatBadge, totalUnread, watchChat } from '../chat';
import type { Me } from '../api';
import { aiToolsAvailable } from './tokens-logic';
import { openTokensDialog } from './tokens';
import { openIconCredits } from './icon-credits';
import { navigateTrackerPath } from '../route';
import { popover } from './common';
import { openProfileDialog } from './profile-dialog';
import { openAiKeyDialog } from './ai';
import { openChatNotifications } from './chat-prefs';
import { canChangeProfile } from './share-logic';
import { getUser, saveUser } from '../sync';
import { currentChatDock } from './chat-dock';
import { notificationsBell } from './notifications';

/** The server keeps a notification list for this person (`notifications: true` in /api/me, sent by the server that has the list). */
const notificationsOn = (me: Me) => (me as Me & { notifications?: boolean }).notifications === true;

export type TopbarPage = 'boards' | 'templates' | 'chat';

/** The signed-in user, when the page shows the workspace view. */
export function accountMe(auth: AuthState): Me | null {
  return auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
}

export async function signOutAndLeave() {
  // The local session is cleared even when the server cannot be reached.
  await signOut().catch(() => undefined);
  location.hash = '#/signin';
}

/**
 * The Chat link with its unread badge (docs/chat.md, Interface), for people on a server that has chat. The badge is the sum over
 * every channel, red-outlined when someone mentioned the person. It keeps the chat socket up while the page is open and lets
 * go once the link has left the page.
 */
function chatLink(current: TopbarPage): HTMLElement {
  const badge = h('span', { class: 'topbar-badge', 'aria-hidden': 'true' });
  const a = h('a', { class: current === 'chat' ? 'topbar-link on' : 'topbar-link', href: '#/chat', 'aria-current': current === 'chat' ? 'page' : undefined }, 'Chat', badge);
  // On a page that is not the Chat page the link opens the chat dock where you are; the address still opens the Chat page in a new tab.
  a.addEventListener('click', (e) => {
    if (current === 'chat' || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const dock = currentChatDock();
    if (!dock) return;
    e.preventDefault();
    dock.noteOpener(a);
    dock.dispatch('open');
    dock.focusComposer();
  });
  const life = new AbortController();
  const paint = () => {
    const t = totalUnread();
    badge.textContent = t.unread > 99 ? '99+' : String(t.unread);
    badge.classList.toggle('show', t.unread > 0);
    badge.classList.toggle('mention', t.mentions > 0);
    a.setAttribute('aria-label', t.unread ? `Chat, ${t.unread} unread${t.mentions ? `, ${t.mentions} mentioning you` : ''}` : 'Chat');
  };
  watchChat(life.signal);
  const off = onChatBadge(() => {
    if (!a.isConnected) {
      off();
      life.abort();
      return;
    }
    paint();
  });
  paint();
  return a;
}

/** The Tracker link, for a workspace that has it. The real route is a path, so the click is routed in the app and the href still opens in a new tab. */
function trackerLink(): HTMLElement {
  return h('a', {
    class: 'topbar-link', href: '/t/all',
    onclick: (e: MouseEvent) => {
      if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigateTrackerPath({ kind: 'view', view: 'all' });
    },
  }, 'Tracker');
}

/**
 * The person's name is the account menu button: their name and colour, AI tool access, their own AI key and chat notifications
 * (each only where the server offers it), then Sign out. The top bar no longer carries AI tool access or a Sign out button.
 */
function accountButton(me: Me): HTMLElement {
  const name = me.user.name || me.user.email;
  const button = h('button', { class: 'topbar-me topbar-me-btn', type: 'button', 'aria-label': `${name}, account menu`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, name);
  button.addEventListener('click', () => openAccountMenu(button, me));
  return button;
}

/** The account menu, anchored to its button. Shared by the top bar; Esc closes it and focus goes back to the button. */
export function openAccountMenu(anchor: HTMLElement, me: Me) {
  const item = (label: string, fn: () => void) =>
    h('button', { class: 'menu-item', type: 'button', onclick: () => { pop.close(); fn(); } }, h('span', null, label));
  const pop = popover(anchor, h('div', { class: 'menu account-menu' },
    canChangeProfile(authState().mode) ? item('Your name and colour', () => openProfileDialog(getUser(), (u) => saveUser(u))) : null,
    item('My templates', () => { location.hash = '#/templates'; }),
    aiToolsAvailable(me) ? item('AI tool access', () => openTokensDialog(me)) : null,
    me.ai?.personalKeys ? item('Your AI key', () => openAiKeyDialog()) : null,
    item('Notification settings', () => openChatNotifications()),
    h('hr', { class: 'menu-sep' }),
    item('Sign out', () => { void signOutAndLeave(); }),
  ), { side: 'bottom', label: 'Account menu' });
  return pop;
}

/** Top bar of the home and templates pages: wordmark, page links, and in accounts mode the user and Sign out. */
export function createTopbar(current: TopbarPage, me: Me | null): HTMLElement {
  const admin = me?.user.role === 'owner' || me?.user.role === 'admin';
  const link = (page: TopbarPage, label: string, href: string) => h('a', {
    class: page === current ? 'topbar-link on' : 'topbar-link', href, 'aria-current': page === current ? 'page' : undefined,
  }, label);
  return h('header', { class: 'topbar' },
    h('a', { class: 'topbar-mark', href: '#/' }, 'Tabula'),
    h('nav', { class: 'topbar-nav', 'aria-label': 'Main' },
      link('boards', 'Boards', '#/'),
      me?.tracker === true ? trackerLink() : null,
      me && chatAvailable() ? chatLink(current) : null,
      admin ? h('a', { class: 'topbar-link', href: '#/admin' }, 'Admin') : null,
      h('a', { class: 'topbar-link', href: '/docs/' }, 'Help')),
    me ? h('div', { class: 'topbar-end' },
      notificationsOn(me) ? notificationsBell() : null,
      accountButton(me)) : null);
}

/** Filter box shared by the board lists and the template grid. */
let slashSearchShortcutInstalled = false;

function installSlashSearchShortcut(): void {
  if (slashSearchShortcutInstalled) return;
  slashSearchShortcutInstalled = true;
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.isContentEditable || target?.matches('input, textarea, select, [role="textbox"]')) return;
    if (document.querySelector('.modal, .popover, [role="dialog"][aria-modal="true"], [role="menu"]')) return;
    const input = document.querySelector<HTMLInputElement>('.home-search:not([hidden]) .input');
    if (!input || input.closest('[hidden]')) return;
    event.preventDefault();
    input.focus();
  });
}

export function searchField(label: string, value: string, onInput: (query: string) => void): HTMLElement {
  installSlashSearchShortcut();
  return h('div', { class: 'home-search' },
    icon('search', 18),
    h('input', {
      class: 'input', type: 'search', placeholder: label, 'aria-label': label, 'aria-keyshortcuts': '/', value,
      oninput: (e: Event) => onInput((e.currentTarget as HTMLInputElement).value),
    }),
    h('kbd', { class: 'home-search-key', 'aria-hidden': 'true' }, '/'));
}

export function pageFooter(note: string): HTMLElement {
  return h('footer', { class: 'home-foot' }, note, ' Fonts by Fontshare. Icon sets by their authors, see ', h('button', { class: 'link-btn', onclick: openIconCredits }, 'Icon credits'), '.');
}
