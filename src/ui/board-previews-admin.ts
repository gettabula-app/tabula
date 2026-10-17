import './link-previews-admin.css';
import { ApiError, api, type AdminBoardPreviews } from '../api';
import { setSignedOut } from '../auth';
import { h } from './dom';

const COPY = {
  heading: 'Board pictures',
  description: "When this is on, each board card on the Boards page shows a small picture of the board. A board's owner can still turn it off for that board.",
  locked: 'Turned off in the server settings.',
  loadFailed: 'Could not load this setting.',
  retry: 'Try again',
  saved: 'Saved.',
  saveFailed: 'Could not save. Try again.',
  loading: 'Loading…',
} as const;

/** The workspace default for board pictures. */
export function boardPreviewsAdminPanel(): HTMLElement {
  const root = h('section', { class: 'lp-admin', 'aria-labelledby': 'board-previews-heading' });
  let saved: AdminBoardPreviews | null = null;
  let failed = false;
  let busy = false;
  let pending: boolean | null = null;
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
    void api.adminBoardPreviews().then((state) => {
      saved = state;
      render();
    }, (error: unknown) => {
      if (leaveOnAuthError(error)) return;
      failed = true;
      render();
    });
  };

  const save = async (enabled: boolean) => {
    if (!saved || busy || saved.locked) return;
    pending = enabled;
    busy = true;
    outcome = '';
    render();
    try {
      saved = await api.setAdminBoardPreviews(enabled);
      outcome = COPY.saved;
    } catch (error) {
      if (!leaveOnAuthError(error)) outcome = COPY.saveFailed;
    } finally {
      busy = false;
      pending = null;
      render();
    }
  };

  function render() {
    const heading = h('h2', { class: 'lp-heading', id: 'board-previews-heading' }, COPY.heading);
    if (!saved) {
      root.replaceChildren(heading, failed
        ? h('div', { class: 'admin-state admin-error', role: 'alert' }, h('span', null, COPY.loadFailed), h('button', { class: 'btn', type: 'button', onclick: load }, COPY.retry))
        : h('p', { class: 'admin-state muted', role: 'status' }, COPY.loading));
      return;
    }
    const on = pending ?? saved.enabled;
    const switcher = h('button', {
      class: `lp-switch${on ? ' on' : ''}`,
      type: 'button',
      role: 'switch',
      'aria-checked': String(on),
      'aria-label': COPY.heading,
      'aria-busy': busy ? 'true' : undefined,
      disabled: saved.locked,
      onclick: () => void save(!on),
    });
    const focus = document.activeElement === root.querySelector('.lp-switch');
    const parts: Node[] = [h('div', { class: 'lp-row' }, heading, switcher), h('p', { class: 'lp-text' }, COPY.description)];
    if (saved.locked) parts.push(h('p', { class: 'lp-locked' }, COPY.locked));
    parts.push(h('p', { class: 'lp-outcome', role: 'status' }, outcome));
    root.replaceChildren(...parts);
    if (focus) root.querySelector<HTMLElement>('.lp-switch')?.focus();
  }

  load();
  return root;
}
