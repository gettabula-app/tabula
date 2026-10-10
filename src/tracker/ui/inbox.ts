import './tracker.css';
import type { TrackerApi } from '../../tracker-data';
import { h } from '../../ui/dom';

export function mountInbox(host: HTMLElement, deps: {
  api: TrackerApi;
  onOpenTicket(key: string): void;
  onUnreadChange(n: number): void;
  now?: () => number;
}): { refresh(): Promise<void>; focus(): void; destroy(): void } {
  const message = h('section', { class: 'trk-coming-next', 'aria-label': 'Inbox' },
    h('p', null, 'Not available yet.'));
  host.replaceChildren(message);
  deps.onUnreadChange(0);
  return {
    async refresh() { deps.onUnreadChange(0); },
    focus() { message.focus?.(); },
    destroy() { message.remove(); },
  };
}
