import './tracker.css';
import type { TrackerStore } from '../../tracker-data';
import { h } from '../../ui/dom';

export function mountTicketPage(host: HTMLElement, opts: {
  store: TrackerStore;
  key: string;
  mode: 'page' | 'peek';
  onClose(): void;
  onNavigate(key: string): void;
  me: { userId: string; canWrite: boolean };
}): { destroy(): void; focus(): void } {
  const title = h('p', null, opts.store.ticket(opts.key).ticket?.title ?? opts.key);
  const page = h('section', {
    class: `trk-ticket-stub trk-ticket-page trk-ticket-page-${opts.mode}`,
    'aria-label': `Ticket ${opts.key}`,
    tabindex: '-1',
  },
  h('button', { class: 'trk-ticket-back', type: 'button', onclick: opts.onClose }, '← Back'),
  h('h1', null, opts.key),
  title,
  h('p', { class: 'trk-muted' }, 'Ticket page: next tracker slice'));
  const stop = opts.store.watchTicket(opts.key, (state) => {
    title.textContent = state.ticket?.title ?? opts.key;
  });
  host.replaceChildren(page);
  return {
    destroy() { stop(); page.remove(); },
    focus() { page.focus({ preventScroll: true }); },
  };
}
