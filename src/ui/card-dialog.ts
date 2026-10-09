import './card-dialog.css';
import type { BoardApp, CardFocus } from '../app';
import type { BaseObj, Id } from '../types';
import { LIMITS } from '../../shared/containers';
import { editCard, knownLabels, OWNER_NAME_MAX, type CardPatch } from '../containers';
import { listLabels, toggleCardLabel } from '../labels';
import { kanbanSwatch } from '../markup';
import { dialog } from './common';
import { h, icon } from './dom';
import { isDueDate, ownerKey, ownerOptions } from './kanban-logic';

// The card dialog (docs/kanban.md, Cards): title, description, owner, due date and labels, a comment button, Turn into
// sticky and Delete. Fields save as they are left, as everywhere in the app; there is no Save button. Read-only for
// commenters, who keep the comment button; viewers do not open it (BoardApp.canOpenCard). At phone width it is a bottom
// sheet (card-dialog.css). Everything a person wrote reaches the page as text or as an input's value, never as markup.

const OTHER = '__other';

/**
 * The dialog's own keys stay in it: Delete on a focused button must not delete the card on the board behind it. Tab and
 * Escape go on to the dialog, and undo and redo to the board (in a text field the board leaves them to the field).
 */
export function keepKeys(box: HTMLElement) {
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.key === 'Escape') return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && (k === 'z' || k === 'y')) return;
    e.stopPropagation();
  });
}

export function openCardDialog(app: BoardApp, id: Id, focus?: CardFocus) {
  const card0 = app.store.get(id);
  if (card0?.type !== 'card' || !app.canOpenCard()) return null;
  const editable = !app.readOnly && !card0.locked;
  const canComment = !app.comments.readOnly();
  const cardOf = () => app.store.get(id) as BaseObj | undefined;
  const save = (patch: CardPatch) => {
    if (!editable) return;
    // refused or unchanged: the fields show what the card has again
    if (!editCard(app.store, id, patch)) render(true);
  };

  // ---- fields
  // Typed text is saved only when this person changed it: a field that was only focused never writes back what it showed,
  // so a change someone else made meanwhile stays.
  const dirty = { head: false, desc: false };
  const title = h('input', { class: 'input', type: 'text', maxlength: LIMITS.title, 'aria-label': 'Title', autocomplete: 'off' });
  const saveTitle = () => {
    if (!dirty.head) return;
    dirty.head = false;
    save({ title: title.value });
  };
  title.addEventListener('input', () => (dirty.head = true));
  title.addEventListener('change', saveTitle);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      saveTitle();
    }
  });
  const desc = h('textarea', { class: 'input k-desc', maxlength: LIMITS.description, rows: 5, 'aria-label': 'Description', placeholder: editable ? 'Add a description' : '' });
  const saveDesc = () => {
    if (!dirty.desc) return;
    dirty.desc = false;
    save({ desc: desc.value });
  };
  desc.addEventListener('input', () => (dirty.desc = true));
  desc.addEventListener('change', saveDesc);

  const owner = h('select', { class: 'input', 'aria-label': 'Owner' });
  const ownerName = h('input', { class: 'input k-owner-name', type: 'text', maxlength: OWNER_NAME_MAX, 'aria-label': 'Owner\'s name', placeholder: 'Name', autocomplete: 'off' });
  owner.addEventListener('change', () => {
    if (owner.value === OTHER) {
      ownerName.hidden = false;
      ownerName.value = '';
      ownerName.focus();
      return;
    }
    ownerName.hidden = true;
    if (owner.value === '') return save({ owner: null });
    // a choice the list no longer offers (it changed under the open menu) does nothing, never clears the owner
    const opt = options.find((o) => o.key === owner.value);
    if (opt) save({ owner: { id: opt.id, name: opt.name } });
    else render(true);
  });
  ownerName.addEventListener('change', () => {
    const name = ownerName.value.trim();
    if (name) save({ owner: { name } });
  });

  const due = h('input', { class: 'input', type: 'date', 'aria-label': 'Due date' });
  due.addEventListener('change', () => {
    if (!due.value || isDueDate(due.value)) save({ due: due.value || null });
  });
  const clearDue = h('button', { class: 'btn ghost k-clear', type: 'button', onclick: () => save({ due: null }) }, 'Clear');

  const labels = h('div', { class: 'k-labels', role: 'group', 'aria-label': 'Labels' });
  const manage = editable
    ? h('button', { class: 'btn ghost', type: 'button', onclick: () => app.openLabels?.() }, 'Edit labels')
    : null;

  // ---- actions
  const actions = h('div', { class: 'k-actions' },
    canComment ? h('button', { class: 'btn', type: 'button', onclick: () => { d.close(); app.commentOnCard(id); } }, icon('comment', 16), 'Comment') : null,
    editable ? h('button', { class: 'btn', type: 'button', onclick: () => { d.close(); app.turnIntoStickies([id]); } }, icon('sticky', 16), 'Turn into sticky') : null,
    editable ? h('button', { class: 'btn danger', type: 'button', onclick: () => { d.close(); app.setSelection([id]); app.deleteSelection(); } }, icon('trash', 16), 'Delete') : null,
  );

  const note = editable ? null : h('p', { class: 'k-note' }, card0.locked && !app.readOnly ? 'This card is locked. Unlock it to change it.' : canComment ? 'You can comment on this card. Only editors can change it.' : 'Only editors can change this card.');
  const body = h('div', { class: 'k-card-form' },
    note,
    field('Title', title),
    field('Description', desc),
    h('div', { class: 'k-row2' },
      field('Owner', h('div', { class: 'k-stack' }, owner, ownerName)),
      field('Due', h('div', { class: 'k-due' }, due, editable ? clearDue : null)),
    ),
    h('div', { class: 'field' }, h('div', { class: 'field-label k-label-head' }, h('span', null, 'Labels'), manage), labels),
    actions,
  );
  keepKeys(body);

  let options: ReturnType<typeof ownerOptions> = [];

  function render(reset = false) {
    const card = cardOf();
    if (!card || card.type !== 'card') return;
    // a field being typed in keeps what is typed, unless what it wrote was refused
    const focused = reset ? null : document.activeElement;
    // a text field keeps what is being typed into it; otherwise it shows the card
    if (!(dirty.head && document.activeElement === title)) title.value = card.text ?? '';
    if (!(dirty.desc && document.activeElement === desc)) desc.value = card.desc ?? '';
    // the owner picker: me, who is here and who is already named on this board (docs/kanban.md, Owners)
    const present = app.participants().map((p) => ({ id: p.user.id, name: p.user.name }));
    const assigned = [...app.store.cache.values()].filter((o) => o.type === 'card') as BaseObj[];
    options = ownerOptions({ id: app.user.id, name: app.user.name }, present, assigned);
    if (focused !== owner && !(focused === ownerName && !ownerName.hidden)) {
      const cur = ownerKey(card);
      if (cur && !options.some((o) => o.key === cur)) options.push({ key: cur, id: card.ownerId, name: card.ownerName || 'Someone' });
      owner.replaceChildren(
        h('option', { value: '' }, 'No owner'),
        ...options.map((o) => h('option', { value: o.key }, o.me ? `${o.name} (you)` : o.name)),
        ...(editable ? [h('option', { value: OTHER }, 'Someone else…')] : []),
      );
      owner.value = cur;
      ownerName.hidden = true;
    }
    if (focused !== due) due.value = isDueDate(card.due) ? card.due : '';
    clearDue.hidden = !card.due;
    const active = document.activeElement;
    const focusedLabel = active && labels.contains(active) ? (active as HTMLElement).dataset.label : undefined;
    const known = knownLabels(app.store);
    const on = new Set(card.labels ?? []);
    const all = listLabels(app.store);
    labels.replaceChildren(...(all.length ? all.map((l) => {
      // the swatch of a palette key, never a stored string (kanbanSwatch goes through kanbanColor)
      const sw = h('span', { class: 'k-chip-swatch', 'aria-hidden': 'true' });
      const c = kanbanSwatch(l.color);
      if (c) sw.style.setProperty('--c', c);
      const b = h('button', {
        class: `k-chip${on.has(l.id) ? ' on' : ''}`, type: 'button', 'data-label': l.id, 'aria-pressed': String(on.has(l.id)), disabled: !editable,
        onclick: () => {
          const next = toggleCardLabel(cardOf()?.labels, l.id, known);
          if (next === null) return app.notify(`A card holds at most ${LIMITS.labelsPerCard} labels.`);
          save({ labels: next });
        },
      },
      // chosen is said by more than the colours: a check before the name, and aria-pressed
      on.has(l.id) ? h('span', { class: 'k-chip-check', 'aria-hidden': 'true' }, icon('check', 12)) : null,
      sw, h('span', { class: 'k-chip-name' }, l.name));
      return b;
    }) : [h('p', { class: 'k-empty' }, editable ? 'No labels on this board yet.' : 'No labels.')]));
    // the chips are rebuilt: keep the keyboard on the one that was toggled
    if (focusedLabel) [...labels.querySelectorAll<HTMLElement>('button')].find((b) => b.dataset.label === focusedLabel)?.focus();
  }

  for (const el of [title, desc]) el.readOnly = !editable;
  for (const el of [owner, due]) el.disabled = !editable;

  const lane = card0.parent ? app.store.get(card0.parent) : undefined;
  const heading = lane?.type === 'lane' ? `Card in ${(lane as BaseObj).name || 'a lane'}` : 'Card';
  render();
  const stopStore = app.store.onChange((changed) => {
    if (!changed.has(id)) return;
    const card = cardOf();
    // deleted, or turned into a sticky by someone: the dialog has nothing left to show
    if (!card || card.type !== 'card') return d.close();
    render();
  });
  const onLabels = () => render();
  // a role that changes while it is open (an editor made a commenter, or the other way): open again as the new role
  // allows, or close and say why
  const roleChanged = () => {
    d.close();
    // after the event that told us, so the new dialog does not hear it too
    if (cardOf()?.type === 'card' && app.canOpenCard()) queueMicrotask(() => openCardDialog(app, id));
    else app.notify('Your access to this board changed, so the card was closed.');
  };
  const stopRole = app.on('readonly', roleChanged);
  const stopComments = app.comments.onReadOnly(roleChanged);
  app.store.labels.observe(onLabels);
  const d = dialog(heading, body, [], {
    className: 'k-card-dialog',
    onClose: () => {
      stopStore();
      stopRole();
      stopComments();
      app.store.labels.unobserve(onLabels);
      // what this person typed into a field that still has focus is kept, as leaving it would; nothing else is written
      if (editable && cardOf()?.type === 'card') {
        if (title.value.trim()) saveTitle();
        saveDesc();
      }
    },
  });
  keepKeys(d.box);
  const start = { title, owner, due, labels } as const;
  if (focus && focus !== 'title') {
    requestAnimationFrame(() => {
      const el = focus === 'labels' ? (labels.querySelector('button') as HTMLElement | null) ?? manage : start[focus];
      el?.focus();
    });
  }
  return d;
}

function field(label: string, control: HTMLElement) {
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), control);
}
