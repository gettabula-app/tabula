import { h } from '../../ui/dom';
import { popover } from '../../ui/common';
import { themeRadioGroup } from '../../ui/theme-menu';
import { aiToolsAvailable } from '../../ui/tokens-logic';
import { openTokensDialog } from '../../ui/tokens';
import { signOutAndLeave } from '../../ui/topbar';
import { navigateAppHash } from '../../route';
import type { Me } from '../../api';

export interface TrackerMenuOptions {
  me: Me;
  /** Go to the boards page. */
  onBoards: () => void;
}

/**
 * The "..." menu of the full-screen tracker: the theme switch, then the workspace links and the account. The same theme
 * rows as the board menu, so a change applies at once and is remembered. Esc closes it and the popover gives focus back to
 * the button.
 */
export function openTrackerMenu(anchor: HTMLElement, { me, onBoards }: TrackerMenuOptions) {
  const admin = me.user.role === 'owner' || me.user.role === 'admin';
  const item = (label: string, fn: () => void) =>
    h('button', { class: 'menu-item', type: 'button', onclick: () => { pop.close(); fn(); } }, h('span', null, label));
  const pop = popover(anchor, h('div', { class: 'menu trk-account-menu' },
    h('div', { class: 'list-label' }, 'Theme'),
    themeRadioGroup(),
    h('hr', { class: 'menu-sep' }),
    item('Boards', onBoards),
    admin ? item('Admin', () => navigateAppHash('#/admin')) : null,
    aiToolsAvailable(me) ? item('AI tool access', () => openTokensDialog(me)) : null,
    item('Help', () => { window.open('/docs/', '_blank', 'noopener'); }),
    h('hr', { class: 'menu-sep' }),
    h('div', { class: 'list-label trk-menu-name' }, me.user.name || me.user.email),
    item('Sign out', () => { void signOutAndLeave(); }),
  ), { side: 'bottom', label: 'Menu', className: 'trk-account-pop' });
  return pop;
}
