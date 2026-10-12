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

  let refit: () => void = () => undefined;

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
    const head = h('span', { class: 'here-names-head' }, view.phone.head);
    const tail = h('span', { class: 'here-names-tail' }, view.phone.tail);
    tail.hidden = !view.phone.tail;
    const names = h('span', { class: 'here-names', 'aria-hidden': 'true' }, head, tail);
    parts.push(names, tip);
    cell.replaceChildren(...parts);
    refit = () => fit(names, head, tail, view);
    refit();
  }

  /**
   * On a phone (proto/designer-preview/presence/SPEC.md): the first of these that fits whole in the free width, measured now, not by
   * a breakpoint: two names and the count, one name and the count, nothing (the squares carry the count, and the cell's label has the
   * names for a screen reader). A name is never cut beside a count; with two people or fewer there is no count, and a long name may be cut.
   */
  function fit(names: HTMLElement, head: HTMLElement, tail: HTMLElement, view: NonNullable<ReturnType<typeof presenceView>>) {
    names.removeAttribute('data-fit');
    if (getComputedStyle(names).display === 'none') return; // not a phone: the hover list is the long form
    const write = (max: number) => {
      const p = view.phoneWith(max);
      head.textContent = p.head;
      tail.textContent = p.tail;
      tail.hidden = !p.tail;
    };
    write(2);
    if (!view.phone.tail) return; // at most two people: one text, cut only if one name alone is too long
    if (head.scrollWidth <= head.clientWidth) return;
    write(1);
    if (head.scrollWidth <= head.clientWidth) return;
    names.setAttribute('data-fit', 'hidden');
  }

  paint();
  if (typeof ResizeObserver === 'function') {
    // a turn of the phone or a resized row: try two names again (only the names are rewritten, so this cannot loop)
    let width = 0;
    new ResizeObserver(() => {
      if (cell.classList.contains('nobody') || Math.abs(cell.clientWidth - width) < 1) return;
      width = cell.clientWidth;
      refit();
    }).observe(cell);
  }
  const stop = store.watch(boardId, () => {
    if (!cell.isConnected) { stop(); return; }
    paint();
  });
  return cell;
}
