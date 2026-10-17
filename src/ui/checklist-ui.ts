import type { ChecklistItem, Id } from '../types';
import { LIMITS } from '../../shared/containers';
import {
  addItem, checklistProgress, cleanItemText, editItem, moveItem, parsePastedItems, progressLabel, removeItem, toggleItem, withNewIds,
} from '../checklist';
import { closePopover, popover } from './common';
import { h, icon } from './dom';

// The checklist of a card, in the card dialog (TAB-372, po/specs/12-kanban-checklist.md): one list of items under the description,
// ticked in place. Every change writes the whole new list as one card patch, so it is one undo step, and the rules (the caps,
// the text limit, the byte limit) are the ones in src/checklist.ts. Items keep their ids. Readers see the list without the means to
// change it; a card that is not in a lane has no "Turn into card".

const MAX_ITEMS = LIMITS.checklistItems;
const MAX_BYTES = LIMITS.checklistBytes;
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
const encoder = new TextEncoder();
const bytesOf = (items: readonly ChecklistItem[]) => encoder.encode(JSON.stringify(items)).length;
const FULL = `The list is full (${MAX_ITEMS} items)`;

/** At most `max` code points: a longer value is cut between code points, never inside one. */
function cutToCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('') : s;
}

export interface ChecklistHooks {
  /** Whether this person may change the list (an editor, on an unlocked card). */
  editable: boolean;
  /** Whether a card in a lane is here: only then can an item become a card. */
  canConvert: () => boolean;
  /** The card's items now. */
  items: () => ChecklistItem[];
  /** Writes the whole new list as one patch. False when the write was refused. */
  save: (list: ChecklistItem[]) => boolean;
  /** Turns an item into a card below this one, or says why it cannot. */
  toCard: (itemId: Id) => { id: Id } | { refusal: string };
  notify: (message: string) => void;
  announce: (message: string) => void;
  /** Keeps the keys pressed in an element from reaching the board. */
  keep: (el: HTMLElement) => void;
}

/** The part of a row that takes focus; `add` is the add field. */
type Part = 'box' | 'text' | 'convert' | 'delete' | 'more' | 'add';
interface Focus { id: Id | null; part: Part }
interface Drag { id: Id; row: HTMLElement; grip: HTMLElement; pointer: number; startY: number }

const keyOf = (node: unknown): Focus | null => {
  const el = node as HTMLElement | null;
  const id = el?.dataset?.itemId;
  const part = el?.dataset?.part as Part | undefined;
  return id && part ? { id, part } : null;
};

/**
 * The checklist field: head (label, count, Hide done), progress line, the rows, the empty note and the add field. The dialog
 * calls `render()` whenever the card changes; the rows are rebuilt from `items()` and focus goes back to what had it.
 */
export function checklistSection(hooks: ChecklistHooks): { el: HTMLElement; render: () => void } {
  const { editable } = hooks;
  // hiding the done items is a view of this dialog only: it is not saved
  let hideDone = false;
  let editing: { id: Id; input: HTMLInputElement } | null = null;
  let drag: Drag | null = null;
  let pendingFocus: Focus | null = null;

  const count = h('span', { class: 'k-cl-count' });
  const hide = h('button', { class: 'btn ghost k-cl-hide', type: 'button', onclick: () => { hideDone = !hideDone; paint(); } });
  const head = h('div', { class: 'field-label k-cl-head' }, h('span', null, 'Checklist'), h('span', { class: 'k-cl-tail' }, count, hide));
  const bar = h('div', { class: 'k-cl-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-label': 'Checklist progress' });
  const list = h('ul', { class: 'k-cl-list' });
  const empty = h('p', { class: 'k-cl-empty' }, 'Small steps to tick off. Paste a list to add several at once.');
  const note = h('p', { class: 'k-cl-note', role: 'status', 'aria-live': 'polite', hidden: true });
  const input = h('input', { class: 'input', type: 'text', 'aria-label': 'Add a checklist item', placeholder: 'Add an item', maxlength: LIMITS.checklistText * 2, autocomplete: 'off' });
  const addBtn = h('button', { class: 'btn k-cl-add-btn', type: 'button', onclick: () => add() }, 'Add');
  const addRow = h('div', { class: 'k-cl-add' }, icon('plus', 16), input, addBtn);
  const el = h('div', { class: 'field k-checklist' }, head, bar, list, empty, note, editable ? addRow : null);

  const setNote = (text: string) => {
    note.textContent = text;
    note.hidden = !text;
  };
  const isHiding = (items: ChecklistItem[]) => {
    const p = checklistProgress({ checklist: items });
    return hideDone && p.done > 0 && p.done < p.total;
  };
  /** The focus after a row goes: the next shown item, else the one before it, else the add field. */
  const neighbourFocus = (items: ChecklistItem[], at: number): Focus => {
    const hiding = isHiding(items);
    const shown = (i: ChecklistItem) => !hiding || !i.done;
    const next = items.slice(at + 1).find(shown) ?? items.slice(0, at).reverse().find(shown);
    return next ? { id: next.id, part: 'text' } : { id: null, part: 'add' };
  };
  /** Writes a new list with the focus to put back afterwards. Nothing is written for an unchanged list. */
  const attempt = (next: ChecklistItem[], items: ChecklistItem[], focus: Focus | null) => {
    if (next === items) return;
    pendingFocus = focus;
    if (!hooks.save(next)) pendingFocus = null;
  };

  // ---- the add field: one item per Enter, or a pasted list in one patch
  if (editable) {
    input.addEventListener('input', () => {
      const t = cutToCodePoints(input.value, LIMITS.checklistText);
      if (t !== input.value) input.value = t;
    });
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        add();
      } else if (e.key === 'Escape' && input.value) {
        // typed text goes first and the dialog stays open; Escape in an empty field closes the dialog as everywhere else
        e.preventDefault();
        e.stopPropagation();
        input.value = '';
      }
    });
    input.addEventListener('paste', (e: ClipboardEvent) => paste(e));
  }

  function add() {
    const items = hooks.items();
    const text = input.value;
    if (!cleanItemText(text)) return;
    const next = addItem(items, text);
    if (!next) return hooks.notify(items.length >= MAX_ITEMS ? FULL : 'This checklist has no room for another item.');
    // the field keeps the focus for the next one; it is cleared only when the item was written
    if (hooks.save(next)) input.value = '';
  }

  function paste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    // one line is typed in as it is; a list becomes one item a line
    if (!LINE_BREAK.test(text)) return;
    e.preventDefault();
    const items = hooks.items();
    const parsed = parsePastedItems(text, MAX_ITEMS - items.length, MAX_BYTES - bytesOf(items));
    if (parsed.dropped) {
      const n = parsed.dropped;
      const counted = items.length + parsed.items.length >= MAX_ITEMS;
      setNote(`${n} ${n === 1 ? 'item was' : 'items were'} not added: ${counted ? `the list holds ${MAX_ITEMS}.` : 'the list is full.'}`);
    } else setNote('');
    if (!parsed.items.length) return;
    hooks.save([...items, ...withNewIds(parsed.items)]);
  }

  // ---- a row's actions
  function toggle(id: Id) {
    const items = hooks.items();
    attempt(toggleItem(items, id), items, { id, part: 'box' });
  }

  function moveBy(id: Id, delta: number) {
    const items = hooks.items();
    attempt(moveItem(items, id, delta), items, { id, part: 'text' });
  }

  function removeRow(id: Id) {
    const items = hooks.items();
    const at = items.findIndex((i) => i.id === id);
    if (at < 0) return;
    attempt(removeItem(items, id), items, neighbourFocus(items, at));
  }

  function convertItem(id: Id) {
    const items = hooks.items();
    const at = items.findIndex((i) => i.id === id);
    const item = items[at];
    if (!item) return;
    pendingFocus = neighbourFocus(items, at);
    const r = hooks.toCard(id);
    if ('refusal' in r) {
      pendingFocus = null;
      return hooks.notify(r.refusal);
    }
    hooks.announce(`Turned into a card: ${item.text}`);
  }

  /** Inline edit: the text becomes a field; Enter, Tab and leaving the field save, Escape cancels. */
  function startEdit(id: Id) {
    if (!editable || editing || drag) return;
    const item = hooks.items().find((i) => i.id === id);
    const textEl = list.querySelector<HTMLElement>(`[data-item-id="${id}"][data-part="text"]`);
    if (!item || !textEl) return;
    const field = h('input', {
      class: 'input k-cl-edit', type: 'text', 'aria-label': 'Item text', maxlength: LIMITS.checklistText * 2, autocomplete: 'off',
      'data-item-id': id, 'data-part': 'edit',
    });
    field.value = item.text;
    field.addEventListener('input', () => {
      const t = cutToCodePoints(field.value, LIMITS.checklistText);
      if (t !== field.value) field.value = t;
    });
    field.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        finishEdit(true);
      } else if (e.key === 'Escape') {
        // the dialog closes on Escape; here it only cancels the edit
        e.preventDefault();
        e.stopPropagation();
        finishEdit(false);
      } else if (e.key === 'Tab' && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
        // Tab saves and moves on: to the next control of this row (the rows are rebuilt, so the browser's own move would be lost)
        e.preventDefault();
        finishEdit(true, e.shiftKey ? 'box' : hooks.canConvert() ? 'convert' : 'delete');
      }
    });
    field.addEventListener('blur', () => {
      if (editing?.input === field) finishEdit(true);
    });
    editing = { id, input: field };
    textEl.replaceWith(field);
    field.focus();
    const end = field.value.length;
    field.setSelectionRange?.(end, end);
  }

  function finishEdit(save: boolean, part: Part = 'text') {
    const st = editing;
    if (!st) return;
    editing = null;
    const items = hooks.items();
    const next = save ? editItem(items, st.id, st.input.value) : null;
    pendingFocus = { id: st.id, part };
    // an empty text cancels the edit: an item is removed with Delete, not by clearing it
    if (next && next !== items) hooks.save(next);
    else paint();
  }

  // ---- drag to reorder (the grip, desktop only)
  function startDrag(e: PointerEvent) {
    const grip = e.currentTarget as HTMLElement;
    const row = grip.closest<HTMLElement>('.k-cl-row');
    const id = row?.dataset.itemId;
    if (!editable || editing || !row || !id || e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    drag = { id, row, grip, pointer: e.pointerId, startY: e.clientY };
    row.classList.add('dragging');
  }

  function moveDrag(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.row.style.transform = `translateY(${e.clientY - drag.startY}px)`;
  }

  function endDrag(e: PointerEvent, apply: boolean) {
    const d = drag;
    if (!d || e.pointerId !== d.pointer) return;
    drag = null;
    const centre = (r: HTMLElement) => {
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2;
    };
    const y = centre(d.row);
    d.row.style.transform = '';
    d.row.classList.remove('dragging');
    if (d.grip.hasPointerCapture(e.pointerId)) d.grip.releasePointerCapture(e.pointerId);
    if (!apply) return;
    // the item goes in front of the first row whose middle is below the dragged row's middle
    const others = [...list.querySelectorAll<HTMLElement>('.k-cl-row')].filter((r) => r !== d.row);
    const above = others.filter((r) => centre(r) < y).length;
    const items = hooks.items();
    const rest = items.filter((i) => i.id !== d.id);
    const beforeId = others[above]?.dataset.itemId;
    const pos = beforeId ? rest.findIndex((i) => i.id === beforeId) : rest.length;
    const from = items.findIndex((i) => i.id === d.id);
    if (from < 0 || pos < 0 || pos === from) return;
    attempt(moveItem(items, d.id, pos - from), items, null);
  }

  // ---- the phone menu of a row
  const menuItem = (name: 'card' | 'trash', label: string, act: () => void) => h('button', {
    class: 'menu-item', type: 'button', role: 'menuitem', onclick: () => { closePopover(); act(); },
  }, icon(name, 16), h('span', null, label));

  function openMenu(id: Id, anchor: HTMLElement) {
    const text = hooks.items().find((i) => i.id === id)?.text ?? '';
    const menu = h('div', { class: 'k-cl-menu' },
      hooks.canConvert() ? menuItem('card', 'Turn into card', () => convertItem(id)) : null,
      menuItem('trash', 'Delete item', () => removeRow(id)));
    hooks.keep(menu);
    popover(anchor, menu, { role: 'menu', className: 'k-cl-pop', label: `Actions for ${text}` });
  }

  // ---- the rows
  function row(item: ChecklistItem): HTMLLIElement {
    const id = item.id;
    const grip = editable
      ? h('span', {
        class: 'k-cl-grip', 'aria-hidden': 'true',
        onpointerdown: startDrag, onpointermove: moveDrag,
        onpointerup: (e: PointerEvent) => endDrag(e, true), onpointercancel: (e: PointerEvent) => endDrag(e, false),
      }, icon('grip', 14))
      : null;
    const box = h('button', {
      class: 'k-cl-box', type: 'button', role: 'checkbox', 'aria-checked': String(item.done), 'aria-label': item.text,
      'aria-disabled': editable ? undefined : 'true', disabled: !editable, 'data-item-id': id, 'data-part': 'box',
      onclick: () => toggle(id),
    });
    const text = editable
      ? h('button', {
        class: 'k-cl-text', type: 'button', 'data-item-id': id, 'data-part': 'text', onclick: () => startEdit(id),
        onkeydown: (e: KeyboardEvent) => {
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            moveBy(id, e.key === 'ArrowUp' ? -1 : 1);
          }
        },
      }, item.text)
      : h('span', { class: 'k-cl-text' }, item.text);
    const tools = editable ? [
      h('div', { class: 'k-cl-tools' },
        hooks.canConvert()
          ? h('button', { class: 'btn ghost k-cl-convert', type: 'button', 'data-item-id': id, 'data-part': 'convert', onclick: () => convertItem(id) },
            icon('card', 14), h('span', null, 'Turn into card'))
          : null,
        h('button', {
          class: 'icon-btn k-cl-del', type: 'button', 'aria-label': 'Delete item', 'data-tip': 'Delete item',
          'data-item-id': id, 'data-part': 'delete', onclick: () => removeRow(id),
        }, icon('close', 16))),
      h('button', {
        class: 'k-cl-more', type: 'button', 'aria-haspopup': 'menu', 'aria-label': `Actions for ${item.text}`,
        'data-item-id': id, 'data-part': 'more', onclick: (e: Event) => openMenu(id, e.currentTarget as HTMLElement),
      }, icon('dots', 18)),
    ] : [];
    return h('li', { class: item.done ? 'k-cl-row done' : 'k-cl-row', 'data-item-id': id }, grip, box, text, ...tools);
  }

  /** Rebuilds the rows, then puts the focus back on the part that had it (or the one a key press asked for). */
  function rebuild(items: ChecklistItem[]) {
    const want = pendingFocus;
    pendingFocus = null;
    const focus = want ?? keyOf(document.activeElement);
    const hiding = isHiding(items);
    list.replaceChildren(...items.filter((i) => !hiding || !i.done).map(row));
    if (!focus) return;
    if (focus.part === 'add') {
      if (editable && !input.disabled) input.focus();
      return;
    }
    list.querySelector<HTMLElement>(`[data-item-id="${focus.id}"][data-part="${focus.part}"]`)?.focus();
  }

  /** Everything the field shows, from the card's items. The rows are not rebuilt while one is being edited or dragged. */
  function paint() {
    const items = hooks.items();
    const p = checklistProgress({ checklist: items });
    const label = progressLabel(p);
    const hiding = isHiding(items);
    el.hidden = !editable && p.total === 0;
    count.hidden = p.total === 0;
    count.classList.toggle('k-cl-done', !!label?.complete);
    count.replaceChildren(...(label?.complete ? [icon('check', 14), 'All done'] : [`${p.done} of ${p.total}`]));
    hide.hidden = !(p.done > 0 && p.done < p.total);
    hide.textContent = hiding ? `Show ${p.done} done` : 'Hide done';
    bar.hidden = p.total === 0;
    bar.style.setProperty('--p', String(p.total ? p.done / p.total : 0));
    bar.setAttribute('aria-valuemax', String(p.total));
    bar.setAttribute('aria-valuenow', String(p.done));
    bar.setAttribute('aria-valuetext', label?.srText ?? '');
    empty.hidden = p.total > 0;
    list.hidden = p.total === 0;
    const full = p.total >= MAX_ITEMS;
    input.disabled = full;
    input.setAttribute('placeholder', full ? FULL : 'Add an item');
    addBtn.disabled = full;
    if (!editing && !drag) rebuild(items);
  }

  return { el, render: paint };
}
