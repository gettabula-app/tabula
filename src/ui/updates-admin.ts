import './updates-admin.css';
import { ApiError, api, type AdminUpdates, type Me } from '../api';
import { setSignedOut } from '../auth';
import { h } from './dom';

const SAVED = 'Saved.';
const RETRYING = 'Saved. Tabula Cloud could not be reached; we will keep trying.';

/** The hosted workspace's automatic update setting. Admins can read it; only the owner can change it. */
export function updatesAdminPanel(me: Me): HTMLElement {
  const root = h('div', { class: 'updates-admin' });
  const owner = me.user.role === 'owner';
  let saved: AdminUpdates | null = null;
  let failed = false;
  let busy = false;
  let pendingAuto: boolean | null = null;
  let outcome = '';

  const leaveOnAuthError = (error: unknown) => {
    if (!(error instanceof ApiError)) return false;
    if (error.status === 401) {
      setSignedOut();
      location.hash = '#/signin';
      return true;
    }
    if (error.status === 403) {
      location.replace('#/');
      return true;
    }
    return false;
  };

  const load = () => {
    failed = false;
    render();
    void api.adminUpdates().then((state) => {
      saved = state;
      render();
    }, (error: unknown) => {
      if (leaveOnAuthError(error)) return;
      failed = true;
      render();
    });
  };

  const save = async (auto: boolean) => {
    pendingAuto = auto;
    busy = true;
    outcome = '';
    render();
    try {
      saved = await api.setAdminUpdates(auto);
      outcome = saved.synced ? SAVED : RETRYING;
    } catch (error) {
      if (leaveOnAuthError(error)) return;
      pendingAuto = null;
      outcome = 'Could not save. Try again.';
    } finally {
      busy = false;
      pendingAuto = null;
      render();
    }
  };

  function render() {
    if (!saved) {
      if (failed) {
        root.replaceChildren(h('div', { class: 'admin-state admin-error', role: 'alert' },
          h('span', null, 'Settings could not be loaded. Check your connection and reload.'),
          h('button', { class: 'btn', onclick: load }, 'Retry')));
      } else {
        root.replaceChildren(h('p', { class: 'admin-state muted', role: 'status' }, 'Loading…'));
      }
      return;
    }

    const checked = pendingAuto ?? saved.auto;
    const control = h('label', { class: 'updates-toggle' },
      h('input', {
        type: 'checkbox',
        checked,
        disabled: !owner || busy,
        onchange: (event: Event) => void save((event.currentTarget as HTMLInputElement).checked),
      }),
      h('span', null, 'Automatic updates'));
    const children: (Node | string)[] = [
      h('p', { class: 'updates-note' }, 'Other updates install automatically unless you turn this off.'),
      control,
    ];
    if (!owner) children.push(h('p', { class: 'updates-note updates-owner-note' }, 'Only the owner can change this.'));
    children.push(
      h('p', { class: 'updates-security' }, 'Security updates are always installed.'),
      h('p', { class: 'updates-outcome', role: outcome === 'Could not save. Try again.' ? 'alert' : 'status', 'aria-live': 'polite' }, outcome));
    root.replaceChildren(...children);
  }

  load();
  return root;
}
