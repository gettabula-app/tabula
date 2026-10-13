import './template-picker.css';
import type { BoardApp } from '../app';
import { authState } from '../auth';
import { TEMPLATES, insertCustomTemplate, insertTemplate, type TemplateDef } from '../templates';
import type { CustomTemplate } from '../custom-templates';
import { listTemplates, onTemplatesChange } from '../template-store';
import { accountId, splitMine } from '../template-share';
import { builtinThumbnail } from '../template-thumb';
import { customThumbnail } from './templates-page';
import { announce } from './announce';
import { dialog, toast } from './common';
import { h, icon } from './dom';
import { kbdHint } from './kbd';
import { reopenSession } from './idle-bar';
import {
  countTemplatePickerEntries,
  filterTemplatePickerEntries,
  type TemplatePickerEntry,
  type TemplatePickerFilter,
} from './template-picker-logic';

type TemplateValue = TemplateDef | CustomTemplate;
type PickerItem = TemplatePickerEntry & { kind: 'builtin' | 'custom'; template: TemplateValue };

let pickerSequence = 0;

const TONE_BY_CATEGORY: Record<string, string> = {
  retrospective: 'yellow',
  prioritisation: 'yellow',
  planning: 'blue',
  discussion: 'blue',
  strategy: 'blue',
  ideation: 'green',
  discovery: 'green',
  risk: 'red',
  custom: 'yellow',
};

const toneFor = (category: string) => TONE_BY_CATEGORY[category.toLowerCase()] ?? 'yellow';

function allItems(saved: CustomTemplate[]): PickerItem[] {
  const { mine, shared } = splitMine(saved, accountId(authState()));
  return [
    ...TEMPLATES.map((template): PickerItem => ({
      id: `builtin:${template.id}`, kind: 'builtin', source: 'builtin', template,
      name: template.name, description: template.description, category: template.category,
    })),
    ...mine.map((template): PickerItem => ({
      id: `custom:${template.id}`, kind: 'custom', source: 'mine', template,
      name: template.name, description: template.description, category: template.category,
    })),
    ...shared.map((template): PickerItem => ({
      id: `custom:${template.id}`, kind: 'custom', source: 'shared', template,
      name: template.name, description: template.description, category: template.category,
    })),
  ];
}

function sameFilter(a: TemplatePickerFilter, b: TemplatePickerFilter): boolean {
  return a.kind === b.kind && (a.kind !== 'category' || (b.kind === 'category' && a.category === b.category));
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'template' : 'templates'} found`;
}

/** Opens the template picker over the board. Closing the shared dialog returns focus to its opener. */
export function openTemplatePicker(app: BoardApp, onClose?: () => void) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  opener?.setAttribute('aria-haspopup', 'dialog');
  opener?.setAttribute('aria-expanded', 'true');
  if (opener?.matches('[data-drawer="templates"]')) opener.classList.add('on');

  const idPrefix = `template-picker-${++pickerSequence}`;
  let items = allItems([]);
  let filter: TemplatePickerFilter = { kind: 'all' };
  let selectedId: string | null = items[0]?.id ?? null;
  let isClosed = false;
  let releaseTemplates = () => {};
  let loadSequence = 0;

  const search = h('input', {
    class: 'input template-picker-search-input',
    type: 'search',
    placeholder: 'Search templates',
    'aria-label': 'Search templates',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'true',
    'aria-controls': `${idPrefix}-listbox`,
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const searchWrap = h('label', { class: 'template-picker-search' },
    h('span', { class: 'sr-only' }, 'Search templates'),
    h('span', { class: 'template-picker-search-icon', 'aria-hidden': 'true' }, icon('search', 17)),
    search,
  );
  const categories = h('nav', { class: 'template-picker-categories', 'aria-label': 'Template categories' });
  const listbox = h('div', { class: 'template-picker-grid', id: `${idPrefix}-listbox`, role: 'listbox', 'aria-label': 'Templates' });
  const noResults = h('div', { class: 'template-picker-empty', hidden: true },
    h('p', null, 'No templates match'),
    h('button', { type: 'button', class: 'template-picker-clear' }, 'Clear search'),
  );
  const content = h('div', { class: 'template-picker-content' }, categories, listbox, noResults);
  const body = h('div', { class: 'template-picker-layout' }, searchWrap, content);
  const footer = h('footer', { class: 'modal-actions template-picker-footer' },
    h('div', { class: 'template-picker-hint', 'aria-label': 'Browse with arrow keys and use with Enter' },
      h('span', null, 'Browse'), kbdHint('↑'), kbdHint('↓'), h('span', null, 'Use'), kbdHint('↵')),
    h('div', { class: 'template-picker-actions' },
      h('button', { type: 'button', class: 'template-picker-blank' }, 'Start from blank'),
      h('button', { type: 'button', class: 'btn primary template-picker-use' }, 'Use template'),
    ),
  );

  const modal = dialog('Start from a template', body, [], {
    className: 'template-picker-back',
    onClose: () => {
      isClosed = true;
      releaseTemplates();
      opener?.setAttribute('aria-expanded', 'false');
      if (opener?.matches('[data-drawer="templates"]')) opener.classList.remove('on');
      onClose?.();
    },
  });
  const box = modal.box;
  box.classList.add('template-picker', 'template-picker-dialog');
  box.insertBefore(h('div', { class: 'template-picker-grabber', 'aria-hidden': 'true' }, h('span')), box.firstChild);
  box.appendChild(footer);

  const useButton = footer.querySelector<HTMLButtonElement>('.template-picker-use')!;
  const clearButton = body.querySelector<HTMLButtonElement>('.template-picker-clear')!;
  const list = () => filterTemplatePickerEntries(items, search.value, filter);

  const paintSelection = () => {
    const cards = Array.from(listbox.querySelectorAll<HTMLButtonElement>('.template-picker-card'));
    let active: HTMLButtonElement | undefined;
    for (const card of cards) {
      const selected = card.dataset.entryId === selectedId;
      card.setAttribute('aria-selected', String(selected));
      card.tabIndex = selected ? 0 : -1;
      card.classList.toggle('is-selected', selected);
      if (selected) active = card;
    }
    if (active) {
      listbox.setAttribute('aria-activedescendant', active.id);
      search.setAttribute('aria-activedescendant', active.id);
    } else {
      listbox.removeAttribute('aria-activedescendant');
      search.removeAttribute('aria-activedescendant');
    }
    useButton.disabled = !active;
  };

  const announceCount = () => announce(countLabel(list().length), { key: `${idPrefix}-results`, delay: 240 });

  const renderCategories = () => {
    const counts = countTemplatePickerEntries(items);
    const categoryFilters: { label: string; count: number; filter: TemplatePickerFilter }[] = [
      { label: 'All', count: counts.all, filter: { kind: 'all' } },
      ...[...counts.categories].map(([category, count]) => ({ label: category, count, filter: { kind: 'category' as const, category } })),
      ...(counts.mine ? [{ label: 'My templates', count: counts.mine, filter: { kind: 'mine' as const } }] : []),
      ...(counts.shared ? [{ label: 'Shared with me', count: counts.shared, filter: { kind: 'shared' as const } }] : []),
    ];
    const list = h('ul', null, ...categoryFilters.map(({ label, count, filter: target }) => {
      const active = sameFilter(filter, target);
      const button = h('button', {
        type: 'button',
        class: `template-picker-category${active ? ' is-selected' : ''}`,
        'aria-pressed': String(active),
        onclick: () => {
          filter = target;
          update();
          announceCount();
        },
      }, h('span', null, label), h('small', null, String(count)));
      return h('li', null, button);
    }));
    categories.replaceChildren(list);
  };

  const makeCard = (entry: PickerItem, index: number) => {
    const thumb = entry.kind === 'builtin'
      ? builtinThumbnail(entry.template as TemplateDef)
      : customThumbnail(entry.template as CustomTemplate);
    const card = h('button', {
      type: 'button',
      id: `${idPrefix}-option-${index}`,
      class: 'template-picker-card',
      role: 'option',
      'aria-selected': 'false',
      'data-entry-id': entry.id,
      'data-category': entry.category,
      tabindex: '-1',
    },
    h('span', { class: 'template-picker-preview', 'aria-hidden': 'true', html: thumb }),
    h('span', { class: 'template-picker-card-copy' },
      h('span', { class: 'template-picker-card-name' }, entry.name),
      h('span', { class: 'template-picker-card-description' }, entry.description || entry.category),
      h('span', { class: `tag tag-${toneFor(entry.category)}` }, entry.category)),
    ) as HTMLButtonElement;
    card.addEventListener('click', () => {
      selectedId = entry.id;
      paintSelection();
    });
    card.addEventListener('focus', () => {
      selectedId = entry.id;
      paintSelection();
    });
    card.addEventListener('dblclick', () => use(entry));
    return card;
  };

  function update() {
    const shown = list();
    if (!shown.some((entry) => entry.id === selectedId)) selectedId = shown[0]?.id ?? null;
    renderCategories();
    listbox.replaceChildren(...shown.map(makeCard));
    listbox.hidden = shown.length === 0;
    noResults.hidden = shown.length > 0;
    paintSelection();
  }

  function selectByOffset(offset: number, focus = false) {
    const shown = list();
    if (!shown.length) return;
    const index = shown.findIndex((entry) => entry.id === selectedId);
    const next = index < 0 ? (offset > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, index + offset));
    selectedId = shown[next].id;
    paintSelection();
    if (focus) listbox.querySelector<HTMLButtonElement>(`#${idPrefix}-option-${next}`)?.focus({ preventScroll: true });
  }

  function use(entry?: PickerItem) {
    const chosen = entry ?? list().find((item) => item.id === selectedId);
    if (!chosen) return;
    if (chosen.kind === 'builtin') {
      const template = chosen.template as TemplateDef;
      reopenSession(app.user.id, app.conn.id);
      insertTemplate(app, template);
      modal.close();
      toast(`${template.name} added. Start the session from the bar at the bottom.`);
      return;
    }
    const template = chosen.template as CustomTemplate;
    insertCustomTemplate(app, template);
    modal.close();
    toast(template.content.steps.length
      ? `${template.name} added. Start the session from the bar at the bottom.`
      : `${template.name} added.`);
  }

  search.addEventListener('input', () => {
    update();
    announceCount();
  });
  search.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectByOffset(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectByOffset(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      use();
    }
  });
  listbox.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectByOffset(event.key === 'ArrowDown' ? 1 : -1, true);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const shown = list();
      if (!shown.length) return;
      const index = event.key === 'Home' ? 0 : shown.length - 1;
      selectedId = shown[index].id;
      paintSelection();
      listbox.querySelector<HTMLButtonElement>(`#${idPrefix}-option-${index}`)?.focus({ preventScroll: true });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      use();
    }
  });
  clearButton.addEventListener('click', () => {
    search.value = '';
    filter = { kind: 'all' };
    update();
    announceCount();
    search.focus({ preventScroll: true });
  });
  footer.querySelector<HTMLButtonElement>('.template-picker-blank')!.addEventListener('click', () => modal.close());
  useButton.addEventListener('click', () => use());

  update();
  releaseTemplates = onTemplatesChange(() => void loadSavedTemplates());
  void loadSavedTemplates();

  async function loadSavedTemplates() {
    const load = ++loadSequence;
    const saved = await listTemplates();
    if (isClosed || load !== loadSequence) return;
    items = allItems(saved);
    const selectedFilter = filter;
    if (selectedFilter.kind === 'category' && !items.some((item) => item.category === selectedFilter.category)) filter = { kind: 'all' };
    if (selectedFilter.kind === 'mine' && !items.some((item) => item.source === 'mine')) filter = { kind: 'all' };
    if (selectedFilter.kind === 'shared' && !items.some((item) => item.source === 'shared')) filter = { kind: 'all' };
    update();
    announceCount();
  }

  return { close: modal.close };
}
