import { URL_REFUSAL_TEXT, normaliseUrl } from '../link-cards';
import type { BoardApp } from '../app';
import { h } from './dom';
import { popover } from './common';

/**
 * The Link choice in the Text/Markdown/Link rail group: a small popover with an address field. Enter adds, Esc cancels and
 * returns focus to the button. A refused address says why under the field; the card lands at the view centre, selected.
 */
export function openLinkPopover(app: BoardApp, anchor: HTMLElement): void {
  const input = h('input', { class: 'input link-field', type: 'url', placeholder: 'https://', 'aria-label': 'Web address', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  const problem = h('p', { class: 'link-problem', id: 'link-problem', role: 'alert', hidden: true });
  const previews = app.links.previewsOn();
  const hint = h('p', { class: 'link-hint' }, previews ? 'Press Add to put a link card on the board.' : 'Previews are off. The card shows the address only.');
  input.setAttribute('aria-describedby', 'link-problem');
  let pop: ReturnType<typeof popover> | null = null;

  const add = async () => {
    const n = normaliseUrl(input.value);
    if (!n.ok) {
      if (n.reason === 'empty') {
        problem.hidden = true;
        input.removeAttribute('aria-invalid');
        input.focus();
        return;
      }
      problem.textContent = URL_REFUSAL_TEXT[n.reason];
      problem.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    pop?.close();
    const vp = app.r.viewport();
    await app.links.addUrls([n.url], { at: { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 }, source: 'button' });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void add();
    }
  });
  input.addEventListener('input', () => {
    problem.hidden = true;
    input.removeAttribute('aria-invalid');
  });

  const body = h('div', { class: 'link-pop' },
    h('label', { class: 'link-label' }, 'Link'),
    input,
    problem,
    hint,
    h('div', { class: 'link-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => pop?.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => void add() }, 'Add')),
  );
  anchor.classList.add('on');
  pop = popover(anchor, body, { side: 'right', className: 'link-popover', label: 'Link', onClose: () => anchor.classList.remove('on') });
  input.focus();
}
