import './access.css';
import { watchFeatureGate } from '../feature-gate';
import type { Store } from '../store';
import { h } from './dom';

export const NEWER_TEXT = 'This board uses features from a newer Tabula. Reload to update.';

/**
 * Says so while the board lists a feature this client does not know (docs/kanban.md, Version skew). The board is
 * read-only meanwhile (main.ts); the banner goes away if the list changes.
 */
export function mountNewerBanner(store: Store, root: HTMLElement): () => void {
  let banner: HTMLElement | null = null;
  const paint = () => {
    const needed = store.unsupportedFeatures().length > 0;
    if (needed && !banner) {
      banner = h('div', { class: 'access-banner', role: 'alert' },
        h('span', { class: 'access-text' }, NEWER_TEXT),
        h('div', { class: 'access-actions' }, h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload')));
      root.appendChild(banner);
    } else if (!needed && banner) {
      banner.remove();
      banner = null;
    }
  };
  const stop = watchFeatureGate(store, paint);
  paint();
  return () => {
    stop();
    banner?.remove();
    banner = null;
  };
}
