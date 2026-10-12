import './home-presence.css';
import type { PresenceStore } from '../presence';
import { h } from './dom';
import { presenceView, type HereSquare } from './presence-logic';

const colourStyle = (s: HereSquare) => (s.colour ? `--u:${s.colour}` : '');

/**
 * The "Here now" cell of a Boards row (proto/designer-preview/presence/SPEC.md). Always present, so the grid cell and the row
 * height stay put; empty when nobody else is on the board. It redraws in place when the store says the list changed, and
 * stops watching once it is off the page. The cluster is not a control: a click on it goes to the row's link.
 */
export function presenceCell(store: PresenceStore, boardId: string, link: () => HTMLElement | null): HTMLElement {
  const cell = h('span', { class: 'board-here nobody' });
  cell.addEventListener('click', (e) => {
    const target = link();
    if (!target) return;
    e.preventDefault();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: e.button, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey }));
  });

  function paint() {
    const view = presenceView(store.get(boardId));
    if (!view) {
      cell.classList.add('nobody');
      cell.removeAttribute('role');
      cell.removeAttribute('aria-label');
      cell.replaceChildren();
      return;
    }
    cell.classList.remove('nobody');
    cell.setAttribute('role', 'img');
    // updated in place, not a live region: a person arriving must not be announced over whatever is being read
    cell.setAttribute('aria-label', view.label);
    const square = (s: HereSquare) => {
      const el = h('span', { class: `here-sq${s.colour ? '' : ' plain'}`, 'aria-hidden': 'true' }, s.initial);
      if (s.colour) el.setAttribute('style', colourStyle(s));
      return el;
    };
    const tip = h('span', { class: 'here-tip', 'aria-hidden': 'true' }, ...view.all.map((s) => {
      const chip = h('i', { class: s.colour ? '' : 'plain' });
      if (s.colour) chip.setAttribute('style', colourStyle(s));
      const row = h('span', { class: 'here-tip-row' }, chip);
      row.append(document.createTextNode(s.guest ? `${s.name} (guest)` : s.name));
      return row;
    }), view.unnamed > 0 ? h('span', { class: 'here-tip-row' }, `and ${view.unnamed} more`) : null);
    const parts: Node[] = view.squares.map(square);
    if (view.you) parts.push(h('span', { class: 'here-sq you', 'aria-hidden': 'true' }, 'You'));
    if (view.more > 0) parts.push(h('span', { class: 'here-more', 'aria-hidden': 'true' }, `+${view.more}`));
    parts.push(h('span', { class: 'here-names', 'aria-hidden': 'true' }, view.names), tip);
    cell.replaceChildren(...parts);
  }

  paint();
  const stop = store.watch(boardId, () => {
    if (!cell.isConnected) { stop(); return; }
    paint();
  });
  return cell;
}
