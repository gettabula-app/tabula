import { h } from './dom';

/** A visible marker for names that came from a guest session rather than a workspace account. */
export function guestMark(className: string): HTMLElement {
  return h('span', { class: className }, 'Guest');
}
