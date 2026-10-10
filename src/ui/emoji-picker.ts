import type { BoardApp } from '../app';
import { announce } from './announce';
import { h } from './dom';
import { popover } from './common';
import { addRecent, moveGridFocus, parseRecent, searchEmoji, type GridKey } from './emoji-logic';
import type { EmojiGroup, EmojiItem } from '../emoji-data';
import './emoji-picker.css';

const RECENT_KEY = 'tabula.emoji.recent';

function recentFromStorage(items: readonly EmojiItem[]): string[] {
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY), items);
  } catch {
    return [];
  }
}

function saveRecent(emoji: string, items: readonly EmojiItem[]): string[] {
  const recent = addRecent(recentFromStorage(items), emoji, items);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Storage can be disabled in a private or embedded browser.
  }
  return recent;
}

/** Opens the picker only on demand, keeping the emoji catalog in its own async chunk. */
export async function openEmojiPicker(app: BoardApp, anchor: HTMLElement) {
  if (!app.editor.textMode || app.readOnly) return;
  app.editor.holdBlur(true);
  let groups: EmojiGroup[];
  try {
    ({ EMOJI_GROUPS: groups } = await import('../emoji-data'));
  } catch {
    app.editor.holdBlur(false);
    app.editor.focus();
    return;
  }
  if (!app.editor.textMode || app.readOnly) {
    app.editor.holdBlur(false);
    return;
  }

  const all = groups.flatMap((group) => group.items);
  const search = h('input', {
    class: 'input emoji-search', type: 'search', 'aria-label': 'Search emoji', placeholder: 'Search',
    autocomplete: 'off', spellcheck: 'false',
  });
  const results = h('div', { class: 'emoji-results' });
  const content = h('div', { class: 'emoji-picker' }, search, results);
  let rovingEmoji: string | null = null;
  let closePicker: () => void = () => {};

  const cells = () => Array.from(results.querySelectorAll<HTMLButtonElement>('.emoji-cell'));
  const focusCell = (cell: HTMLButtonElement) => {
    for (const button of cells()) button.tabIndex = button === cell ? 0 : -1;
    rovingEmoji = cell.dataset.emoji ?? null;
    cell.focus({ preventScroll: true });
  };
  const makeGrid = (label: string, items: readonly EmojiItem[]) => {
    const grid = h('div', { class: 'emoji-grid', role: 'listbox', 'aria-label': label });
    for (const item of items) {
      const cell = h('button', {
        class: 'emoji-cell', type: 'button', role: 'option', 'aria-label': item.n, 'aria-selected': 'false',
        tabindex: '-1', title: item.n, 'data-emoji': item.e,
        onclick: (event: MouseEvent) => choose(item, event),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose(item, event);
            return;
          }
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          const grids = Array.from(results.querySelectorAll<HTMLElement>('.emoji-grid'));
          const list = Array.from(grid.querySelectorAll<HTMLButtonElement>('.emoji-cell'));
          const index = list.indexOf(cell);
          const style = getComputedStyle(grid);
          const columns = style.gridTemplateColumns ? style.gridTemplateColumns.trim().split(/\s+/).length : 6;
          const gridIndex = grids.indexOf(grid);
          const previousGrid = grids[gridIndex - 1];
          const nextGrid = grids[gridIndex + 1];
          let target: HTMLButtonElement | undefined;
          if (event.key === 'ArrowUp' && index < columns) {
            if (previousGrid) {
              const previous = Array.from(previousGrid.querySelectorAll<HTMLButtonElement>('.emoji-cell'));
              const previousColumns = getColumns(previousGrid);
              target = previous[Math.max(0, previous.length - previousColumns + index)];
            } else search.focus({ preventScroll: true });
          } else if (event.key === 'ArrowDown' && index + columns >= list.length && nextGrid) {
            const next = Array.from(nextGrid.querySelectorAll<HTMLButtonElement>('.emoji-cell'));
            target = next[Math.min(index % columns, next.length - 1)];
          } else if (event.key === 'ArrowLeft' && index === 0) {
            const previous = previousGrid ?? grids[grids.length - 1];
            const previousCells = Array.from(previous.querySelectorAll<HTMLButtonElement>('.emoji-cell'));
            target = previousCells.at(-1);
          } else if (event.key === 'ArrowRight' && index === list.length - 1) {
            const next = nextGrid ?? grids[0];
            target = next.querySelector<HTMLButtonElement>('.emoji-cell') ?? undefined;
          } else {
            const next = moveGridFocus(index, event.key as GridKey, list.length, columns);
            target = next === null ? undefined : list[next];
            if (next === null && event.key === 'ArrowUp') search.focus({ preventScroll: true });
          }
          event.preventDefault();
          if (target) focusCell(target);
        },
      }, item.e);
      grid.appendChild(cell);
    }
    return grid;
  };

  const render = () => {
    const query = search.value;
    const matched = searchEmoji(all, query);
    const matching = new Set(matched.map((item) => item.e));
    const recent = recentFromStorage(all).filter((emoji) => matching.has(emoji));
    results.replaceChildren();
    if (recent.length) {
      const items = recent.map((emoji) => all.find((item) => item.e === emoji)).filter((item): item is EmojiItem => !!item);
      results.append(h('section', { class: 'emoji-section' }, h('h3', { class: 'list-label' }, 'Recent'), makeGrid('Recent emoji', items)));
    }
    for (const group of groups) {
      const found = group.items.filter((item) => matching.has(item.e));
      if (!found.length) continue;
      results.append(h('section', { class: 'emoji-section' }, h('h3', { class: 'list-label' }, group.name), makeGrid(group.name, found)));
    }
    const visible = cells();
    const active = visible.find((cell) => cell.dataset.emoji === rovingEmoji) ?? visible[0];
    for (const cell of visible) cell.tabIndex = cell === active ? 0 : -1;
    if (!matched.length) results.append(h('p', { class: 'emoji-empty' }, 'No emoji found'));
    announce(`${matched.length} emoji found`, { key: 'emoji-search', delay: 300 });
  };

  function getColumns(grid: HTMLElement) {
    const template = getComputedStyle(grid).gridTemplateColumns;
    return template ? template.trim().split(/\s+/).length : 6;
  }

  function choose(item: EmojiItem, event: MouseEvent | KeyboardEvent) {
    if (!app.editor.textMode) return;
    app.editor.insertAtCursor(item.e);
    saveRecent(item.e, all);
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      rovingEmoji = item.e;
      render();
      search.focus({ preventScroll: true });
    } else closePicker();
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const first = searchEmoji(all, search.value)[0];
      if (first) {
        event.preventDefault();
        choose(first, event);
      }
    } else if (event.key === 'ArrowDown') {
      const first = cells()[0];
      if (first) {
        event.preventDefault();
        focusCell(first);
      }
    }
  });
  render();

  const pop = popover(anchor, content, {
    side: 'top', className: 'emoji-pop', label: 'Emoji',
    onClose: () => {
      // popover() handles Escape at window capture, before the editor's textarea keydown can commit.
      app.editor.holdBlur(false);
      app.editor.focus();
    },
  });
  closePicker = pop.close;
  return pop;
}
