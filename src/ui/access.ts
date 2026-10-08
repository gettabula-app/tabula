import './access.css';
import { h, icon } from './dom';
import type { BoardConn, DeniedReason } from '../sync';

interface AccessHandlers {
  onSignIn: () => void;
  onRemoveLocal: () => void | Promise<void>;
  onHome: () => void;
}

const TEXT: Record<DeniedReason, string> = {
  unauthenticated: 'Your session has ended. Sign in again to keep syncing this board.',
  no_access: "You don't have access to this board.",
  not_found: "This board doesn't exist on the server.",
  access_removed: 'Your access to this board was removed. Your copy on this device is still here.',
};

/** Shows why the relay stopped syncing this board. Local data is never removed here. */
export function mountAccessBanner(conn: BoardConn, root: HTMLElement, handlers: AccessHandlers): () => void {
  let banner: HTMLElement | null = null;
  const dismiss = () => {
    banner?.remove();
    banner = null;
  };
  const unsubscribe = conn.onDenied((reason) => {
    dismiss();
    banner = renderBanner(reason, handlers, dismiss);
    root.appendChild(banner);
  });
  return () => {
    unsubscribe();
    dismiss();
  };
}

function renderBanner(reason: DeniedReason, handlers: AccessHandlers, dismiss: () => void): HTMLElement {
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
  }
  return h('div', { class: 'access-banner', role: 'alert' },
    h('span', { class: 'access-text' }, TEXT[reason]),
    h('div', { class: 'access-actions' }, actions),
    h('button', { class: 'icon-btn', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: dismiss }, icon('close', 18)),
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
