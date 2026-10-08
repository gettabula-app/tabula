import type { BoardApp } from '../app';
import { collectionIcons, iconData, iconSets, previewUrl, searchIcons, type IconSet } from '../icons';
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

export function stickersTab(app: BoardApp, draggable: (el: HTMLElement, item: StickerDrag) => HTMLElement) {
  const input = h('input', { type: 'search', class: 'input', placeholder: 'Search stickers', 'aria-label': 'Search stickers' });
  const grid = h('div', { class: 'sticker-grid', role: 'list' });
  const note = h('p', { class: 'stickers-note' });
  let set = (STICKER_SETS.find((s) => s.default) ?? STICKER_SETS[0]).prefix;
  let sets: Record<string, IconSet> = {};
  let seq = 0;

  const updateNote = () => {
    const label = STICKER_SETS.find((s) => s.prefix === set)?.label ?? set;
    note.textContent = sets[set]?.attribution
      ? `${label} stickers are licensed CC BY and need attribution when you publish.`
      : 'Stickers are emoji from open-source sets via Iconify. Placed stickers are stored in the board and work offline.';
  };

  const tile = (name: string) => draggable(h('button', {
    class: 'sticker-tile', title: `${name}. Click to add, or drag onto the board.`, 'aria-label': name, role: 'listitem',
    onclick: () => placeSticker(app, name),
  }, h('img', { src: previewUrl(name), alt: '', loading: 'lazy', width: 28, height: 28 })), { kind: 'sticker', name });

  const show = (names: string[], query: string) => {
    if (!names.length) {
      grid.replaceChildren(h('div', { class: 'empty' }, query ? `No stickers match “${query}”. Try a broader word.` : 'No stickers in this set.'));
      return;
    }
    grid.replaceChildren(...names.map(tile));
  };

  const run = async () => {
    const my = ++seq;
    const q = input.value.trim();
    grid.classList.add('loading');
    try {
      const names = q ? await searchIcons(q, set) : await collectionIcons(set);
      if (my === seq) show(names, q);
    } catch {
      if (my === seq) grid.replaceChildren(h('div', { class: 'empty' }, 'Stickers need a connection the first time. Stickers already on your boards still work offline.'));
    } finally {
      if (my === seq) grid.classList.remove('loading');
    }
  };

  const chips = segmented(STICKER_SETS.map((s) => ({ value: s.prefix, label: s.label })), set, (v) => {
    set = v;
    updateNote();
    run();
  }, 'Sticker set');

  let t = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(run, 250);
  });
  iconSets().then((s) => {
    sets = s;
    updateNote();
  }).catch(() => undefined);
  updateNote();
  run();
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
      class: 'sticker-tile', title: `${name.split(':')[1]}. Click to react.`, 'aria-label': name, role: 'listitem',
      onclick: () => {
        closePopover();
        const b = app.r.contentBounds(app.selection);
        if (!b) return;
        placeSticker(app, name, { x: b.x + b.w + 20, y: b.y - 20 }, REACTION_SIZE);
      },
    }, h('img', { src: previewUrl(name), alt: '', loading: 'lazy', width: 28, height: 28 })))),
  );
}
