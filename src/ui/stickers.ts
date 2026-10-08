import type { BoardApp } from '../app';
import { collectionIcons, failureMessage, iconData, iconLoader, iconSets, previewUrl, searchIcons, type IconLoadView, type IconSet } from '../icons';
import { REACTION_SIZE, REACTIONS, STICKER_SETS, STICKER_SIZE, stickerSize } from '../stickers';
import type { Point } from '../types';
import { closePopover, segmented, toast } from './common';
import { h } from './dom';

export interface StickerDrag { kind: 'sticker'; name: string }

/** Places a sticker centred on `at`, or on the viewport centre when there is no point. */
export async function placeSticker(app: BoardApp, name: string, at?: Point, longest = STICKER_SIZE) {
  if (app.readOnly) return;
  try {
    const d = await iconData(name);
    const size = stickerSize(d.width, d.height, longest);
    const extra = {
      ref: name, body: d.body, viewBox: [d.left, d.top, d.width, d.height] as [number, number, number, number], sticker: true,
    };
    if (at) app.placeAt('icon', at, size.w, size.h, extra);
    else app.placeAtCenter('icon', size.w, size.h, extra);
  } catch {
    toast('That icon could not be loaded. Check your connection and try again.');
  }
}

/** The grid's states for an Iconify query: a loading line while a fetch runs, the results, or a failure with a Retry button. */
export function gridView(grid: HTMLElement, results: (names: string[]) => void): IconLoadView {
  return {
    loading: (on) => {
      grid.classList.toggle('loading', on);
      if (on) grid.replaceChildren(h('div', { class: 'icon-status', role: 'status' }, 'Loading…'));
    },
    results,
    failed: (failure, retry, busy) => grid.replaceChildren(h('div', { class: 'icon-status', role: 'status' },
      h('div', null, failureMessage(failure)),
      h('button', { class: 'btn', disabled: busy, onclick: retry }, 'Retry'),
    )),
  };
}

export function stickersTab(app: BoardApp, draggable: (el: HTMLElement, item: StickerDrag) => HTMLElement, signal: AbortSignal) {
  const input = h('input', { type: 'search', class: 'input', placeholder: 'Search stickers', 'aria-label': 'Search stickers' });
  const grid = h('div', { class: 'sticker-grid', role: 'list' });
  const note = h('p', { class: 'stickers-note' });
  let set = (STICKER_SETS.find((s) => s.default) ?? STICKER_SETS[0]).prefix;
  let sets: Record<string, IconSet> = {};
  let setsState: 'idle' | 'loading' | 'ready' = 'idle';

  const updateNote = () => {
    const label = STICKER_SETS.find((s) => s.prefix === set)?.label ?? set;
    note.textContent = sets[set]?.attribution
      ? `${label} stickers are licensed CC BY and need attribution when you publish.`
      : 'Stickers are emoji from open-source sets via Iconify. Placed stickers are stored in the board and work offline.';
  };

  const tile = (name: string) => draggable(h('button', {
    class: 'sticker-tile', 'data-tip': `${name}. Click to add, or drag onto the board.`, 'aria-label': name, role: 'listitem',
    onclick: () => placeSticker(app, name),
  }, h('img', { src: previewUrl(name), alt: '', loading: 'lazy', width: 28, height: 28 })), { kind: 'sticker', name });

  const show = (names: string[], query: string) => {
    if (!names.length) {
      grid.replaceChildren(h('div', { class: 'empty' }, query ? `No stickers match “${query}”. Try a broader word.` : 'No stickers in this set.'));
      return;
    }
    grid.replaceChildren(...names.map(tile));
  };

  const loader = iconLoader((s) => {
    const q = input.value.trim();
    loadSets();
    return q ? searchIcons(q, set, 96, s) : collectionIcons(set, 160, s);
  }, gridView(grid, (names) => show(names, input.value.trim())), signal);

  const chips = segmented(STICKER_SETS.map((s) => ({ value: s.prefix, label: s.label })), set, (v) => {
    set = v;
    updateNote();
    loader.reload();
  }, 'Sticker set');

  let t = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(loader.reload, 250);
  });
  signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  const loadSets = () => {
    if (setsState !== 'idle') return;
    setsState = 'loading';
    iconSets(signal).then((s) => {
      if (signal.aborted) return;
      setsState = 'ready';
      sets = s;
      updateNote();
    }).catch(() => {
      setsState = 'idle';
    });
  };
  loadSets();
  updateNote();
  loader.reload();
  requestAnimationFrame(() => input.focus());
  return h('div', { class: 'drawer-body stickers' },
    input,
    h('div', { class: 'stickers-label' }, 'Set'),
    h('div', { class: 'sticker-sets' }, chips),
    grid,
    note,
  );
}

/** The reaction picker shown in the quick-action bar. Each reaction is an ordinary sticker placed beside the selection. */
export function reactionPicker(app: BoardApp) {
  return h('div', { class: 'reactions' },
    h('div', { class: 'stickers-label' }, 'React'),
    h('div', { class: 'sticker-grid reaction-grid', role: 'list' }, ...REACTIONS.map((name) => h('button', {
      class: 'sticker-tile', 'data-tip': `${name.split(':')[1]}. Click to react.`, 'aria-label': name, role: 'listitem',
      onclick: () => {
        closePopover();
        const b = app.r.contentBounds(app.selection);
        if (!b) return;
        placeSticker(app, name, { x: b.x + b.w + 20, y: b.y - 20 }, REACTION_SIZE);
      },
    }, h('img', { src: previewUrl(name), alt: '', loading: 'lazy', width: 28, height: 28 })))),
  );
}
