import { h } from './dom';

/** The fixed disclosure shown over the ephemeral landing-page board. */
export function mountDemoBanner(root: HTMLElement): HTMLElement {
  const banner = h('aside', { class: 'demo-banner', role: 'note', 'data-demo-banner': '' },
    h('span', null, 'Demo: nothing is saved'),
    h('a', { href: 'https://gettabula.app', rel: 'noopener' }, 'Get Tabula'));
  root.appendChild(banner);
  return banner;
}
