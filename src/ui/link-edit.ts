import type { BoardApp } from '../app';
import type { BaseObj } from '../types';
import { h } from './dom';

/**
 * Edit in place (proto/designer-preview/link-cards/SPEC.md, Quick bar): the card's title and description become two plain text fields
 * over the card. Esc cancels, a click outside saves, Cmd/Ctrl+Enter saves. A field that changed is marked in `edited`, so Refresh keeps
 * what a person wrote. Returns whether the editor opened.
 */
export function startLinkEdit(app: BoardApp, parent: HTMLElement, id: string): boolean {
  const o = app.store.get(id) as BaseObj | undefined;
  if (!o || o.type !== 'link' || app.readOnly || document.querySelector('.link-edit')) return false;
  const z = app.zoom;
  const tl = app.r.toScreen({ x: o.x, y: o.y });
  const box = app.r.svg.getBoundingClientRect();
  const host = parent.getBoundingClientRect();
  const title = h('input', { class: 'link-edit-title', type: 'text', maxlength: 300, 'aria-label': 'Title', placeholder: 'Title', value: o.title ?? '', autocomplete: 'off' }) as HTMLInputElement;
  const description = h('textarea', { class: 'link-edit-description', maxlength: 1000, 'aria-label': 'Description', placeholder: 'Description', rows: 3 }) as HTMLTextAreaElement;
  description.value = o.description ?? '';
  const el = h('div', { class: 'link-edit', role: 'group', 'aria-label': 'Edit link card' }, title, description);
  el.style.cssText = `left:${box.left - host.left + tl.x}px;top:${box.top - host.top + tl.y}px;width:${o.w * z}px;min-height:${Math.min(o.h, 128) * z}px;--z:${z}`;
  parent.appendChild(el);
  title.focus();
  title.select();

  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    window.removeEventListener('pointerdown', onDown, true);
    el.remove();
    if (!save) return;
    const current = app.store.get(id) as BaseObj | undefined;
    if (!current || current.type !== 'link') return;
    const edited = new Set(current.edited ?? []);
    const patch: Record<string, unknown> = {};
    for (const [field, value] of [['title', title.value.replace(/\s+/g, ' ').trim()], ['description', description.value.replace(/\s+/g, ' ').trim()]] as const) {
      if (value === (current[field] ?? '')) continue;
      patch[field] = value || undefined;
      edited.add(field);
    }
    if (!Object.keys(patch).length) return;
    patch.edited = [...edited];
    app.store.undo.stopCapturing();
    app.store.transact(() => app.store.update(id, patch));
  };
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) finish(true);
  };
  // the click that opened the editor has already had its pointerdown, so listening at once cannot close it
  window.addEventListener('pointerdown', onDown, true);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Enter' && e.target === title) {
      e.preventDefault();
      description.focus();
    }
  });
  return true;
}
