import { h, icon } from './dom';
import { chatAvailable, signOut, type AuthState } from '../auth';
import { onChatBadge, totalUnread, watchChat } from '../chat';
import type { Me } from '../api';
import { aiToolsAvailable } from './tokens-logic';
import { openTokensDialog } from './tokens';
import { openIconCredits } from './icon-credits';

export type TopbarPage = 'boards' | 'templates' | 'chat';

/** The signed-in user, when the page shows the workspace view. */
export function accountMe(auth: AuthState): Me | null {
  return auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
}

async function signOutAndLeave() {
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
      link('templates', 'Templates', '#/templates'),
      me && chatAvailable() ? chatLink(current) : null,
      admin ? h('a', { class: 'topbar-link', href: '#/admin' }, 'Admin') : null,
      me && aiToolsAvailable(me) ? h('button', { class: 'topbar-link', type: 'button', onclick: () => openTokensDialog(me) }, 'AI tool access') : null,
      h('a', { class: 'topbar-link', href: '/docs/' }, 'Help')),
    me ? h('div', { class: 'topbar-end' },
      h('span', { class: 'topbar-me' }, me.user.name || me.user.email),
      h('button', { class: 'btn ghost', onclick: signOutAndLeave }, 'Sign out')) : null);
}

/** Filter box shared by the board lists and the template grid. */
export function searchField(label: string, value: string, onInput: (query: string) => void): HTMLElement {
  return h('div', { class: 'home-search' },
    icon('search', 18),
    h('input', {
      class: 'input', type: 'search', placeholder: label, 'aria-label': label, value,
      oninput: (e: Event) => onInput((e.currentTarget as HTMLInputElement).value),
    }));
}

export function pageFooter(note: string): HTMLElement {
  return h('footer', { class: 'home-foot' }, note, ' Fonts by Fontshare. Icon sets by their authors, see ', h('button', { class: 'link-btn', onclick: openIconCredits }, 'Icon credits'), '.');
}
