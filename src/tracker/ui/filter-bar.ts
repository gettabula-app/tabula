import { h } from '../../ui/dom';
import { build, filterChipLabel, parse, type FilterChip, type FilterField } from './filter';
import './tracker.css';

const FILTER_FIELDS: FilterField[] = ['assignee', 'state', 'label', 'due', 'has', 'is', 'created', 'project', 'milestone'];
let filterBarSequence = 0;

export interface FilterBarOptions {
  initial?: readonly FilterChip[];
  onChange?: (chips: readonly FilterChip[]) => void;
  onSearch?: (query: string) => void;
}

export interface FilterBarController {
  el: HTMLElement;
  open(): void;
  close(): void;
  setChips(chips: readonly FilterChip[]): void;
  getChips(): FilterChip[];
  focusSearch(): void;
}

/** Keyboard-first filter editor: type a field, Tab to its value, Enter to add, and Backspace in an empty box to remove. */
export function createFilterBar(options: FilterBarOptions = {}): FilterBarController {
  let chips = [...(options.initial ?? [])];
  const filterButton = h('button', {
    class: 'trk-filter-button', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'trk-filter-editor', 'aria-keyshortcuts': 'F',
  }, 'Filter');
  const chipsEl = h('div', { class: 'trk-filter-chips', 'aria-label': 'Active filters' });
  const fieldListId = `trk-filter-fields-${++filterBarSequence}`;
  const fieldInput = h('input', {
    class: 'trk-filter-field', type: 'text', list: fieldListId, placeholder: 'Filter field',
    'aria-label': 'Filter field', autocomplete: 'off', spellcheck: 'false',
  });
  const fieldList = h('datalist', { id: fieldListId }, ...FILTER_FIELDS.map((field) => h('option', { value: field })));
  const valueInput = h('input', {
    class: 'trk-filter-value', type: 'text', placeholder: 'Filter value', 'aria-label': 'Filter value',
    autocomplete: 'off', spellcheck: 'false',
  });
  const editor = h('div', { class: 'trk-filter-editor', id: 'trk-filter-editor', hidden: true }, fieldInput, fieldList, valueInput);
  const searchInput = h('input', {
    class: 'trk-search-input', type: 'search', placeholder: 'Search issues', 'aria-label': 'Search tickets',
    autocomplete: 'off', spellcheck: 'false',
  });
  const searchWrap = h('div', { class: 'trk-filter-search-wrap' }, searchInput);
  const root = h('div', { class: 'trk trk-filter-bar', role: 'search', 'aria-label': 'Tracker filters' }, filterButton, chipsEl, editor, searchWrap);

  const emit = () => options.onChange?.([...chips]);
  const renderChips = () => {
    chipsEl.replaceChildren(...chips.map((chip, index) => {
      const label = filterChipLabel(chip);
      return h('span', { class: 'trk-filter-chip' },
        h('span', null, label),
        h('button', {
          type: 'button', 'aria-label': `Remove ${label}`, onclick: () => removeAt(index),
        }, '×'),
      );
    }));
  };
  const removeAt = (index: number) => {
    if (index < 0 || index >= chips.length) return;
    chips.splice(index, 1);
    renderChips();
    emit();
  };
  const emptyValueFor = (field: string) => field === 'has' ? 'link' : field === 'is' ? 'archived' : '';
  const setField = (raw: string) => {
    const field = raw.trim().toLowerCase();
    if (!FILTER_FIELDS.includes(field as FilterField)) return false;
    fieldInput.value = field;
    valueInput.value = emptyValueFor(field);
    valueInput.placeholder = field === 'due' ? 'overdue, today, before-YYYY-MM-DD' : field === 'created' ? 'after-YYYY-MM-DD' : field === 'has' ? 'link' : field === 'is' ? 'archived' : 'Value';
    return true;
  };
  const addChip = () => {
    const field = fieldInput.value.trim().toLowerCase();
    const value = valueInput.value.trim();
    if (!value) return false;
    let chip: FilterChip;
    try { [chip] = parse([`${field}:${value}`]); } catch { valueInput.setAttribute('aria-invalid', 'true'); return false; }
    valueInput.removeAttribute('aria-invalid');
    chips.push(chip);
    renderChips();
    emit();
    fieldInput.value = '';
    valueInput.value = '';
    valueInput.placeholder = 'Filter value';
    fieldInput.focus();
    return true;
  };

  filterButton.addEventListener('click', () => {
    if (editor.hidden) controller.open();
    else controller.close();
  });
  fieldInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Tab' && !event.shiftKey) {
      if (setField(fieldInput.value)) {
        event.preventDefault();
        valueInput.focus();
      }
    } else if (event.key === 'Enter' && setField(fieldInput.value) && valueInput.value) {
      event.preventDefault();
      addChip();
    } else if (event.key === 'Backspace' && !fieldInput.value && chips.length) {
      event.preventDefault();
      removeAt(chips.length - 1);
    }
  });
  valueInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addChip();
    } else if (event.key === 'Backspace' && !valueInput.value && chips.length) {
      event.preventDefault();
      removeAt(chips.length - 1);
    }
  });
  searchInput.addEventListener('input', () => options.onSearch?.(searchInput.value));
  searchInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Backspace' && !searchInput.value && chips.length) {
      event.preventDefault();
      removeAt(chips.length - 1);
    }
  });

  const controller: FilterBarController = {
    el: root,
    open() {
      editor.hidden = false;
      filterButton.setAttribute('aria-expanded', 'true');
      fieldInput.focus();
    },
    close() {
      editor.hidden = true;
      filterButton.setAttribute('aria-expanded', 'false');
    },
    setChips(next) {
      build(next);
      chips = [...next];
      renderChips();
      emit();
    },
    getChips() { return [...chips]; },
    focusSearch() { searchInput.focus(); },
  };
  renderChips();
  return controller;
}
