import './controls.css';
import { h, icon } from './dom';
import { WheelSteps, clampValue, parseTyped, stepValue, type StepOptions } from '../style-edit';
import { safeInsets } from './safe-area';

/** A step burst (wheel or held arrow keys) ends after this much quiet, and commits as one change. */
const GESTURE_IDLE_MS = 600;

let uid = 0;
/** The one list that is open, so a panel that rebuilds can close it first. */
let openList: { close: (keep: number | null) => void } | null = null;

/** Closes an open combobox list, putting back what it previewed. */
export function closeOpenCombo() {
  openList?.close(null);
}
const nextId = (prefix: string) => `${prefix}-${++uid}`;

export interface NumberFieldOptions extends StepOptions {
  label: string;
  /** The current value; null when the selected objects differ. */
  value: number | null;
  /** Shown after the number, as in "80%". */
  unit?: string;
  /** Show the value live; not recorded. */
  onPreview: (v: number) => void;
  /** Record the value as one change. */
  onCommit: (v: number) => void;
  /** Drop the preview. */
  onRevert: () => void;
}

/**
 * A number field that steps: the mouse wheel or a trackpad over it, the arrow keys, or typing. Shift steps ten
 * times as far. Each step shows on the board at once; a burst of steps is recorded as one change when it ends.
 */
export function numberField(o: NumberFieldOptions): HTMLInputElement {
  const input = h('input', {
    class: 'input num-field', type: 'text', inputmode: 'decimal', role: 'spinbutton', 'aria-label': o.label,
    'aria-valuemin': String(o.min), 'aria-valuemax': String(o.max), autocomplete: 'off', spellcheck: 'false',
  });
  let value = o.value;
  let pending = false; // a previewed value waits to be committed
  let timer = 0;
  const wheel = new WheelSteps();
  const show = () => {
    input.value = value === null ? '' : `${value}${o.unit ?? ''}`;
    input.placeholder = value === null ? 'Mixed' : '';
    if (value === null) input.removeAttribute('aria-valuenow');
    else input.setAttribute('aria-valuenow', String(value));
    input.setAttribute('aria-valuetext', value === null ? 'Mixed' : `${value}${o.unit ?? ''}`);
  };
  const commit = () => {
    clearTimeout(timer);
    if (!pending || value === null) return;
    pending = false;
    o.onCommit(value);
  };
  const stepBy = (steps: number, shift: boolean) => {
    if (!steps) return;
    let v = value ?? clampValue(o.min, o);
    for (let i = 0; i < Math.abs(steps); i++) v = stepValue(v, Math.sign(steps), o, shift);
    if (v === value) return;
    value = v;
    pending = true;
    show();
    o.onPreview(v);
    clearTimeout(timer);
    timer = window.setTimeout(commit, GESTURE_IDLE_MS);
  };
  input.addEventListener('wheel', (e) => {
    e.preventDefault();
    stepBy(wheel.add(e.deltaY, e.deltaMode), e.shiftKey);
  }, { passive: false });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // never a board shortcut
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      stepBy(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      stepBy(e.key === 'PageUp' ? 1 : -1, true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      typed();
      input.select();
    } else if (e.key === 'Escape') {
      clearTimeout(timer);
      if (pending) {
        pending = false;
        o.onRevert();
      }
      value = o.value;
      show();
      input.blur();
    }
  });
  const typed = () => {
    const n = parseTyped(input.value);
    if (n === null) {
      show();
      return;
    }
    const next = clampValue(n, o);
    // Enter commits from keydown, and the browser then fires `change` for the same text (Chromium does): the second one is
    // not a new value and must not write again, or it leaves an empty step above the real one in the undo history
    if (next === value && !pending) {
      show();
      return;
    }
    value = next;
    pending = true;
    show();
    commit();
  };
  input.addEventListener('change', typed);
  input.addEventListener('blur', () => {
    wheel.reset();
    commit();
  });
  input.addEventListener('focus', () => input.select());
  show();
  return input;
}

export interface ComboOption<T> {
  value: T;
  label: string;
  /** Group heading this option sits under. */
  group?: string;
  /** Inline style for the option's label, e.g. a font family so each font shows in its own face. */
  style?: string;
  icon?: HTMLElement;
}

export interface ComboOptions<T> {
  label: string;
  options: ComboOption<T>[];
  /** The current value; null when the selected objects differ. */
  value: T | null;
  /** Style for the closed button's text (the current font, for the font list). */
  style?: string;
  onPreview: (v: T) => void;
  onCommit: (v: T) => void;
  onRevert: () => void;
}

/**
 * A select made of a button (combobox) and a listbox. Moving over an option with the mouse, or to it with the arrow
 * keys, previews it on the board; leaving the list or Escape puts it back; a click or Enter keeps it. On touch there
 * is no hover, so a tap keeps the option at once.
 */
export function combo<T>(o: ComboOptions<T>): HTMLButtonElement {
  const listId = nextId('combo-list');
  const current = o.options.find((x) => o.value !== null && x.value === o.value);
  const cloneOptionIcon = (source?: HTMLElement) => {
    if (!source) return null;
    const copy = source.cloneNode(true) as HTMLElement;
    copy.classList.add('combo-option-icon');
    return copy;
  };
  const button = h('button', {
    class: 'input combo', type: 'button', role: 'combobox', 'aria-label': o.label, 'aria-haspopup': 'listbox',
    'aria-expanded': 'false', 'aria-controls': listId,
  }, cloneOptionIcon(current?.icon), h('span', { class: 'combo-value', style: current?.style ?? o.style }, current?.label ?? 'Mixed'), icon('chevron', 16));

  let list: HTMLElement | null = null;
  let active = -1;
  let previewed = -1;
  let rows: HTMLElement[] = [];
  let lastPointer: string = 'mouse';

  const indexOfValue = () => o.options.findIndex((x) => o.value !== null && x.value === o.value);

  const setActive = (i: number, preview: boolean) => {
    active = i;
    rows.forEach((r, j) => r.classList.toggle('active', j === i));
    if (i < 0) {
      button.removeAttribute('aria-activedescendant');
      return;
    }
    button.setAttribute('aria-activedescendant', rows[i].id);
    rows[i].scrollIntoView({ block: 'nearest' });
    if (preview && i !== previewed) {
      previewed = i;
      o.onPreview(o.options[i].value);
    }
  };

  const revertPreview = () => {
    if (previewed < 0) return;
    previewed = -1;
    o.onRevert();
  };

  const close = (keep: number | null) => {
    if (!list) return;
    list.remove();
    list = null;
    if (openList?.close === close) openList = null;
    window.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onOutside, true);
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-activedescendant');
    if (keep !== null) {
      previewed = -1;
      o.onCommit(o.options[keep].value);
    } else revertPreview();
  };

  const onOutside = (e: Event) => {
    if (e.type === 'resize' || (list && !list.contains(e.target as Node) && !button.contains(e.target as Node))) close(null);
  };

  const place = () => {
    if (!list) return;
    const a = button.getBoundingClientRect();
    const r = list.getBoundingClientRect();
    const safe = safeInsets();
    const left = 8 + safe.left;
    const right = 8 + safe.right;
    const top = 8 + safe.top;
    const bottom = window.innerHeight - 8 - safe.bottom;
    const below = a.bottom + 4 + r.height <= bottom || a.top - 4 - r.height < top;
    list.style.minWidth = `${a.width}px`;
    list.style.left = `${Math.max(left, Math.min(window.innerWidth - r.width - right, a.left))}px`;
    const y = below ? a.bottom + 4 : a.top - 4 - r.height;
    list.style.top = `${Math.max(top, Math.min(bottom - r.height, y))}px`;
  };

  const open = () => {
    if (list) return;
    rows = [];
    const children: HTMLElement[] = [];
    let group: string | undefined;
    o.options.forEach((opt, i) => {
      if (opt.group && opt.group !== group) {
        group = opt.group;
        children.push(h('li', { class: 'combo-group', role: 'presentation' }, opt.group));
      }
      const row = h('li', {
        id: `${listId}-${i}`, class: 'combo-opt', role: 'option', 'aria-selected': String(opt.value === o.value),
      }, cloneOptionIcon(opt.icon), h('span', { style: opt.style }, opt.label));
      row.addEventListener('pointerenter', (e) => {
        lastPointer = e.pointerType;
        if (e.pointerType !== 'touch') setActive(i, true);
      });
      row.addEventListener('pointerdown', (e) => {
        lastPointer = e.pointerType;
        e.preventDefault(); // keep focus on the button
      });
      row.addEventListener('click', () => close(i));
      rows.push(row);
      children.push(row);
    });
    list = h('ul', { id: listId, class: 'combo-list', role: 'listbox', 'aria-label': o.label }, ...children);
    list.addEventListener('pointerdown', (e) => e.preventDefault()); // the scrollbar too keeps focus on the button
    list.addEventListener('pointerleave', () => {
      if (lastPointer === 'touch') return;
      setActive(-1, false);
      revertPreview();
    });
    closeOpenCombo();
    document.body.appendChild(list);
    openList = { close };
    button.setAttribute('aria-expanded', 'true');
    place();
    setActive(indexOfValue(), false);
    setTimeout(() => window.addEventListener('pointerdown', onOutside, true));
    window.addEventListener('resize', onOutside, true);
  };

  button.addEventListener('pointerdown', (e) => (lastPointer = e.pointerType));
  button.addEventListener('click', () => (list ? close(null) : open()));
  button.addEventListener('keydown', (e) => {
    e.stopPropagation(); // never a board shortcut
    const last = o.options.length - 1;
    if (!list) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        open();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setActive(Math.max(0, Math.min(last, (active < 0 ? 0 : active) + (e.key === 'ArrowDown' ? 1 : -1))), true);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End' || e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const by = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 8 : e.key === 'PageUp' ? -8 : 0;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? last : Math.max(0, Math.min(last, (active < 0 ? indexOfValue() : active) + by));
      setActive(next, true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      close(active >= 0 ? active : null);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(null);
    } else if (e.key === 'Tab') {
      close(null);
    } else if (e.key.length === 1) {
      // type-ahead: the next option starting with the letter
      const k = e.key.toLowerCase();
      const from = active < 0 ? 0 : active + 1;
      const order = [...o.options.keys()].map((j) => (j + from) % o.options.length);
      const hit = order.find((j) => o.options[j].label.toLowerCase().startsWith(k));
      if (hit !== undefined) setActive(hit, true);
    }
  });
  button.addEventListener('blur', () => close(null));
  return button;
}
