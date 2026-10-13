// The language list of a code block (docs/code-blocks.md): a popover with a search field and the languages as radio items, Plain text first, then the twelve
// common ones, then the rest by name. On a phone it is a full-height sheet (code-controls.css).
import './code-controls.css';
import { CODE_STRINGS } from '../code-strings';
import { filterCodeLangs, orderedCodeLangs } from '../code-ui-logic';
import { popover } from './common';
import { h, icon } from './dom';

export function openCodeLangPicker(anchor: HTMLElement, current: string, onPick: (id: string) => void): { close: () => void; el: HTMLElement } {
  const all = orderedCodeLangs();
  const search = h('input', {
    class: 'input code-lang-search', type: 'search', placeholder: CODE_STRINGS.searchLanguages, 'aria-label': CODE_STRINGS.searchLanguages,
    autocomplete: 'off', spellcheck: 'false',
  });
  const list = h('div', { class: 'code-lang-list', role: 'menu', 'aria-label': CODE_STRINGS.language });
  const empty = h('div', { class: 'code-lang-empty', role: 'status', hidden: true }, CODE_STRINGS.noLanguage);
  let close: () => void = () => {};
  const items = () => [...list.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  const paint = () => {
    const rows = filterCodeLangs(all, search.value);
    list.replaceChildren(...rows.map((row) => h('button', {
      class: 'menu-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(row.id === current), 'data-lang': row.id,
      onclick: () => {
        close();
        onPick(row.id);
      },
    }, h('span', null, row.label), row.id === current ? icon('check', 16) : null)));
    empty.hidden = rows.length > 0;
  };
  search.addEventListener('input', paint);
  const move = (e: KeyboardEvent) => {
    const rows = items();
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows[at < 0 ? 0 : Math.min(rows.length - 1, at + 1)].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (at <= 0) search.focus();
      else rows[at - 1].focus();
    } else if (e.key === 'Home' && at >= 0) {
      e.preventDefault();
      rows[0].focus();
    } else if (e.key === 'End' && at >= 0) {
      e.preventDefault();
      rows[rows.length - 1].focus();
    } else if (e.key === 'Enter' && document.activeElement === search) {
      e.preventDefault();
      rows[0].click();
    }
  };
  const body = h('div', { class: 'code-lang' }, search, list, empty);
  body.addEventListener('keydown', move);
  paint();
  const opened = popover(anchor, body, { side: 'bottom', className: 'code-lang-pop', label: CODE_STRINGS.language, role: 'dialog' });
  close = opened.close;
  // the current language is in view when the list opens
  requestAnimationFrame(() => list.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' }));
  return opened;
}
