import './workspace.css';
import { authState, onAuth } from '../auth';
import { bannerText, workspaceOf } from '../cloud-logic';
import { h } from './dom';

/**
 * The thin line a hosted workspace's operator can put above the app (docs/cloud.md). It follows the signed-in user's
 * /api/me, so a banner that arrives with the next refresh appears without a reload, and it stops listening once it
 * has been removed from the page. `onVisible` tells the page whether there is a banner to make room for.
 */
export function createWorkspaceBanner(onVisible?: (visible: boolean) => void): { el: HTMLElement; dispose: () => void } {
  const el = h('div', { class: 'workspace-banner', role: 'status' });
  const paint = () => {
    const text = bannerText(workspaceOf(authState()));
    el.textContent = text ?? '';
    el.title = text ?? '';
    el.hidden = text === null;
    onVisible?.(text !== null);
  };
  const dispose = onAuth(() => {
    if (el.isConnected) paint();
    else dispose();
  });
  paint();
  return { el, dispose };
}
