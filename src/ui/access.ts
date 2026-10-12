import './access.css';
import { h, icon } from './dom';
import { showRestoring } from './restoring';
import type { BoardConn, DeniedReason } from '../sync';
import { authState } from '../auth';
import { isRemovedGuestLink } from './share-logic';

const REMOVED_GUEST_LINK = 'This join link has expired or was revoked';

interface AccessHandlers {
  onSignIn: () => void;
  onRemoveLocal: () => void | Promise<void>;
  onHome: () => void;
}

const TEXT: Record<Exclude<DeniedReason, 'restoring'>, string> = {
  unauthenticated: 'Your session has ended. Sign in again to keep syncing this board.',
  no_access: "You don't have access to this board, or it no longer exists.",
  not_found: "This board doesn't exist on the server.",
  access_removed: 'Your access to this board was removed. Your copy on this device is still here.',
  too_large: 'This board is too large to sync, or a change was too big to send. Your copy on this device is safe; reload to try again.',
  rate_limited: 'You are sending changes too fast. Syncing will retry shortly; your changes stay on this device.',
  too_many_connections: 'Too many connections from this account. Close other tabs or devices; syncing will retry shortly.',
};

/**
 * Shows why the relay stopped syncing this board. Local data is never removed here. A restore (close code 4503) is not
 * a refusal: the restoring screen takes over, waits for the server and reloads.
 */
export function mountAccessBanner(conn: BoardConn, root: HTMLElement, handlers: AccessHandlers): () => void {
  let banner: HTMLElement | null = null;
  const dismiss = () => {
    banner?.remove();
    banner = null;
  };
  const unsubscribe = conn.onDenied((reason) => {
    dismiss();
    if (reason === 'restoring') {
      showRestoring();
      return;
    }
    banner = renderBanner(reason, handlers, dismiss, isRemovedGuestLink(authState().mode, reason));
    root.appendChild(banner);
  });
  // a limit that passed (retry connected again) takes its message away
  // (a minimal connection without status events, as in some tests, simply has no retry to follow)
  const unsubscribeStatus = conn.onStatus?.((s) => { if (s === 'live') dismiss(); }) ?? (() => undefined);
  return () => {
    unsubscribe();
    unsubscribeStatus();
    dismiss();
  };
}

function renderBanner(reason: Exclude<DeniedReason, 'restoring'>, handlers: AccessHandlers, dismiss: () => void, removedGuestLink: boolean): HTMLElement {
  const actions: HTMLElement[] = [];
  switch (reason) {
    case 'unauthenticated':
      actions.push(h('button', { class: 'btn primary', onclick: handlers.onSignIn }, 'Sign in'));
      break;
    case 'no_access':
    case 'not_found':
      actions.push(h('button', { class: 'btn primary', onclick: handlers.onHome }, 'Back to boards'));
      break;
    case 'access_removed':
      actions.push(removeButton(handlers.onRemoveLocal));
      break;
    case 'too_large':
      actions.push(h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload'));
      break;
  }
  return h('div', { class: 'access-banner', role: 'alert' },
    h('span', { class: 'access-text' }, removedGuestLink ? REMOVED_GUEST_LINK : TEXT[reason]),
    h('div', { class: 'access-actions' }, actions),
    h('button', { class: 'icon-btn', 'aria-label': 'Dismiss', onclick: dismiss }, icon('close', 18)),
  );
}

function removeButton(onRemove: () => void | Promise<void>): HTMLButtonElement {
  const label = 'Remove from this device';
  const button = h('button', { class: 'btn' }, label);
  let armed = false;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Click again to confirm';
      return;
    }
    button.disabled = true;
    try {
      await onRemove();
    } finally {
      button.disabled = false;
      armed = false;
      button.textContent = label;
    }
  });
  return button;
}
