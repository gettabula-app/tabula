import type { BoardApp } from '../app';
import { collectionIcons, failureMessage, iconData, iconLoader, iconSets, loadPreviews, previewUrl, searchIcons, type IconLoadView, type IconSet } from '../icons';
import { REACTION_SIZE, REACTIONS, STICKER_SETS, STICKER_SIZE, stickerSize } from '../stickers';
import type { Point } from '../types';
import { closePopover, segmented, toast } from './common';
import { h } from './dom';
import { openIconCredits } from './icon-credits';
import { offlineRow } from './icon-offline';
import { placeClicked } from './place-click';

export interface StickerDrag { kind: 'sticker'; name: string }

/** Places a sticker centred on `at`; with no point it goes on the viewport centre, stepped aside for each earlier click placement. */
export async function placeSticker(app: BoardApp, name: string, at?: Point, longest = STICKER_SIZE) {
  if (app.readOnly) return;
  try {
    const d = await iconData(name);
    const size = stickerSize(d.width, d.height, longest);
    const extra = {
      ref: name, body: d.body, viewBox: [d.left, d.top, d.width, d.height] as [number, number, number, number], sticker: true,
    };
    if (at) app.placeAt('icon', at, size.w, size.h, extra);
    else placeClicked(app, 'icon', size.w, size.h, extra);
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

const FIRST_SCREEN = 24;

/** Waits for the previews of the first screen of `names`, so a failure to load them reaches the loader's Retry. The rest fill in later. */
export async function withPreviews(names: string[], signal: AbortSignal): Promise<string[]> {
  await loadPreviews(names.slice(0, FIRST_SCREEN), signal);
  return names;
}

/**
 * Sets the image of each tile as its icon's preview arrives (tiles are created without a source). A new fill
 * cancels the one before it, and the drawer's signal cancels both.
 */
export function previewFiller(signal: AbortSignal) {
  let ctl: AbortController | null = null;
  signal.addEventListener('abort', () => ctl?.abort(), { once: true });
  return (imgs: Map<string, HTMLImageElement>) => {
    ctl?.abort();
    const mine = (ctl = new AbortController());
    const set = (name: string) => {
      const url = previewUrl(name);
      if (url) imgs.get(name)!.src = url;
    };
    imgs.forEach((_, name) => set(name));
    loadPreviews([...imgs.keys()], mine.signal, set).catch(() => undefined);
  };
}

export function stickersTab(app: BoardApp, draggable: (el: HTMLElement, item: StickerDrag) => HTMLElement, signal: AbortSignal) {
  const input = h('input', { type: 'search', class: 'input', placeholder: 'Search stickers', 'aria-label': 'Search stickers' });
  const grid = h('div', { class: 'sticker-grid', role: 'list' });
  const note = h('p', { class: 'stickers-note' });
  let set = (STICKER_SETS.find((s) => s.default) ?? STICKER_SETS[0]).prefix;
  let sets: Record<string, IconSet> = {};
  let setsState: 'idle' | 'loading' | 'ready' = 'idle';

  const offline = offlineRow(() => ({ label: 'Sticker sets', prefixes: STICKER_SETS.map((s) => s.prefix) }), signal);
  const fill = previewFiller(signal);

  const updateNote = () => {
    const label = STICKER_SETS.find((s) => s.prefix === set)?.label ?? set;
    note.replaceChildren(
      sets[set]?.attribution
        ? `${label} stickers are licensed CC BY and need attribution when you publish.`
        : 'Stickers are emoji from open-source sets. Placed stickers are stored in the board and work offline.',
      ' ',
      h('button', { class: 'link-btn', onclick: openIconCredits }, 'Licences'),
    );
  };

  const tile = (name: string, imgs: Map<string, HTMLImageElement>) => {
    const img = h('img', { alt: '', loading: 'lazy', width: 28, height: 28 });
    imgs.set(name, img);
    return draggable(h('button', {
      class: 'sticker-tile', 'data-tip': `${name}. Click to add, or drag onto the board.`, 'aria-label': name, role: 'listitem',
      onclick: () => placeSticker(app, name),
    }, img), { kind: 'sticker', name });
  };

  const show = (names: string[], query: string) => {
    if (!names.length) {
      grid.replaceChildren(h('div', { class: 'empty' }, query ? `No stickers match “${query}”. Try a broader word.` : 'No stickers in this set.'));
      return;
    }
    const imgs = new Map<string, HTMLImageElement>();
    grid.replaceChildren(...names.map((n) => tile(n, imgs)));
    fill(imgs);
  };

  const loader = iconLoader((s) => {
    const q = input.value.trim();
    loadSets();
    return (q ? searchIcons(q, set, 96, s) : collectionIcons(set, 160, s)).then((names) => withPreviews(names, s));
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
      offline.update();
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
    offline.el,
    note,
  );
}

/** The reaction picker shown in the quick-action bar. Each reaction is an ordinary sticker placed beside the selection. */
export function reactionPicker(app: BoardApp) {
  const imgs = new Map<string, HTMLImageElement>();
  const picker = h('div', { class: 'reactions' },
    h('div', { class: 'stickers-label' }, 'React'),
    h('div', { class: 'sticker-grid reaction-grid', role: 'list' }, ...REACTIONS.map((name) => {
      const img = h('img', { alt: '', width: 28, height: 28 });
      imgs.set(name, img);
      return h('button', {
        class: 'sticker-tile', 'data-tip': `${name.split(':')[1]}. Click to react.`, 'aria-label': name, role: 'listitem',
        onclick: () => {
          closePopover();
          const b = app.r.contentBounds(app.selection);
          if (!b) return;
          placeSticker(app, name, { x: b.x + b.w + 20, y: b.y - 20 }, REACTION_SIZE);
        },
      }, img);
    })),
  );
  previewFiller(new AbortController().signal)(imgs);
  return picker;
}
