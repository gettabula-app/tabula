import './link-previews-admin.css';
import { ApiError, api, type AdminLinkPreviews, type Me } from '../api';
import { setSignedOut } from '../auth';
import { h } from './dom';

// The copy is the designer's (proto/designer-preview/link-cards/SPEC.md, Admin row), CGO-approved.
export const LINK_PREVIEWS_COPY = {
  heading: 'Link previews',
  hosted: "When someone adds a link to a board, show its title, description and image. Our server fetches the page once; nobody's browser contacts the linked site until they open it.",
  self: 'When someone adds a link to a board, show its title, description and image. Links still work without it.',
  note: "Turning this on makes your server request web pages on people's behalf. If it runs next to internal services, list their addresses in TABULA_LINK_PREVIEW_DENY first.",
  locked: "Turned off in the server's settings.",
  loadFailed: 'Could not load this setting.',
  retry: 'Try again',
  saved: 'Saved.',
  saveFailed: 'Could not save. Try again.',
  loading: 'Loading...',
} as const;

/** The workspace switch for link previews (docs/link-cards.md). Admins read and change it; the operator's switch can turn it off for good. */
export function linkPreviewsAdminPanel(me: Me): HTMLElement {
  const root = h('section', { class: 'lp-admin', 'aria-labelledby': 'lp-heading' });
  const hosted = me.workspace !== undefined;
  let saved: AdminLinkPreviews | null = null;
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
    void api.adminLinkPreviews().then((state) => {
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
      saved = await api.setAdminLinkPreviews(enabled);
      outcome = LINK_PREVIEWS_COPY.saved;
    } catch (error) {
      if (!leaveOnAuthError(error)) outcome = LINK_PREVIEWS_COPY.saveFailed;
    } finally {
      busy = false;
      pending = null;
      render();
    }
  };

  function render() {
    const head = h('h2', { class: 'lp-heading', id: 'lp-heading' }, LINK_PREVIEWS_COPY.heading);
    if (!saved) {
      root.replaceChildren(head, failed
        ? h('div', { class: 'admin-state admin-error', role: 'alert' }, h('span', null, LINK_PREVIEWS_COPY.loadFailed), h('button', { class: 'btn', type: 'button', onclick: load }, LINK_PREVIEWS_COPY.retry))
        : h('p', { class: 'admin-state muted', role: 'status' }, LINK_PREVIEWS_COPY.loading));
      return;
    }
    const on = pending ?? saved.enabled;
    const sw = h('button', {
      class: `lp-switch${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': 'Link previews', 'aria-busy': busy ? 'true' : undefined, disabled: saved.locked,
      onclick: () => void save(!on),
    }, h('span', { class: 'lp-thumb', 'aria-hidden': 'true' }));
    const focus = document.activeElement === root.querySelector('.lp-switch');
    const parts: Node[] = [h('div', { class: 'lp-row' }, head, sw), h('p', { class: 'lp-text' }, hosted ? LINK_PREVIEWS_COPY.hosted : LINK_PREVIEWS_COPY.self)];
    if (saved.locked) parts.push(h('p', { class: 'lp-locked' }, LINK_PREVIEWS_COPY.locked));
    if (!hosted && !on && !saved.locked) parts.push(h('p', { class: 'lp-note' }, LINK_PREVIEWS_COPY.note));
    parts.push(h('p', { class: 'lp-outcome', role: 'status' }, outcome));
    root.replaceChildren(...parts);
    if (focus) root.querySelector<HTMLElement>('.lp-switch')?.focus();
  }

  load();
  return root;
}
