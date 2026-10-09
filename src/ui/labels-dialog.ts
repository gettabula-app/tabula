import './card-dialog.css';
import type { BoardApp } from '../app';
import type { Label } from '../types';
import { LABEL_COLORS, LIMITS } from '../../shared/containers';
import { createLabel, createRefusal, deleteLabel, listLabels, moveLabel, nextLabelColor, recolorLabel, renameLabel } from '../labels';
import { kanbanSwatch } from '../markup';
import { dialog } from './common';
import { h, icon } from './dom';

// The Labels dialog (docs/kanban.md, Labels): create, rename, recolour, reorder and delete the board's labels. Editors
// only. Eight palette colours, each with its name, so colour is never the only signal. Names reach the page as input
// values and text, colours only as palette keys turned into swatches (kanbanSwatch), never as stored strings.

const colourName = (key: string) => key[0].toUpperCase() + key.slice(1);

/** A radio group of the eight palette colours. */
function colourPicker(current: string, label: string, onPick: (key: string) => void, disabled = false): HTMLElement {
  const row = h('div', { class: 'k-swatches', role: 'radiogroup', 'aria-label': label });
  for (const key of LABEL_COLORS) {
    const b = h('button', {
      class: 'k-swatch', type: 'button', role: 'radio', 'aria-checked': String(key === current), 'aria-label': colourName(key), 'data-tip': colourName(key), disabled,
      onclick: () => {
        for (const x of row.children) x.setAttribute('aria-checked', String(x === b));
        onPick(key);
      },
    });
    const c = kanbanSwatch(key);
    if (c) b.style.setProperty('--c', c);
    row.appendChild(b);
  }
  return row;
}

export function openLabelsDialog(app: BoardApp) {
  if (app.readOnly) return null;
  const list = h('ul', { class: 'k-label-list', 'aria-label': 'Labels' });
  const count = h('div', { class: 'k-label-count', 'aria-live': 'polite' });
  const name = h('input', { class: 'input', type: 'text', maxlength: LIMITS.labelName, placeholder: 'New label', 'aria-label': 'New label name', autocomplete: 'off' });
  let newColour = nextLabelColor(listLabels(app.store));
  const add = () => {
    const refused = createRefusal(app.store, name.value);
    if (refused) {
      if (name.value.trim()) app.notify(refused);
      return;
    }
    if (createLabel(app.store, name.value, newColour)) {
      name.value = '';
      newColour = nextLabelColor(listLabels(app.store));
      pickerSlot.replaceChildren(colourPicker(newColour, 'New label colour', (k) => (newColour = k)));
      name.focus();
    }
  };
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      add();
    }
  });
  const pickerSlot = h('div', { class: 'field' }, colourPicker(newColour, 'New label colour', (k) => (newColour = k)));
  const adder = h('div', null,
    h('div', { class: 'k-label-add' }, name, h('button', { class: 'btn', type: 'button', onclick: add }, icon('plus', 16), 'Add')),
    pickerSlot,
  );

  function row(l: Label, i: number, n: number): HTMLElement {
    const input = h('input', { class: 'input', type: 'text', maxlength: LIMITS.labelName, 'aria-label': `Name of ${l.name}`, 'data-label': l.id, autocomplete: 'off' });
    input.value = l.name;
    input.addEventListener('change', () => {
      if (!renameLabel(app.store, l.id, input.value)) input.value = l.name;
    });
    const tool = (name: Parameters<typeof icon>[0], label: string, onClick: () => void, disabled = false, cls = '') =>
      h('button', { class: `icon-btn${cls}`, type: 'button', 'aria-label': label, 'data-tip': label, disabled, 'data-tool': `${l.id}:${name}`, onclick: onClick }, icon(name, 18));
    return h('li', { class: 'k-label-row' },
      input,
      h('div', { class: 'k-label-tools' },
        tool('chevron', `Move ${l.name} up`, () => moveLabel(app.store, l.id, -1), i === 0, ' k-up'),
        tool('chevron', `Move ${l.name} down`, () => moveLabel(app.store, l.id, 1), i === n - 1, ' k-down'),
        tool('trash', `Delete ${l.name}`, () => {
          deleteLabel(app.store, l.id);
          app.notify(`Deleted the label ${l.name}. Undo brings it back.`);
        }, false, ' danger'),
      ),
      colourPicker(l.color, `Colour of ${l.name}`, (k) => recolorLabel(app.store, l.id, k)),
    );
  }

  function render() {
    const active = document.activeElement as HTMLElement | null;
    const keep = active && list.contains(active) ? active.dataset.label ?? active.dataset.tool : undefined;
    const labels = listLabels(app.store);
    list.replaceChildren(...labels.map((l, i) => row(l, i, labels.length)));
    if (!labels.length) list.replaceChildren(h('li', { class: 'k-label-row' }, h('span', { class: 'k-empty' }, 'No labels yet. Cards can carry up to ten.')));
    count.textContent = `${labels.length} of ${LIMITS.labels} labels`;
    name.disabled = labels.length >= LIMITS.labels;
    if (keep) [...list.querySelectorAll<HTMLElement>('input, button')].find((el) => el.dataset.label === keep || el.dataset.tool === keep)?.focus();
  }
  render();
  const onLabels = () => render();
  app.store.labels.observe(onLabels);
  const body = h('div', null, list, count, adder);
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' && e.key !== 'Escape') e.stopPropagation();
  });
  return dialog('Labels', body, [], { className: 'k-labels-dialog', onClose: () => app.store.labels.unobserve(onLabels) });
}
