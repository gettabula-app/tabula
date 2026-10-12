import type { BoardApp } from '../app';
import type { BaseObj, Obj } from '../types';
import { LINK_SIZES, layoutOf, linkView, loneUrl, type LinkLayout } from '../link-cards';
import { h, icon } from './dom';
import { startLinkEdit } from './link-edit';

const LAYOUTS: { id: LinkLayout; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'card', label: 'Card' },
  { id: 'large', label: 'Large' },
];

const isLink = (o: Obj | undefined): o is BaseObj => o?.type === 'link';

/** True for a text or sticky whose content is one web address: the bar offers Turn into link card. */
export const convertibleToLink = (o: Obj | undefined) => (o?.type === 'text' || o?.type === 'sticky') && loneUrl((o as BaseObj).text ?? '') !== null;

/**
 * The quick bar's entries for a single link card or an address in a text (proto/designer-preview/link-cards/SPEC.md): the layout
 * segment, Open, Refresh, Edit and Turn into text. Viewers and commenters get Open only. `phone` leaves Open in the bar and hands
 * the rest back as `overflow` for the bar's more-actions menu.
 */
export function linkActions(app: BoardApp, parent: HTMLElement, sel: Obj[], phone: boolean): { bar: HTMLElement[]; overflow: HTMLElement[]; paint: () => void } {
  const none = { bar: [], overflow: [], paint: () => undefined };
  const only = sel.length === 1 ? sel[0] : undefined;
  if (only && convertibleToLink(only)) {
    const turn = h('button', { class: 'icon-btn qb-text', type: 'button', 'aria-label': 'Turn into link card', onclick: () => app.links.fromText(only.id) }, icon('link', 18), 'Turn into link card');
    return { bar: phone ? [] : [turn], overflow: phone ? [turn] : [], paint: () => undefined };
  }
  if (!isLink(only)) return none;
  const id = only.id;
  const open = h('button', { class: 'icon-btn qb-text on', type: 'button', 'aria-label': 'Open link', 'data-tip-key': 'enter', onclick: () => app.links.open(id) }, icon('openOut', 18), 'Open');
  if (app.readOnly) return { bar: [open], overflow: [], paint: () => undefined };

  const layoutButtons = LAYOUTS.map((l) => h('button', {
    class: 'icon-btn qb-text qb-seg', type: 'button', 'aria-pressed': 'false', 'data-layout': l.id, onclick: () => app.links.setLayout(id, l.id),
  }, l.label));
  const segment = h('div', { class: 'qb-segment', role: 'group', 'aria-label': 'Link card layout' }, ...layoutButtons);
  const refresh = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh preview', 'data-tip': 'Refresh preview', onclick: () => app.links.refresh(id) }, icon('refresh', 18));
  const edit = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit', 'data-tip': 'Edit title and description', onclick: () => startLinkEdit(app, parent, id) }, icon('pencil', 18));
  const text = h('button', { class: 'icon-btn qb-text', type: 'button', 'aria-label': 'Turn into text', onclick: () => app.links.toText(id) }, 'Turn into text');

  const paint = () => {
    const o = app.store.get(id) as BaseObj | undefined;
    if (!o) return;
    const now = layoutOf(o.w, o.h);
    for (const b of layoutButtons) b.setAttribute('aria-pressed', String(b.dataset.layout === now));
    for (const b of layoutButtons) b.classList.toggle('on', b.dataset.layout === now);
    const v = linkView(o);
    refresh.hidden = !app.links.previewsOn();
    refresh.disabled = v.state === 'pending';
  };
  paint();
  void LINK_SIZES;
  const sep = () => h('span', { class: 'qb-sep', 'aria-hidden': 'true' });
  if (phone) {
    // a phone's bar is narrow: Open stays, the rest is in the more-actions menu
    const item = (label: string, ic: Parameters<typeof icon>[0], run: () => void) => h('button', { class: 'menu-item', type: 'button', role: 'menuitem', onclick: run }, icon(ic, 18), h('span', null, label));
    return {
      bar: [open],
      overflow: [
        ...LAYOUTS.map((l) => item(l.label, 'card', () => app.links.setLayout(id, l.id))),
        ...(app.links.previewsOn() ? [item('Refresh preview', 'refresh', () => app.links.refresh(id))] : []),
        item('Edit', 'pencil', () => startLinkEdit(app, parent, id)),
        item('Turn into text', 'text', () => app.links.toText(id)),
      ],
      paint,
    };
  }
  return { bar: [segment, sep(), open, refresh, edit, text], overflow: [], paint };
}
