import { h, icon } from './dom';
import { signOut, type AuthState } from '../auth';
import type { Me } from '../api';

export type TopbarPage = 'boards' | 'templates';

/** The signed-in user, when the page shows the workspace view. */
export function accountMe(auth: AuthState): Me | null {
  return auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
}

async function signOutAndLeave() {
  // The local session is cleared even when the server cannot be reached.
  await signOut().catch(() => undefined);
  location.hash = '#/signin';
}

/** Top bar of the home and templates pages: wordmark, page links, and in accounts mode the user and Sign out. */
export function createTopbar(current: TopbarPage, me: Me | null): HTMLElement {
  const admin = me?.user.role === 'owner' || me?.user.role === 'admin';
  const link = (page: TopbarPage, label: string, href: string) => h('a', {
    class: page === current ? 'topbar-link on' : 'topbar-link', href, 'aria-current': page === current ? 'page' : undefined,
  }, label);
  return h('header', { class: 'topbar' },
    h('a', { class: 'topbar-mark', href: '#/' }, 'Mira'),
    h('nav', { class: 'topbar-nav', 'aria-label': 'Main' },
      link('boards', 'Boards', '#/'),
      link('templates', 'Templates', '#/templates'),
      admin ? h('a', { class: 'topbar-link', href: '#/admin' }, 'Admin') : null),
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
  return h('footer', { class: 'home-foot' }, note, ' Fonts by Fontshare. Icons by Iconify.');
}
