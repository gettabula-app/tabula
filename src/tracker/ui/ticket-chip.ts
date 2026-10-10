import './tracker.css';
import { h } from '../../ui/dom';
import type { TrackerTicket } from '../../tracker-types';
import { stateGlyph } from './glyphs';

export interface TicketChipValue {
  key: string;
  title: string;
  stateName: string;
  stateKey: string;
  stateCategory: TrackerTicket['state']['category'];
  href: string;
}

/** Small pure projection used by comments, descriptions, and chat renderers. */
export function ticketChipValue(ticket: Pick<TrackerTicket, 'key' | 'title' | 'state'>): TicketChipValue {
  return {
    key: ticket.key,
    title: ticket.title,
    stateName: ticket.state.name,
    stateKey: ticket.state.key,
    stateCategory: ticket.state.category,
    href: `#/t/${encodeURIComponent(ticket.key)}`,
  };
}

/** DOM builder: all ticket strings remain text nodes, and the app's hash route is preserved. */
export function ticketChip(ticket: Pick<TrackerTicket, 'key' | 'title' | 'state'>): HTMLAnchorElement {
  const value = ticketChipValue(ticket);
  return h('a', {
    class: 'trk-ticket-chip', href: value.href,
    'aria-label': `${value.key}, ${value.stateName}: ${value.title}`,
  }, stateGlyph(value.stateCategory, value.stateKey), h('strong', null, value.key), h('span', null, value.title));
}
