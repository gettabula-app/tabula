import { h } from './dom';

/** The fixed disclosure shown over the ephemeral landing-page board. */
export function mountDemoBanner(root: HTMLElement): HTMLElement {
  const banner = h('aside', { class: 'demo-banner', role: 'note', 'data-demo-banner': '' },
    h('span', { class: 'demo-banner-wide-copy' }, 'Demo: nothing is saved unless you export it. Reload and it resets.'),
    h('span', { class: 'demo-banner-short-copy' }, 'Demo: nothing is saved unless you export it.'),
    h('a', { href: '/#pricing', target: '_top', rel: 'noopener' }, 'Make it yours →'));
  root.appendChild(banner);
  return banner;
}
